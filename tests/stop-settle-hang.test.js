// mcp-web — P1 critic R3: `stop` & `timeoutMs` TIDAK membatalkan I/O FASE
// SETTLE saat subresource menggantung.
// Bukti probe critic (settle-run2.log skenario D): script settle yang TAK
// PERNAH merespons → stop balas {stopped:true, phase:settle} tapi navigate
// masih menggantung 5 detik sesudah stop (timeoutMs 1500 sudah lewat 3,5s!) —
// baru melempar setelah gate dibuka manual. Akar: fetch script (engine-js.js
// _trackedFetch) & mirror module (this._fetch) TANPA `signal` = abort-kebal;
// catch di sekitar eval script menelan AbortError jadi "classic script gagal".
//
// Fix diuji di sini: signal controller navigate DIWARISKAN ke semua fetch
// fase settle + AbortError di-rethrow + import() module di-race.
//
// Test DETERMINISTIK — TANPA timing tebakan:
//  * unit engine: fetch di-STUB ber-promise-pending sampai release()/abort;
//    "gate" = stub itu sendiri (tak ada server, tak ada tidur acak).
//  * transport nyata (HTTP): gate fixture tak pernah dilepas selama assertion
//    → tanpa fix navigate menggantung → watchdog 2s yang menagih.
// Assertion kunci mutasi-detektor: fetch fase settle WAJIB menerima
// `init.signal` (tanpa fix: signal tak ada → tak bisa diabort → watchdog gagal).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { createJsPage } from "../src/engine-js.js"
import { createTools } from "../src/tools.js"

// Fixture test ada di 127.0.0.1 → izinkan target private.
process.env.MCWEB_ALLOW_PRIVATE = "1"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ===================== util deterministik =====================
const outcome = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

// Race terhadap watchdog: tanpa fix, navigate menggantung tanpa batas →
// watchdog yang menagih (bukan tidur lalu berharap).
async function raced(p, ms) {
  let t
  const wd = new Promise((r) => { t = setTimeout(() => r({ watchdog: true }), ms) })
  const out = await Promise.race([p, wd])
  clearTimeout(t)
  return out
}

async function until(cond, ms, msg) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(msg)
    await sleep(5)
  }
}

// ===================== unit engine: stub fetch yang digate =====================
// `gate` = promise pending sampai release(). Stub MENERIMA signal caller →
// kalau signal di-abort, reject AbortError (inilah perilaku yang dibuktikan
// fix). Tanpa signal → tak bisa dibatalkan = reproduksi P1.
function makeStub({ html, gate, js = "window.__hang = 1;" }) {
  const calls = []
  let release
  const released = new Promise((r) => { release = r })
  let releasedFlag = false

  const fetchStub = (input, init = {}) => {
    const url = String(input)
    const signal = (init && init.signal) || null
    calls.push({ url, signal })
    if (!url.endsWith(gate)) {
      return Promise.resolve(new Response(html, { status: 200, headers: { "content-type": "text/html" } }))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      released.then(() => {
        if (settled) return
        settled = true
        resolve(new Response(js, { status: 200, headers: { "content-type": "application/javascript" } }))
      })
      if (!signal) return // TANPA signal: gantung selamanya walau gate dilepas-manual-style
      const onAbort = () => {
        if (settled) return
        settled = true
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  return {
    fetch: fetchStub,
    calls,
    gateCalls: () => calls.filter((c) => c.url.endsWith(gate)),
    release: () => { releasedFlag = true; release() },
    get released() { return releasedFlag },
  }
}

const DOC_CLASSIC = "https://site.test/dir/page.html"
const DOC_MODULE = "https://site.test/dir/mod.html"
const HTML_CLASSIC = `<!doctype html><html><head><title>Settle Hang</title><script src="/hang.js"></script></head><body><p>settle hang</p></body></html>`
const HTML_MODULE = `<!doctype html><html><head><title>Settle Mod</title><script type="module" src="/mod.js"></script></head><body><p>settle module</p></body></html>`

// JsPage per test menulis cache module ke dir sementara (pola engine-js.test.js).
const cacheDirs = []
function freshPage(waitMs = 50) {
  const dir = path.join(os.tmpdir(), `mcpweb-p1-hang-${process.pid}-${cacheDirs.length + 1}`)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* belum ada */ }
  cacheDirs.push(dir)
  return createJsPage({ cacheDir: dir, waitMs })
}

after(() => {
  for (const d of cacheDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ } }
})

// ===================== P1-a: stop di fase settle, script tak pernah merespons =====================

test("P1-a: unit engine — stop saat fetch script settle GANTUNG → navigate melempar 'dibatalkan oleh stop' <2s tanpa gate dibuka", async () => {
  const page = freshPage()
  const stub = makeStub({ html: HTML_CLASSIC, gate: "/hang.js" })
  page._fetch = stub.fetch
  const out = outcome(page.navigate(DOC_CLASSIC, { timeoutMs: 30000, waitMs: 50 }))
  try {
    await until(() => stub.gateCalls().length > 0, 3000, "fetch script settle tak pernah dipanggil (stub rusak)")
    assert.equal(page._inflight?.phase, "settle", "fetch script = fase settle")
    // Mutasi-detektor: tanpa fix, fetch script dipanggil TANPA signal.
    assert.ok(stub.gateCalls()[0].signal, "P1: fetch script settle TIDAK menerima signal → abort-kebal")
    // stop = pola persis src/tools.js (tandai flag dulu, lalu abort).
    page._abort.__mcpStoppedByStop = true
    page._abort.abort()
    const t0 = Date.now()
    const r = await raced(out, 2000)
    assert.ok(!r.watchdog, `navigate MASIH MENGANTUNG ≥2s setelah stop — I/O settle tak dibatalkan`)
    const ms = Date.now() - t0
    assert.ok(ms < 2000, `respons ${ms}ms — wajib < 2000ms tanpa menunggu gate`)
    assert.equal(r.ok, false, "navigate fase settle yang di-stop TIDAK BOLEH sukses")
    assert.match(r.e.message, /dibatalkan oleh stop/)
    assert.ok(!/Timeout setelah/.test(r.e.message), "bukan pesan timeout — ini diminta stop")
    assert.equal(stub.released, false, "gate TIDAK pernah dilepas saat assertion = bukti tak menunggu gate")
  } finally {
    stub.release() // bersih2 saja — assertion sudah selesai
  }
})

// ===================== P1-b: timeoutMs berlaku penuh di fase settle =====================

test("P1-b: unit engine — tanpa stop, timeoutMs kecil saat fetch script settle GANTUNG → 'Timeout setelah Xms' tanpa mengantung", async () => {
  const page = freshPage()
  const stub = makeStub({ html: HTML_CLASSIC, gate: "/hang.js" })
  page._fetch = stub.fetch
  const out = outcome(page.navigate(DOC_CLASSIC, { timeoutMs: 500, waitMs: 50 }))
  try {
    await until(() => stub.gateCalls().length > 0, 3000, "fetch script settle tak pernah dipanggil (stub rusak)")
    assert.ok(stub.gateCalls()[0].signal, "P1: fetch script settle TIDAK menerima signal → timeoutMs abort-kebal")
    const t0 = Date.now()
    const r = await raced(out, 2500)
    assert.ok(!r.watchdog, "navigate MASIH MENGANTUNG ≥2,5s — timeoutMs tidak berlaku di fase settle")
    const ms = Date.now() - t0
    assert.ok(ms < 2500, `respons ${ms}ms — wajib < 2500ms`)
    assert.equal(r.ok, false, "fetch menggantung sampai timeout → navigate wajib ERROR, bukan sukses")
    assert.match(r.e.message, /Timeout setelah 500ms/)
    assert.ok(!/dibatalkan oleh stop/.test(r.e.message), "tanpa stop → jangan menyalahkan stop")
    assert.equal(stub.released, false, "gate TIDAK pernah dilepas saat assertion")
  } finally {
    stub.release()
  }
})

// ===================== kontrol: jalur normal tetap utuh =====================

test("P1-c: kontrol — gate DILEPAS normal → navigate SUKSES (bukan batal, bukan timeout)", async () => {
  const page = freshPage()
  const stub = makeStub({ html: HTML_CLASSIC, gate: "/hang.js" })
  page._fetch = stub.fetch
  const out = outcome(page.navigate(DOC_CLASSIC, { timeoutMs: 10000, waitMs: 50 }))
  await until(() => stub.gateCalls().length > 0, 3000, "fetch script settle tak pernah dipanggil (stub rusak)")
  stub.release()
  const r = await raced(out, 5000)
  assert.ok(!r.watchdog, "navigate menggantung walau gate sudah dilepas")
  assert.equal(r.ok, true, r.ok ? "" : `navigate seharusnya SUKSES, dapat error: ${r.e.message}`)
  assert.equal(r.v.status, 200)
  assert.equal(r.v.title, "Settle Hang")
  assert.equal(page.window.eval("window.__hang"), 1, "script settle dieksekusi saat gate dilepas normal")
})

// ===================== P1-d: mirror module (this._fetch) tanpa signal =====================

test("P1-d: unit engine — mirror module GANTUNG (jalur this._fetch) + stop → 'dibatalkan oleh stop' <2s", async () => {
  const page = freshPage()
  const stub = makeStub({ html: HTML_MODULE, gate: "/mod.js", js: "export const x = 1;" })
  page._fetch = stub.fetch
  const out = outcome(page.navigate(DOC_MODULE, { timeoutMs: 30000, waitMs: 50 }))
  try {
    await until(() => stub.gateCalls().length > 0, 3000, "fetch mirror module tak pernah dipanggil (stub rusak)")
    assert.equal(page._inflight?.phase, "settle", "mirror module = fase settle")
    // Mutasi-detektor: dulu _mirrorModule memanggil this._fetch(url) TANPA init.
    assert.ok(stub.gateCalls()[0].signal, "P1: fetch mirror module TIDAK menerima signal → abort-kebal")
    page._abort.__mcpStoppedByStop = true
    page._abort.abort()
    const t0 = Date.now()
    const r = await raced(out, 2000)
    assert.ok(!r.watchdog, "navigate MASIH MENGANTUNG ≥2s setelah stop — mirror module tak dibatalkan")
    const ms = Date.now() - t0
    assert.ok(ms < 2000, `respons ${ms}ms — wajib < 2000ms tanpa menunggu gate`)
    assert.equal(r.ok, false, "navigate fase settle yang di-stop TIDAK BOLEH sukses")
    assert.match(r.e.message, /dibatalkan oleh stop/)
    assert.ok(!/Timeout setelah/.test(r.e.message), "bukan pesan timeout")
    assert.ok(!/module gagal/.test(r.e.message), "batal jangan berubah jadi 'module gagal'")
    assert.equal(stub.released, false, "gate TIDAK pernah dilepas saat assertion")
  } finally {
    stub.release()
  }
})

// ===================== transport NYATA: replika probe-D critic =====================
// Gate fixture HTTP tak PERNAH dilepas selama assertion (critic membuka gate
// manual setelah 5s — test ini tidak perlu itu).

let srv
let base
let tools
let navigate
let stop
const gates = new Map() // pathname -> {hit, park, release, released}
const pages = new Map() // pathname -> html

function installGate(pathname) {
  let release
  const park = new Promise((r) => { release = r })
  const g = { hit: false, park, released: false, release: () => { g.released = true; release() } }
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

before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost")
    const gate = gates.get(u.pathname)
    if (gate) {
      gate.hit = true
      gate.park.then(() => {
        if (res.destroyed || res.writableEnded) return
        try {
          res.writeHead(200, { "Content-Type": "application/javascript" })
          res.end("window.__gated = 1;")
        } catch { /* socket sudah ditutup klien (di-abort) — abaikan */ }
      })
      return
    }
    const html = pages.get(u.pathname)
    if (html !== undefined) {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(html)
      return
    }
    res.writeHead(404, { "Content-Type": "text/html" })
    res.end("<h1>Not Found</h1>")
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

test("P1-e (replika probe-D): gate HTTP tak pernah dilepas + stop → navigate jawab 'dibatalkan oleh stop' <2s", async () => {
  const gate = installGate("/hang-e.js")
  pages.set("/settle-e", `<!doctype html><html><head><title>Settle E</title><script src="/hang-e.js"></script></head><body><p>e</p></body></html>`)
  const navOut = outcome(navigate.handler({ url: `${base}/settle-e`, timeoutMs: 4000 }))
  await untilHit(gate) // fase settle TEREKSPOS (bukan tebakan offset ms)
  const st = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(st.stopped, true, `stop fase settle wajib {stopped:true}, dapat: ${JSON.stringify(st)}`)
  assert.equal(st.phase, "settle", `phase wajib 'settle', dapat: ${JSON.stringify(st)}`)
  assert.match(st.note, /MEMBATALKAN I\/O/, "note wajib mencerminkan perilaku hasil fix")
  const t0 = Date.now()
  const r = await raced(navOut, 2000)
  assert.ok(!r.watchdog, "MASIH MENGANTUNG ≥2s setelah stop — timeoutMs(4000) pun belum lewat, jadi ini BUKAN timeout yang menolong")
  const ms = Date.now() - t0
  assert.ok(ms < 2000, `respons ${ms}ms setelah stop — wajib < 2000ms tanpa gate dibuka`)
  assert.equal(r.ok, false, "navigate tak boleh sukses")
  assert.match(r.e.message, /dibatalkan oleh stop/)
  assert.ok(!/Timeout setelah/.test(r.e.message), "bukan pesan timeout")
  assert.equal(gate.released, false, "gate TIDAK pernah dilepas — probe critic membuka manual, test ini tidak")
})

test("P1-f: transport HTTP — subresource tak pernah merespons + timeoutMs → 'Timeout setelah Xms', tanpa mengantung", async () => {
  const gate = installGate("/hang-f.js")
  pages.set("/settle-f", `<!doctype html><html><head><title>Settle F</title><script src="/hang-f.js"></script></head><body><p>f</p></body></html>`)
  const t0 = Date.now()
  const r = await raced(outcome(navigate.handler({ url: `${base}/settle-f`, timeoutMs: 1500 })), 4000)
  assert.ok(!r.watchdog, "MASIH MENGANTUNG ≥4s padahal timeoutMs 1500 — timeoutMs tak berlaku di atas fetch menggantung")
  const ms = Date.now() - t0
  assert.ok(ms < 4000, `respons ${ms}ms — wajib < 4000ms`)
  assert.equal(r.ok, false, "fetch menggantung sampai timeout → navigate wajib ERROR")
  assert.match(r.e.message, /Timeout setelah 1500ms/)
  assert.ok(!/dibatalkan oleh stop/.test(r.e.message), "tanpa stop → jangan menyalahkan stop")
  assert.equal(gate.released, false, "gate TIDAK pernah dilepas selama assertion")
})
