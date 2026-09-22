// mcp-web — e2e HTTP remote: spawn serve, SSE + POST /message round-trip.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import http from "node:http"
import { startFixtureServer } from "./helpers.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bin = path.join(root, "bin", "mcp-web.js")

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

// Buka SSE — resolve segera setelah header (session id), kumpulkan events asinkron.
function openSse() {
  return new Promise((resolve) => {
    const state = { sessionId: null, events: [], res: null, done: false }
    const req = http.get({ host: "127.0.0.1", port, path: "/sse" }, (res) => {
      state.res = res
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
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: "127.0.0.1", port, path: `/message?sessionId=${encodeURIComponent(sessionId)}`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
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

function waitHealth() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tryOnce = () => {
      http.get({ host: "127.0.0.1", port, path: "/health" }, (res) => {
        let b = ""
        res.on("data", (c) => (b += c))
        res.on("end", () => resolve(JSON.parse(b)))
      }).on("error", () => {
        if (Date.now() - t0 > 5000) return reject(new Error("health timeout"))
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
  child = spawn("node", [bin, "serve", "--port", String(port)], { stdio: "ignore" })
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

test("e2e http: SSE + POST initialize + tools/list + navigate", async () => {
  const sse = await openSse()
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