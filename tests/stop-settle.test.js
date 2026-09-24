// mcp-web — P1 critic R2: `stop` BOHONG di jendela SETTLE engine `--js`.
// Bukti lama: setelah fetch selesai, navigate masih jalan fase settle
// (script/module/waitMs) tanpa syarat → stop melapor {stopped:true} tapi
// navigate tetap SELESAI SUKSES (sukses palsu).
// Fix: engine-js menandai _inflight.phase + checkpoint checkStop() → stop di
// fase settle MEMASTIKAN navigate melempar "dibatalkan oleh stop".
//
// Test DETERMINISTIK (bukan tebakan timing): gate server menahan response
// sampai test melepas → fase kebetulan dijamin lewat polling `hit`.
// + kontrol: fase fetch tetap "dibatalkan oleh stop", tanpa inflight tetap
// "tidak ada inflight", timeout asli tetap "Timeout setelah Xms".
// + e2e stdio --js (transport NYATA, pola probe critic).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import readline from "node:readline"
import { createTools } from "../src/tools.js"

// Fixture test ada di 127.0.0.1 → izinkan target private (anak proses mewarisi env).
process.env.MCWEB_ALLOW_PRIVATE = "1"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bin = path.join(root, "bin", "mcp-web.js")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ===================== gate fixture server (deterministik) =====================
// pathname di-gate → request dicatat (hit) lalu response DITAHAN sampai release.
const gates = new Map() // pathname -> { hit, park, release }

function installGate(pathname) {
  let release
  const park = new Promise((r) => { release = r })
  const g = { hit: false, park, release }
  gates.set(pathname, g)
  return g
}

async function untilHit(g, ms = 20000) {
  const t0 = Date.now()
  while (!g.hit) {
    if (Date.now() - t0 > ms) throw new Error("gate tidak tercapai — fase navigate tak pernah sampai (timeout)")
    await sleep(10)
  }
}

let srv
let base
let tools
let navigate
let stop

const HOME = `<!doctype html><html><head><title>Gate Home</title></head><body><p>gate home</p></body></html>`
const SETTLE_PAGE = `<!doctype html><html><head><title>Settle</title><script src="/gated-script.js"></script></head><body><p>settle page</p></body></html>`

before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost")
    const gate = gates.get(u.pathname)
    if (gate) {
      gate.hit = true
      gate.park.then(() => {
        if (res.destroyed || res.writableEnded) return
        try {
          const isJs = u.pathname.endsWith(".js")
          res.writeHead(200, { "Content-Type": isJs ? "application/javascript" : "text/html" })
          res.end(isJs ? "window.__gatedScript = 1;" : SETTLE_PAGE)
        } catch { /* socket sudah ditutup klien (di-abort) — abaikan */ }
      })
      return
    }
    if (u.pathname === "/settle-page") {
      // Halaman CEPAT + script klasik yang di-gate → jendela settle hidup.
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(SETTLE_PAGE)
      return
    }
    if (u.pathname === "/slow") {
      // Halaman LAMBAT tanpa gate (ms=...) — utk test timeout.
      const delay = Math.min(Math.max(Number(u.searchParams.get("ms") || 1500), 1), 10000)
      const t = setTimeout(() => {
        if (res.destroyed || res.writableEnded) return
        try { res.writeHead(200, { "Content-Type": "text/html" }); res.end(HOME) } catch {}
      }, delay)
      if (typeof t.unref === "function") t.unref()
      return
    }
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(HOME)
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${srv.address().port}`
  tools = await createTools({ engine: "js" })
  navigate = tools.find((t) => t.name === "navigate")
  stop = tools.find((t) => t.name === "stop")
})

after(async () => {
  for (const g of gates.values()) g.release() // jangan gantung handler gate
  srv.closeAllConnections?.()
  await new Promise((r) => srv.close(r))
})

const startNav = (args) =>
  navigate.handler(args).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

// ===================== P1 inti: stop di fase SETTLE =====================

test("P1: engine js — stop di fase settle → navigate MELEMPAR 'dibatalkan oleh stop' (bukan sukses palsu)", async () => {
  // /settled-page cepat; script klasiknya di-GATE → navigate masuk fase settle
  // (body utuh terbaca) lalu menggantung di fetch script = jendela settle hidup.
  const gate = installGate("/gated-script.js")
  const navOutcome = startNav({ url: `${base}/settle-page` })
  await untilHit(gate) // fetch HTML selesai + script mulai di-fetch ⇒ fase settle
  const st = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(st.stopped, true, `stop fase settle wajib {stopped:true}, dapat: ${JSON.stringify(st)}`)
  assert.equal(st.phase, "settle", `stop harus melapor fase 'settle', dapat: ${JSON.stringify(st)}`)
  assert.ok(st.inflight && st.inflight.phase === "settle", "inflight harus membawa phase settle")
  // note WAJIB mencerminkan perilaku hasil fix — dan perilaku itu diuji bawah.
  assert.match(st.note, /settle/)
  assert.match(st.note, /dibatalkan oleh stop/)
  assert.match(st.note, /TIDAK diselesaikan sukses/)
  gate.release() // lepas script → navigate lanjut ke checkpoint → wajib melempar
  const out = await navOutcome
  assert.equal(out.ok, false, "navigate fase settle yang di-stop TIDAK BOLEH selesai sukses (sukses palsu)")
  assert.match(out.e.message, /dibatalkan oleh stop/)
  assert.ok(!/Timeout setelah/.test(out.e.message), "bukan pesan timeout — ini diminta stop")
})

// ===================== kontrol: jalur lama tetap utuh =====================

test("kontrol: engine js — stop fase FETCH tetap 'dibatalkan oleh stop'", async () => {
  const gate = installGate("/gated-page") // HTML ditahan total ⇒ fetch berjalan
  const navOutcome = startNav({ url: `${base}/gated-page` })
  await untilHit(gate)
  const st = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(st.stopped, true, `stop fase fetch wajib {stopped:true}, dapat: ${JSON.stringify(st)}`)
  assert.equal(st.phase, "fetch", `phase wajib 'fetch', dapat: ${JSON.stringify(st)}`)
  assert.match(st.note, /fetch inflight dibatalkan/)
  gate.release()
  const out = await navOutcome
  assert.equal(out.ok, false, "navigate fase fetch yang di-stop wajib gagal")
  assert.match(out.e.message, /dibatalkan oleh stop/)
})

test("kontrol: stop tanpa inflight → {stopped:false, 'tidak ada inflight'} (tetap jujur)", async () => {
  // Aman tanpa navigate jalan: test sebelumnya sudah selesai semua (finally
  // membersihkan _inflight) — kalau ada sisa, stopped:true akan gagalkan test ini.
  const p = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(p.stopped, false)
  assert.equal(p.note, "tidak ada inflight")
})

test("kontrol: timeout asli tetap 'Timeout setelah Xms' (bukan 'dibatalkan oleh stop')", async () => {
  await assert.rejects(
    navigate.handler({ url: `${base}/slow?ms=3000`, timeoutMs: 150 }),
    /Timeout setelah 150ms/,
  )
})

// ===================== e2e: transport stdio --js NYATA (pola probe critic) =====================

test("P1 e2e stdio --js: stop di fase settle → navigate dijawab error 'dibatalkan oleh stop'", async () => {
  const gate = installGate("/gated-script.js")
  const child = spawn("node", [bin, "stdio", "--js"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MCWEB_ALLOW_PRIVATE: "1" },
  })
  const rl = readline.createInterface({ input: child.stdout })
  const got = new Map()
  const waiters = new Map()
  rl.on("line", (l) => {
    let m
    try { m = JSON.parse(l) } catch { return }
    got.set(m.id, m)
    if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) }
  })
  // Boot engine --js (jsdom) bisa >30s saat suite paralel penuh (load tinggi)
  // → beri ruang 90s; normalnya ±15s.
  const wait = (id, ms = 90000) => new Promise((res, rej) => {
    if (got.has(id)) return res(got.get(id))
    waiters.set(id, res)
    setTimeout(() => rej(new Error(`timeout tunggu id ${id}`)), ms)
  })
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n")
    await wait(1) // sinkron: child boot & siap proses line
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "navigate", arguments: { url: `${base}/settle-page`, timeoutMs: 60000 } },
    }) + "\n")
    await untilHit(gate, 60000) // fase settle TEREKSPOS (bukan tebakan offset ms)
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "stop", arguments: {} } }) + "\n")
    const stopM = await wait(11)
    const sp = JSON.parse(stopM.result.content[0].text)
    assert.equal(sp.stopped, true, `stop fase settle wajib {stopped:true}, dapat: ${JSON.stringify(sp)}`)
    assert.equal(sp.phase, "settle", `phase wajib 'settle', dapat: ${JSON.stringify(sp)}`)
    gate.release()
    const navM = await wait(10)
    assert.ok(navM.error, "navigate wajib ERROR (dulu: sukses palsu walau stop {stopped:true})")
    assert.match(navM.error.message, /dibatalkan oleh stop/)
    assert.ok(!/Timeout setelah/.test(navM.error.message), "bukan pesan timeout")
  } finally {
    child.kill()
    for (const g of gates.values()) g.release()
  }
})
