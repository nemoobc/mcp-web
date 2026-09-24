// mcp-web — P2-2 critic R5: `required` di inputSchema TIDAK DIPEGANG →
//   * fill({"selector":"#email"}) tanpa `value` → SUKSES + menulis literal
//     "undefined" ke form (data login/checkout korup SENYAP);
//   * argumen hilang malah error ARAH SALAH ("Belum ada halaman" untuk
//     query({}) / js_eval({}) — kesalahan sebenarnya = argumen hilang);
//   * celah tanpa test: `grep -rln required tests/` → kosong.
// Fix diuji di sini: assertToolArgs (src/tools.js) kini memeriksa
// schema.required SEBELUM handler jalan → -32602 jujur menyebut key wajib.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { McpServer, processLine } from "../src/protocol.js"
import { createTools } from "../src/tools.js"
import { startFixtureServer, resultText, parseJson } from "./helpers.js"

process.env.MCWEB_ALLOW_PRIVATE = "1" // fixture = 127.0.0.1 (pola file test lain)

let fx
let server
let tools
let nextId = 51000

before(async () => {
  fx = await startFixtureServer()
  tools = await createTools() // engine dom
  server = new McpServer({ name: "mcp-web", version: "test", tools })
})

after(async () => { await fx.close() })

// Lewat protokol (jalur sama dgn stdio/http/plugin — wrapper createTools).
async function call(name, args) {
  const params = { name }
  if (args !== undefined) params.arguments = args
  const out = await processLine(server, JSON.stringify({
    jsonrpc: "2.0", id: nextId++, method: "tools/call", params,
  }))
  return out[0]
}

function expectMissing(m, key, name) {
  assert.ok(m.error, `wajib ERROR -32602 (bukan sukses senyap) utk ${name} tanpa '${key}': ${JSON.stringify(m.result ?? null).slice(0, 120)}`)
  assert.equal(m.error.code, -32602, `code -32602 utk ${name} tanpa '${key}'`)
  assert.match(m.error.message, new RegExp(`argumen wajib hilang untuk tool '${name}': [^,]*\\b${key}\\b`))
  assert.match(m.error.message, /inputSchema\.required/)
}

test("P2-2: fill TANPA `value` → ditolak -32602, isi input TIDAK dirusak (bukan 'undefined')", async () => {
  const nav = await call("navigate", { url: fx.base + "/" })
  assert.ok(nav.result, "navigate fixture ok")
  const isi = await call("fill", { selector: "#email", value: "asli" })
  assert.ok(isi.result, `fill normal harus sukses: ${JSON.stringify(isi.error)}`)

  // Reproduksi probe critic: fill SEKARANG tanpa value.
  const bad = await call("fill", { selector: "#email" })
  expectMissing(bad, "value", "fill")

  // Bukti dampak TERTUTUP: nilai asli bertahan, "undefined" tak pernah tertulis.
  const after = await call("js_eval", { code: "document.querySelector('#email').value" })
  const v = parseJson(resultText(after.result))
  assert.equal(v.result, "asli", `isi input wajib tetap 'asli' setelah fill tanpa value, dapat: ${JSON.stringify(v)}`)
})

test("P2-2: argumen hilang → pesan ARAH BENAR (key wajib), bukan 'Belum ada halaman'", async () => {
  // query({}) & js_eval({}) dulu menjawab "Belum ada halaman. Jalankan navigate dulu."
  const q = await call("query", {})
  expectMissing(q, "selector", "query")
  assert.doesNotMatch(q.error.message, /Belum ada halaman/, "jangan menunjuk hal arah")

  const j = await call("js_eval", {})
  expectMissing(j, "code", "js_eval")
  assert.doesNotMatch(j.error.message, /Belum ada halaman/)

  // select {selector} tanpa value → dulu "Elemen tidak ditemukan: #kop"
  const s = await call("select", { selector: "#kop" })
  expectMissing(s, "value", "select")
})

test("P2-2: `arguments` KOSONG/absen & nilai null → tetap ditolak (semua key wajib disebut)", async () => {
  const a = await call("fill") // params TANPA `arguments` sama sekali
  expectMissing(a, "selector", "fill")
  assert.match(a.error.message, /value/, "semua required ikut disebut")

  const b = await call("fill", null)
  expectMissing(b, "selector", "fill")

  const c = await call("fill", { selector: "#email", value: null })
  expectMissing(c, "value", "fill")
})

test("P2-2: handler dipanggil LANGSUNG tanpa args juga ditolak (bukan cuma jalur protokol)", async () => {
  const fill = tools.find((t) => t.name === "fill")
  await assert.rejects(
    () => fill.handler(undefined, "fill"),
    (e) => e.code === -32602 && /argumen wajib hilang/.test(e.message),
    "handler wrapper wajib melempar McpError -32602 tanpa arguments",
  )
  await assert.rejects(
    () => fill.handler({ selector: "#email" }, "fill"),
    (e) => e.code === -32602 && /value/.test(e.message),
  )
})

test("P2-2: alias `evaluate` memakai NAMA TOOL yang dipanggil di pesan error", async () => {
  const m = await call("evaluate", {})
  expectMissing(m, "code", "evaluate")
  assert.match(m.error.message, /tool 'evaluate'/, "pesan menyebut alias, bukan js_eval")
})

test("P2-2: tool TANPA required tetap lolos (tak ada efek samping validasi)", async () => {
  const w = await call("wait", { ms: 1 })
  assert.ok(w.result, `wait tanpa required harus sukses: ${JSON.stringify(w.error)}`)
  const n = await call("network_logs", {})
  assert.ok(n.result, `network_logs (schema tanpa required) harus sukses: ${JSON.stringify(n.error)}`)
  const out = await processLine(server, JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/list" }))
  assert.ok(out[0].result?.tools?.length, `tools/list tetap jalan, dapat: ${JSON.stringify(out[0]).slice(0, 120)}`)
})
