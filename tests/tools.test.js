// mcp-web — test tools (flow navigasi/klik/form/history/cookies) via fixture lokal.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { McpServer, processLine } from "../src/protocol.js"
import { createTools } from "../src/tools.js"
import { startFixtureServer, resultText, parseJson } from "./helpers.js"

let fx
let server

before(async () => {
  fx = await startFixtureServer()
  server = new McpServer({ name: "mcp-web", version: "1.1.0", tools: createTools() })
})

after(async () => { await fx.close() })

async function call(id, name, args = {}) {
  const out = await processLine(server, JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }))
  return out[0]
}

test("navigate → summary halaman", async () => {
  const m = await call(10, "navigate", { url: `${fx.base}/` })
  const p = parseJson(resultText(m.result))
  assert.equal(p.status, 200)
  assert.equal(p.title, "Home")
  assert.equal(p.stats.links, 1)
  assert.equal(p.stats.forms, 1)
})

test("navigate URL invalid → error", async () => {
  const m = await call(11, "navigate", { url: "bukan-url" })
  assert.ok(m.error)
  assert.match(m.error.message, /URL tidak valid/)
})

test("navigate non-http → error", async () => {
  const m = await call(12, "navigate", { url: "file:///etc/passwd" })
  assert.ok(m.error)
  assert.match(m.error.message, /Hanya http\/https/)
})

test("query → daftar elemen", async () => {
  const m = await call(20, "query", { selector: "a, button, input" })
  const p = parseJson(resultText(m.result))
  assert.ok(p.count >= 4)
  assert.ok(p.items.some((i) => i.tag === "a"))
})

test("get_content text → mengandung teks halaman", async () => {
  const m = await call(21, "get_content", { format: "text" })
  assert.match(resultText(m.result), /Go to page 2/)
})

test("click link → navigasi", async () => {
  const m = await call(30, "click", { selector: "a" })
  const p = parseJson(resultText(m.result))
  assert.equal(p.navigated, true)
  assert.equal(p.title, "Page Two")
})

test("history back → kembali ke home", async () => {
  const m = await call(31, "history", { action: "back" })
  const p = parseJson(resultText(m.result))
  assert.equal(p.title, "Home")
})

test("submit form GET → query param di URL", async () => {
  const m = await call(40, "submit", { selector: "#search" })
  const p = parseJson(resultText(m.result))
  assert.equal(p.currentUrl, `${fx.base}/page2?q=hello&ok=on`)
})

test("fill input → value tersimpan", async () => {
  await call(50, "navigate", { url: `${fx.base}/` })
  const m = await call(51, "fill", { selector: "#email", value: "nemo@example.com" })
  assert.match(resultText(m.result), /nemo@example.com/)
})

test("redirect → diikuti sampai halaman final", async () => {
  const m = await call(60, "navigate", { url: `${fx.base}/redir` })
  const p = parseJson(resultText(m.result))
  assert.equal(p.title, "Page Two")
  assert.equal(p.redirects, 1)
})

test("cookie di-set dari header → cookies list", async () => {
  await call(70, "navigate", { url: `${fx.base}/cookie` })
  const m = await call(71, "cookies", { action: "list" })
  const p = parseJson(resultText(m.result))
  assert.ok(p.cookies.some((c) => c.name === "session" && c.value === "abc123"))
})

test("cookies clear → kosong", async () => {
  const m = await call(72, "cookies", { action: "clear" })
  const p = parseJson(resultText(m.result))
  assert.equal(p.cleared, true)
  const m2 = await call(73, "cookies", { action: "list" })
  assert.equal(parseJson(resultText(m2.result)).cookies.length, 0)
})

test("network_logs → ada riwayat", async () => {
  const m = await call(80, "network_logs", {})
  const p = parseJson(resultText(m.result))
  assert.ok(p.count >= 1)
  assert.ok(p.logs.some((l) => typeof l.status === "number"))
})

test("reset → bersihkan sesi", async () => {
  const m = await call(90, "reset", {})
  const p = parseJson(resultText(m.result))
  assert.equal(p.reset, true)
})