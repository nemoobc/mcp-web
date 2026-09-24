// mcp-web — test SURFACE 54 tool: hitungan, daftar nama MCP flat, alias handler,
// validasi shape (tanpa tool palsu yang "mengembang palsu"), dan 5 tool
// engine-impossible yang wajib melempar error terstruktur (bukan hasil karangan).
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { McpServer, processLine } from "../src/protocol.js"
import { createTools } from "../src/tools.js"

// 45 nama builtin opencode.browser (urut spesifikasi) → bentuk flat MCP (dotted → _).
const BUILTIN_45 = [
  "tabs.list", "tabs.open", "tabs.focus", "tabs.close", "preview", "navigate",
  "back", "forward", "reload", "stop", "frames", "snapshot", "find", "evaluate",
  "click", "hover", "drag", "fill", "fill_form", "select", "check", "press",
  "scroll", "wait", "screenshot", "dialog", "files.upload", "files.drop",
  "files.list", "files.get", "console", "network.list", "network.get",
  "trace.start", "trace.stop", "trace.analyze", "cpu.start", "cpu.stop",
  "cpu.analyze", "heap.snapshot", "heap.summary", "heap.query", "heap.object",
  "heap.compare", "lighthouse",
]
// 9 tool lama yang DIPERTAHANKAN (tak ada di 45).
const LEGACY_9 = [
  "submit", "get_content", "query", "js_eval", "console_get", "network_logs",
  "cookies", "history", "reset",
]
const FLAT_45 = BUILTIN_45.map((n) => n.split(".").join("_"))
const EXPECTED_54 = [...new Set([...FLAT_45, ...LEGACY_9])]

// Butuh desktop browser/Chromium → engine js/dom TIDAK mungkin memberi hasil.
const DESKTOP_ONLY = ["heap_snapshot", "heap_query", "heap_object", "heap_compare", "lighthouse"]

let tools
let server

before(async () => {
  tools = await createTools()
  server = new McpServer({ name: "mcp-web", version: "test", tools })
})

async function call(name, args = {}) {
  const out = await processLine(server, JSON.stringify({
    jsonrpc: "2.0", id: `s-${name}`, method: "tools/call", params: { name, arguments: args },
  }))
  return out[0]
}

test("createTools → tepat 54 tool, tanpa duplikat, daftar nama flat sesuai daftar spesifikasi", () => {
  assert.equal(tools.length, 54)
  const names = tools.map((t) => t.name)
  assert.equal(new Set(names).size, 54, "ada nama tool dobel")
  assert.deepEqual([...names].sort(), [...EXPECTED_54].sort())
})

test("SEMUA tool valid: description + inputSchema object + handler function (tanpa tool hiasan/skeleton)", () => {
  for (const t of tools) {
    assert.ok(typeof t.description === "string" && t.description.length > 10, `${t.name}: description kosong/pendek`)
    assert.equal(t.inputSchema?.type, "object", `${t.name}: inputSchema bukan JSON Schema object`)
    assert.equal(typeof t.handler, "function", `${t.name}: handler bukan function`)
  }
})

test("3 alias memakai referensi handler yang SAMA (bukan salinan lemah)", () => {
  const get = (n) => tools.find((t) => t.name === n)
  assert.equal(get("evaluate").handler, get("js_eval").handler)
  assert.equal(get("console").handler, get("console_get").handler)
  assert.equal(get("network_list").handler, get("network_logs").handler)
})

test("MCP tools/list → 54 entri", async () => {
  const out = await processLine(server, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
  assert.equal(out[0].result.tools.length, 54)
})

test("5 tool engine-impossible → error terstruktur pesan Chromium, BUKAN hasil palsu", async () => {
  for (const name of DESKTOP_ONLY) {
    const m = await call(name)
    assert.ok(m.error, `${name}: wajib error, bukan result sukses`)
    assert.ok(!m.result, `${name}: tidak boleh membawa result`)
    assert.match(m.error.message, /butuh desktop browser\/Chromium — engine js\/dom tidak mendukung/)
  }
})

test("alias evaluate & console berfungsi (bukan permukaan kosong)", async () => {
  // Page kosong → evaluate menolak jelas; console (tanpa page pun) tetap jalan.
  const ev = await call("evaluate", { code: "return 1" })
  assert.ok(ev.error)
  assert.match(ev.error.message, /Belum ada halaman/)
  const c = await call("console")
  const cp = JSON.parse(resultOf(c))
  assert.equal(typeof cp.count, "number")
  assert.ok(Array.isArray(cp.logs))
})

function resultOf(m) {
  return m?.result?.content?.[0]?.text ?? "{}"
}
