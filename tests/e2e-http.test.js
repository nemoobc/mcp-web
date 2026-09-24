// mcp-web — e2e HTTP remote: spawn serve, SSE + POST /message round-trip.
// KEAMANAN: server wajib token → semua request di test ini pakai Authorization.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import http from "node:http"
import { startFixtureServer } from "./helpers.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bin = path.join(root, "bin", "mcp-web.js")

const TOKEN = "test-token-e2e-http-1234"

let fx
let child
let port
let base

function getFreePort() {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

const AUTH = { Authorization: `Bearer ${TOKEN}` }

// Buka SSE — resolve segera setelah header (session id), kumpulkan events asinkron.
// `sessionId` opsional: kirim header MCP-Session-Id (uji reconnect/hijack/400).
function openSse(sessionId) {
  return new Promise((resolve) => {
    const state = { sessionId: null, status: null, events: [], res: null, done: false }
    const headers = { ...AUTH }
    if (sessionId) headers["MCP-Session-Id"] = sessionId
    const req = http.get({ host: "127.0.0.1", port, path: "/sse", headers }, (res) => {
      state.res = res
      state.status = res.statusCode
      state.sessionId = res.headers["mcp-session-id"]
      let buf = ""
      res.on("data", (c) => {
        buf += c
        let idx
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "))
          if (!dataLine) continue
          try {
            state.events.push(JSON.parse(dataLine.slice(6)))
          } catch {}
        }
      })
      res.on("error", () => {})
      resolve(state)
    })
    req.on("error", () => {})
  })
}

// Tunggu sampai events memuat semua id yang diharapkan (atau timeout).
function waitFor(events, ids, ms = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const have = new Set(events.filter((e) => e.id !== undefined).map((e) => e.id))
      if (ids.every((i) => have.has(i)) || Date.now() - t0 > ms) {
        clearInterval(iv)
        resolve()
      }
    }, 50)
  })
}

function postMessage(sessionId, body) {
  return postRaw(`/message?sessionId=${encodeURIComponent(sessionId)}`, JSON.stringify(body), { "Content-Type": "application/json" })
}

function postRaw(pathWithQuery, data, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathWithQuery,
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...extraHeaders },
      },
      (res) => {
        let b = ""
        res.on("data", (c) => (b += c))
        res.on("end", () => resolve({ status: res.statusCode, body: b }))
      }
    )
    req.on("error", reject)
    req.write(data)
    req.end()
  })
}

function getRaw(pathWithQuery, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathWithQuery, headers }, (res) => {
      let b = ""
      res.on("data", (c) => (b += c))
      res.on("end", () => resolve({ status: res.statusCode, body: b }))
    })
    req.on("error", reject)
  })
}

// Poll /health sampai hidup — budget 30000ms (startup bisa lama kalau jsdom ikut termuat).
function waitHealth(ms = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tryOnce = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/health", headers: AUTH }, (res) => {
        let b = ""
        res.on("data", (c) => (b += c))
        res.on("end", () => {
          try {
            resolve(JSON.parse(b))
          } catch {
            reject(new Error(`health response rusak: ${b.slice(0, 80)}`))
          }
        })
      })
      req.on("error", () => {
        if (Date.now() - t0 > ms) return reject(new Error("health timeout"))
        setTimeout(tryOnce, 100)
      })
    }
    tryOnce()
  })
}

before(async () => {
  fx = await startFixtureServer()
  port = await getFreePort()
  base = `http://127.0.0.1:${port}`
  child = spawn("node", [bin, "serve", "--port", String(port)], {
    stdio: "ignore",
    env: { ...process.env, MCWEB_TOKEN: TOKEN, MCWEB_ALLOW_PRIVATE: "1" },
  })
  await waitHealth()
})

after(async () => {
  child.kill()
  await fx.close()
})

test("e2e http: /health hidup", async () => {
  const h = await waitHealth()
  assert.equal(h.ok, true)
})

test("e2e http: TANPA token → 401 (SSE, POST, health semua wajib auth)", async () => {
  const health = await getRaw("/health") // tanpa Authorization
  assert.equal(health.status, 401)
  const sse = await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/sse" }, (res) => {
      res.resume()
      resolve({ status: res.statusCode })
    })
    req.on("error", () => resolve({ status: 0 }))
  })
  assert.equal(sse.status, 401)
  const post = await new Promise((resolve) => {
    const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    const req = http.request(
      { host: "127.0.0.1", port, path: "/message?sessionId=x", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        res.resume()
        resolve({ status: res.statusCode })
      }
    )
    req.on("error", () => resolve({ status: 0 }))
    req.write(data)
    req.end()
  })
  assert.equal(post.status, 401)
})

test("e2e http: body > 1MB → 413", async () => {
  const big = "x".repeat(1024 * 1024 + 1)
  const r = await postRaw("/message?sessionId=s-tidak-ada", big)
  assert.equal(r.status, 413)
})

test("e2e http: SSE + POST initialize + tools/list + navigate", async () => {
  const sse = await openSse()
  assert.equal(sse.status, 200)
  assert.ok(sse.sessionId, "session id dari header SSE")

  const init = await postMessage(sse.sessionId, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  assert.equal(init.status, 202)

  const list = await postMessage(sse.sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list" })
  assert.equal(list.status, 202)

  const nav = await postMessage(sse.sessionId, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "navigate", arguments: { url: `${fx.base}/` } },
  })
  assert.equal(nav.status, 202)

  await waitFor(sse.events, [1, 2, 3])
  const byId = new Map(sse.events.map((m) => [m.id, m]))
  const initRes = byId.get(1)
  assert.equal(initRes.result.serverInfo.name, "mcp-web")
  assert.equal(byId.get(2).result.tools.length >= 14, true)
  const navRes = byId.get(3)
  const p = JSON.parse(navRes.result.content[0].text)
  assert.equal(p.title, "Home")
  sse.res.destroy()
})

test("e2e http: POST pakai session salah → 400 session tidak dikenal", async () => {
  const r = await postMessage("s-tidak-ada", { jsonrpc: "2.0", id: 9, method: "ping" })
  assert.equal(r.status, 400)
})

test("e2e http: GET /sse session TIDAK dikenal → 400 (tak dibuat/dipakai ulang)", async () => {
  const r = await openSse("s-hijacker-tidak-ada")
  assert.equal(r.status, 400)
  r.res?.destroy?.()
})

test("e2e http: GET /sse timpa session dengan stream AKTIF → 409 (anti hijack)", async () => {
  const a = await openSse()
  assert.equal(a.status, 200)
  const b = await openSse(a.sessionId) // stream A masih hidup
  assert.equal(b.status, 409)
  assert.equal(b.sessionId, undefined, "id session tak dibagikan saat 409")
  a.res.destroy()
  b.res?.destroy?.()
  // Beri jarak supaya server sempat memproses 'close' stream A (hindari race).
  await new Promise((r) => setTimeout(r, 200))
  // Setelah stream A mati → reconnect dengan id yang sama SAH (bukan 409 lagi).
  const c = await openSse(a.sessionId)
  assert.equal(c.status, 200)
  assert.equal(c.sessionId, a.sessionId)
  c.res.destroy()
})

// P1-1 (critic): queue per-session MEMATIKAN `stop` — stop antre di belakang
// navigate → selalu {stopped:false}. Fix = jalur prioritas utk nama tool `stop`.
test("e2e http: stop PRIORITAS — selesai sebelum navigate lambat, navigate batal 'dibatalkan oleh stop'", async () => {
  const sse = await openSse()
  assert.equal(sse.status, 200)
  await postMessage(sse.sessionId, { jsonrpc: "2.0", id: 21, method: "initialize", params: {} })

  const SLOW_MS = 3000
  const t0 = Date.now()
  // JANGAN di-await: POST navigate baru dapat 202 SETELAH navigate berakhir
  // (dia menunggu hasil processLine) — cukup lepas, lalu stop di tengah jalan.
  const navPost = postMessage(sse.sessionId, {
    jsonrpc: "2.0", id: 22, method: "tools/call",
    params: { name: "navigate", arguments: { url: `${fx.base}/slow?ms=${SLOW_MS}` } },
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 200)) // navigate sudah inflight
  await postMessage(sse.sessionId, {
    jsonrpc: "2.0", id: 23, method: "tools/call",
    params: { name: "stop", arguments: {} },
  })
  await waitFor(sse.events, [23], 8000)
  const stopMs = Date.now() - t0
  const stopEv = sse.events.find((e) => e.id === 23)
  assert.ok(stopEv?.result, `stop wajib result, dapat: ${JSON.stringify(stopEv)}`)
  const sp = JSON.parse(stopEv.result.content[0].text)
  assert.equal(sp.stopped, true, `stop wajib {stopped:true}, dapat: ${JSON.stringify(sp)}`)
  assert.ok(stopMs < SLOW_MS / 2, `stop harus jauh < ${SLOW_MS}ms (dapat ${stopMs}ms) — queue mematikan stop`)

  await waitFor(sse.events, [22], 8000)
  const navEv = sse.events.find((e) => e.id === 22)
  assert.ok(navEv?.error, "navigate yang di-stop wajib error")
  assert.match(navEv.error.message, /dibatalkan oleh stop/)
  // urutan balasan SSE: stop lebih dulu dari navigate
  const idxStop = sse.events.findIndex((e) => e.id === 23)
  const idxNav = sse.events.findIndex((e) => e.id === 22)
  assert.ok(idxStop < idxNav, `stop (idx ${idxStop}) harus sebelum navigate (idx ${idxNav})`)
  sse.res.destroy()
})

// P2-1 (critic R2): stop TIDAK membatalkan navigate yang SUDAH ANTRE — navigate
// yang dikirim SEBELUM stop tetap jalan & sukses sesudah stop (kerja jalan
// SESUDAH stop = celah). Fix src/http.js: rec per job + snapshot saat stop
// diterima → job antrean yang belum mulai dibatalkan (balasan SSE error
// "dibatalkan oleh stop"), yang sudah jalan biar dihentikan stop handler.
test("e2e http P2-1: batch [wait, navigate antri, stop] → navigate ANTRI dibatalkan via SSE, stop cepat & jujur", async () => {
  const sse = await openSse()
  assert.equal(sse.status, 200)
  await postMessage(sse.sessionId, { jsonrpc: "2.0", id: 41, method: "initialize", params: {} })

  // 1. wait panjang dilepas dulu → job INI yang jalan di queue saat stop datang.
  const waitPost = postMessage(sse.sessionId, {
    jsonrpc: "2.0", id: 42, method: "tools/call",
    params: { name: "wait", arguments: { ms: 1500 } },
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 200)) // wait SUDAH mulai (job berjalan)
  // 2. navigate dilepas → mengantre di belakang wait (belum mulai).
  const navPost = postMessage(sse.sessionId, {
    jsonrpc: "2.0", id: 43, method: "tools/call",
    params: { name: "navigate", arguments: { url: `${fx.base}/slow?ms=2500` } },
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 100)) // navigate sudah ter-antre
  // 3. stop → wajib balas cepat + membatalkan navigate yang masih antre.
  const t0 = Date.now()
  await postMessage(sse.sessionId, { jsonrpc: "2.0", id: 44, method: "tools/call", params: { name: "stop", arguments: {} } })
  await waitFor(sse.events, [44], 8000)
  const stopMs = Date.now() - t0
  const stopEv = sse.events.find((e) => e.id === 44)
  const sp = JSON.parse(stopEv.result.content[0].text)
  assert.equal(sp.stopped, false, `stop jujur {stopped:false} (tak ada inflight — navigate masih antre): ${JSON.stringify(sp)}`)
  assert.match(sp.note, /tidak ada inflight/)
  assert.ok(stopMs < 1000, `stop harus cepat (<1000ms), dapat ${stopMs}ms`)

  await waitFor(sse.events, [42, 43], 12000)
  // wait yang SUDAH berjalan → tidak dibatalkan
  const waitEv = sse.events.find((e) => e.id === 42)
  assert.ok(waitEv?.result, `wait berjalan tidak boleh dibatalkan: ${JSON.stringify(waitEv)}`)
  // INTI FIX: navigate yang dikirim SEBELUM stop, masih ANTRI → TIDAK jalan
  const navEv = sse.events.find((e) => e.id === 43)
  assert.ok(navEv?.error, `navigate antre wajib ERROR, dapat: ${navEv ? JSON.stringify(navEv.result || navEv.error).slice(0, 140) : "tidak ada event"}`)
  assert.match(navEv.error.message, /dibatalkan oleh stop/)
  await waitPost
  await navPost
  sse.res.destroy()
})

// P1 critic R5: http.js dulu bikin SATU McpServer/page untuk SEMUA session
// (src/http.js:66) sementara antrean DIANTRIKAN PER SESSION (:197-288) →
//   (a) state bleed SENYAP: klien B membaca halaman klien A tanpa tanda apa pun;
//   (b) `stop` klien B MEMBATALKAN navigasi klien A.
// Fix = McpServer + page PER SESSION (invarian repo: "satu page → satu queue",
// docs/AUDIT-2026-09-23.md:70) → keduanya terisolasi.
const jsonText = (ev) => {
  try { return JSON.parse(ev.result.content[0].text) } catch { return null }
}

test("e2e http P1-R5: dua session TERISOLASI — halaman & state TIDAK bocor antar klien", async () => {
  const A = await openSse()
  const B = await openSse()
  assert.equal(A.status, 200)
  assert.equal(B.status, 200)
  assert.notEqual(A.sessionId, B.sessionId, "dua session berbeda")
  await postMessage(A.sessionId, { jsonrpc: "2.0", id: 61, method: "initialize", params: {} })
  await postMessage(B.sessionId, { jsonrpc: "2.0", id: 62, method: "initialize", params: {} })

  // Navigasi SERENTAK: A → /page3 ("Page Three"), B → /page2 ("Page Two").
  await Promise.all([
    postMessage(A.sessionId, { jsonrpc: "2.0", id: 63, method: "tools/call", params: { name: "navigate", arguments: { url: `${fx.base}/page3`, timeoutMs: 15000 } } }),
    postMessage(B.sessionId, { jsonrpc: "2.0", id: 64, method: "tools/call", params: { name: "navigate", arguments: { url: `${fx.base}/page2`, timeoutMs: 15000 } } }),
  ])
  await waitFor([...A.events, ...B.events], [63, 64])
  const navA = A.events.find((e) => e.id === 63)
  const navB = B.events.find((e) => e.id === 64)
  assert.ok(navA?.result && navB?.result, `dua navigate wajib sukses: A=${JSON.stringify(navA?.error)} B=${JSON.stringify(navB?.error)}`)

  // B menanyakan halamannya SENDIRI → wajib tetap /page2 "Page Two".
  await postMessage(B.sessionId, { jsonrpc: "2.0", id: 65, method: "tools/call", params: { name: "get_content", arguments: { format: "summary" } } })
  await postMessage(A.sessionId, { jsonrpc: "2.0", id: 66, method: "tools/call", params: { name: "get_content", arguments: { format: "summary" } } })
  await waitFor([...A.events, ...B.events], [65, 66])
  const bView = jsonText(B.events.find((e) => e.id === 65))
  const aView = jsonText(A.events.find((e) => e.id === 66))
  assert.ok(bView && aView, `get_content wajib result: B=${JSON.stringify(bView)} A=${JSON.stringify(aView)}`)
  assert.equal(bView.title, "Page Two", `session B bocor ke halaman session A (bleed!) — dapat title=${bView.title}`)
  assert.match(bView.currentUrl, /\/page2$/, `session B tetap di /page2, dapat ${bView.currentUrl}`)
  assert.equal(aView.title, "Page Three", `session A tetap di /page3, dapat title=${aView.title}`)
  A.res.destroy()
  B.res.destroy()
})

test("e2e http P1-R5: `stop` dari session LAIN tak menyentuh navigasi session C", async () => {
  const C = await openSse()
  const D = await openSse()
  assert.equal(C.status, 200)
  assert.equal(D.status, 200)
  await postMessage(C.sessionId, { jsonrpc: "2.0", id: 70, method: "initialize", params: {} })
  await postMessage(D.sessionId, { jsonrpc: "2.0", id: 71, method: "initialize", params: {} })

  // POST TANPA di-await: POST baru 202 setelah navigate selesai (lihat test
  // stop-prioritas di atas) — navigate C harus benar-benar inflight saat stop.
  const navPost = postMessage(C.sessionId, {
    jsonrpc: "2.0", id: 72, method: "tools/call",
    params: { name: "navigate", arguments: { url: `${fx.base}/slow?ms=4000`, timeoutMs: 20000 } },
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 400)) // navigate C pasti inflight (4000ms lambat)

  await postMessage(D.sessionId, { jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: "stop", arguments: {} } })
  await waitFor([...C.events, ...D.events], [72, 73], 15000)
  await navPost

  const stopEv = D.events.find((e) => e.id === 73)
  const sp = jsonText(stopEv)
  assert.ok(sp, `stop session D wajib result, dapat: ${JSON.stringify(stopEv)}`)
  assert.equal(sp.stopped, false, `stop lintas-sesi wajib JUJUR "tidak ada inflight" (page terisolasi), dapat: ${JSON.stringify(sp)}`)
  assert.match(sp.note, /tidak ada inflight/)

  const navEv = C.events.find((e) => e.id === 72)
  assert.ok(navEv?.result, `navigate session C wajib SUKSES (tak dibatalkan stop sesi lain), dapat: ${JSON.stringify(navEv?.error)}`)
  const navView = jsonText(navEv)
  assert.equal(navView.title, "Home", "halaman C utuh sesudah stop lintas-sesi")
  C.res.destroy()
  D.res.destroy()
})
