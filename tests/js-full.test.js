// mcp-web — js_eval konteks penuh (engine JS) vs minimal (engine DOM) + bukti
// canggih: sessionStorage/location/getComputedStyle LIVE, subresource network
// log, console error halaman tertangkap.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { McpServer, processLine } from "../src/protocol.js"
import { createTools } from "../src/tools.js"
import { startFixtureServer, resultText, parseJson } from "./helpers.js"

// Fixture test ada di 127.0.0.1 → izinkan target private HANYA di proses test ini.
process.env.MCWEB_ALLOW_PRIVATE = "1"

let fx
let jsServer
let domServer
let nextId = 7000

before(async () => {
  fx = await startFixtureServer()
  jsServer = new McpServer({ name: "mcp-web", version: "1.1.0", tools: await createTools({ engine: "js" }) })
  domServer = new McpServer({ name: "mcp-web", version: "1.1.0", tools: await createTools() })
})

after(async () => {
  await fx.close?.()
})

async function call(server, name, args = {}) {
  const out = await processLine(server, JSON.stringify({
    jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args },
  }))
  return out[0]
}

test("engine JS: js_eval context penuh — window/sessionStorage/location/getComputedStyle live", async () => {
  await call(jsServer, "navigate", { url: `${fx.base}/` })
  const m = await call(jsServer, "js_eval", {
    code: `return JSON.stringify({ w: typeof window, ss: typeof sessionStorage, loc: typeof location, gcs: typeof getComputedStyle, d: typeof document })`,
  })
  const p = parseJson(resultText(m.result))
  assert.equal(p.engine, "js")
  const t = JSON.parse(p.result)
  assert.equal(t.w, "object")
  assert.equal(t.ss, "object")
  assert.equal(t.loc, "object")
  assert.equal(t.gcs, "function")
  assert.equal(t.d, "object")
})

test("engine JS: sessionStorage roundtrip + location.href mengikuti navigasi", async () => {
  const m = await call(jsServer, "js_eval", {
    code: `sessionStorage.setItem("k", "v"); return JSON.stringify({ ss: sessionStorage.getItem("k"), href: location.href })`,
  })
  const t = JSON.parse(parseJson(resultText(m.result)).result)
  assert.equal(t.ss, "v")
  assert.ok(t.href.startsWith(fx.base), `href ${t.href} harus di ${fx.base}`)
})

test("engine JS: network_logs mencatat subresource script (fetch + eval)", async () => {
  const n = await call(jsServer, "navigate", { url: `${fx.base}/with-script` })
  assert.equal(parseJson(resultText(n.result)).status, 200)
  const m = await call(jsServer, "network_logs")
  const p = parseJson(resultText(m.result))
  const hit = p.logs.filter((l) => /classic\.js/.test(l.url || ""))
  assert.ok(hit.length >= 1, "classic.js harus tercatat di network log")
  assert.equal(hit[0].status, 200)
})

test("engine JS: console.error halaman tertangkap console_get", async () => {
  await call(jsServer, "js_eval", { code: `console.error("boom-jsfull"); return 1` })
  const m = await call(jsServer, "console_get")
  const p = parseJson(resultText(m.result))
  assert.ok(p.logs.some((l) => /boom-jsfull/.test(l.message || "")))
})

test("engine DOM (default): js_eval tetap jalan — document + window minimal + note engine", async () => {
  await call(domServer, "navigate", { url: `${fx.base}/` })
  const m = await call(domServer, "js_eval", { code: `return JSON.stringify({ d: typeof document, title: window.title })` })
  const p = parseJson(resultText(m.result))
  assert.equal(p.engine, "dom")
  assert.match(p.note, /engine JS/)
  const t = JSON.parse(p.result)
  assert.equal(t.d, "object")
  assert.equal(t.title, "Home")
})

// 54-tool expansion: alert via eval TIDAK melempar — masuk antrean `dialog`
// (hook dipasang SEBELUM eval; dom: sandbox, js: window.alert).
test("engine JS: evaluate alert TIDAK crash → antrean dialog terisi", async () => {
  const m = await call(jsServer, "evaluate", { code: `alert("dari-js-alert"); return "ok"` })
  const p = parseJson(resultText(m.result))
  assert.equal(p.engine, "js")
  assert.equal(p.result, "ok")
  const d = await call(jsServer, "dialog", { action: "list" })
  const dp = parseJson(resultText(d.result))
  assert.ok(dp.count >= 1, "antrean dialog kosong — alert tak terekam")
  assert.ok(dp.dialogs.some((x) => x.type === "alert" && /dari-js-alert/.test(x.message)))
})
