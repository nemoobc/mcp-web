// mcp-web — kontrak input: argumen asing / enum / tipe ditolak JUJUR (-32602)
// dengan nama key, BUKAN diabaikan senyap (P1-2 critic) + enum koersi (P2-1),
// tipe input (P2-2), base64 rusak (P2-3), note jujur engine dom (P2-5/P2-6).
// Test per kasus probe critic: back/tabID, wait/condition+text+timeoutMs,
// preview/path, scroll/deltaY, navigate/tabID, trace_start/durationMs.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { McpServer, processLine } from "../src/protocol.js"
import { createTools } from "../src/tools.js"
import { startFixtureServer, resultText, parseJson } from "./helpers.js"

// Fixture test ada di 127.0.0.1 → izinkan target private HANYA di proses test ini.
process.env.MCWEB_ALLOW_PRIVATE = "1"

let fx
let server
let nextId = 8000

before(async () => {
  fx = await startFixtureServer()
  server = new McpServer({ name: "mcp-web", version: "test", tools: await createTools() })
})

after(async () => { await fx.close() })

async function call(name, args = {}) {
  const out = await processLine(server, JSON.stringify({
    jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args },
  }))
  return out[0]
}

// Assert error kontrak: -32602 + pesan menyebut key DAN tool.
async function expectArgError(m, key, name) {
  assert.ok(m.error, `wajib error, bukan result sukses (key=${key})`)
  assert.equal(m.error.code, -32602, `code harus -32602 (key=${key})`)
  assert.match(m.error.message, new RegExp(`argumen '${key}'`), `pesan wajib menyebut '${key}'`)
  assert.match(m.error.message, new RegExp(`tool '${name}'`), `pesan wajib menyebut tool '${name}'`)
}

// ===================== P1-2: argumen asing (per kasus probe) =====================

test("probe: back({tabID}) → ditolak, pesan menyebut 'tabID'", async () => {
  const m = await call("back", { tabID: 3 })
  await expectArgError(m, "tabID", "back")
})

test("probe: wait({condition|text|timeoutMs}) → SEMUA key asing ditolak (bukan diabaikan)", async () => {
  for (const key of ["condition", "text", "timeoutMs"]) {
    const m = await call("wait", { [key]: "x" })
    await expectArgError(m, key, "wait")
  }
  // dikirim bareng → tetap error -32602 (minimal satu key disebut)
  const all = await call("wait", { condition: "visible", text: "x", timeoutMs: 100 })
  assert.ok(all.error)
  assert.equal(all.error.code, -32602)
  assert.match(all.error.message, /argumen '(condition|text|timeoutMs)'/)
})

test("probe: preview({path}) → ditolak, pesan menyebut 'path'", async () => {
  const m = await call("preview", { path: "/tmp/x" })
  await expectArgError(m, "path", "preview")
})

test("probe: scroll({deltaY}) → argumen DIDUKUNG (konversi relatif), bukan error/diabaikan", async () => {
  await call("navigate", { url: `${fx.base}/rich` })
  const m = await call("scroll", { selector: "#scroller", deltaY: 100 })
  assert.ok(!m.error, `scroll deltaY tidak boleh ditolak: ${m.error?.message}`)
  const p = parseJson(resultText(m.result))
  assert.equal(p.scrolled, "#scroller")
  assert.equal(p.eventDispatched, true)
  if (typeof p.scrollTop === "number") {
    // engine dengan scrollTop nyata → deltaY = relatif terhadap posisi sekarang
    assert.ok(p.scrollTop >= 0)
  }
})

test("probe: navigate({tabID}) → ditolak, pesan menyebut 'tabID'", async () => {
  const m = await call("navigate", { url: `${fx.base}/`, tabID: "tab-9" })
  await expectArgError(m, "tabID", "navigate")
})

test("probe: trace_start({durationMs}) → ditolak, pesan menyebut 'durationMs'", async () => {
  const m = await call("trace_start", { durationMs: 50 })
  await expectArgError(m, "durationMs", "trace_start")
})

test("argumen VALID tetap jalan — tidak ada regresi (navigate/wait/scroll/preview/trace)", async () => {
  const nav = await call("navigate", { url: `${fx.base}/`, timeoutMs: 10000 })
  assert.ok(!nav.error, `navigate valid gagal: ${nav.error?.message}`)
  const w = await call("wait", { ms: 5 })
  assert.ok(!w.error, `wait valid gagal: ${w.error?.message}`)
  assert.equal(parseJson(resultText(w.result)).waitedMs, 5)
  const sc = await call("scroll", { y: 40 })
  assert.ok(!sc.error, `scroll y valid gagal: ${sc.error?.message}`)
  const pv = await call("preview")
  assert.ok(!pv.error, `preview tanpa argumen gagal: ${pv.error?.message}`)
  const ts = await call("trace_start", { label: "uji" })
  assert.ok(!ts.error, `trace_start label valid gagal: ${ts.error?.message}`)
  const tst = await call("trace_stop")
  assert.ok(!tst.error, `trace_stop gagal: ${tst.error?.message}`)
})

// ===================== P2-1: enum koersi senyap =====================

test("P2-1: screenshot({format:'jpeg'}) → ditolak, format harus png|tree|text|html", async () => {
  const m = await call("screenshot", { format: "jpeg" })
  assert.ok(m.error)
  assert.equal(m.error.code, -32602)
  assert.match(m.error.message, /'format'/)
  assert.match(m.error.message, /png\|tree\|text\|html|text\|html\|png\|tree/)
})

test("P2-1: cookies({action:'bogus'}) → ditolak, action harus list|clear", async () => {
  const m = await call("cookies", { action: "bogus" })
  assert.ok(m.error)
  assert.equal(m.error.code, -32602)
  assert.match(m.error.message, /'action'/)
  assert.match(m.error.message, /list\|clear/)
})

test("P2-1: history({action:'bogus'}) → ditolak, action harus list|back|forward", async () => {
  const m = await call("history", { action: "bogus" })
  assert.ok(m.error)
  assert.equal(m.error.code, -32602)
  assert.match(m.error.message, /'action'/)
  assert.match(m.error.message, /list\|back\|forward/)
})

// ===================== P2-2: tipe input =====================

test("P2-2: wait({ms:'abc'}) → ditolak (ms wajib number); fill({value:{}}) → ditolak (value wajib string)", async () => {
  const w = await call("wait", { ms: "abc" })
  assert.ok(w.error)
  assert.equal(w.error.code, -32602)
  assert.match(w.error.message, /'ms'.*wajib number/)
  const f = await call("fill", { selector: "#email", value: {} })
  assert.ok(f.error)
  assert.equal(f.error.code, -32602)
  assert.match(f.error.message, /'value'.*wajib string/)
})

// ===================== P2-3: base64 rusak =====================

test("P2-3: files_get data base64 rusak → error 'base64 tidak valid' (bukan Buffer.from senyap)", async () => {
  const m = await call("files_get", { data: "data:text/plain;base64,@@bukan-base64@@" })
  assert.ok(m.error)
  assert.equal(m.error.code, -32602)
  assert.match(m.error.message, /base64 tidak valid/)
  // jalur files_upload (makeFile) juga ketat
  await call("navigate", { url: `${fx.base}/rich` })
  const u = await call("files_upload", { selector: "#up", base64: "!!!rusak!!!" })
  assert.ok(u.error)
  assert.equal(u.error.code, -32602)
  assert.match(u.error.message, /base64 tidak valid/)
  // base64 SAH tetap diterima (regresi)
  const ok = await call("files_get", { data: `data:text/plain;base64,${Buffer.from("halo").toString("base64")}` })
  assert.ok(!ok.error, `base64 sah ditolak: ${ok.error?.message}`)
  assert.equal(parseJson(resultText(ok.result)).content, "halo")
})

// ===================== P2-5: note jujur drag/files_drop (engine dom) =====================

test("P2-5: drag & files_drop → note jujur 'engine dom — listener halaman SPA tidak dieksekusi'", async () => {
  await call("navigate", { url: `${fx.base}/rich` })
  const d = await call("drag", { from: "#src", to: "#dropzone", data: { text: "abc" } })
  const dp = parseJson(resultText(d.result))
  assert.ok(!d.error, `drag gagal: ${d.error?.message}`)
  assert.equal(dp.engine, "dom")
  assert.match(dp.note, /engine dom — listener halaman SPA tidak dieksekusi/)
  const fd = await call("files_drop", { selector: "#dropzone", files: [{ name: "d.txt", content: "x" }] })
  const fdp = parseJson(resultText(fd.result))
  assert.ok(!fd.error, `files_drop gagal: ${fd.error?.message}`)
  assert.equal(fdp.engine, "dom")
  assert.match(fdp.note, /engine dom — listener halaman SPA tidak dieksekusi/)
})

// ===================== P2-6: note jujur dialog dismiss/next =====================

test("P2-6: dialog next/dismiss → note 'respons tidak dikirim ke halaman (engine tanpa native dialog)'", async () => {
  await call("reset")
  await call("navigate", { url: `${fx.base}/` })
  await call("evaluate", { code: "alert('uji-dialog'); return 'ok'" })
  const n = await call("dialog", { action: "next" })
  const np = parseJson(resultText(n.result))
  assert.ok(np.next, "ada dialog berikutnya")
  assert.equal(np.note, "respons tidak dikirim ke halaman (engine tanpa native dialog)")
  const d = await call("dialog", { action: "dismiss" })
  const dp = parseJson(resultText(d.result))
  assert.ok(dp.dismissed, "dismiss menandai record")
  assert.equal(dp.note, "respons tidak dikirim ke halaman (engine tanpa native dialog)")
})

// ============ P2-2 critic R2: pesan argumen asing pakai nama tool YANG DIPANGGIL ============
// Wrapper memo (src/tools.js) dulu menangkap `t` iterasi pertama →
// evaluate({bogus}) → "...tidak didukung tool 'js_eval'" (SALAH — harus
// 'evaluate'). Fix: protocol.callTool & plugin meneruskan nama pemanggil
// sebagai argumen ke-2 wrapper. Identity alias TETAP (satu referensi wrapper).

test("P2-2: pesan argumen asing 3 ALIAS memakai nama tool yang dipanggil (evaluate/console/network_list), tool biasa tetap namanya", async () => {
  for (const called of ["evaluate", "console", "network_list", "back", "js_eval", "console_get", "network_logs"]) {
    const m = await call(called, { bogus: 1 })
    assert.ok(m.error, `${called}({bogus:1}) wajib error, bukan result sukses`)
    assert.equal(m.error.code, -32602, `${called}: code harus -32602, dapat ${m.error.code}`)
    assert.match(m.error.message, /argumen 'bogus'/, `${called}: pesan wajib menyebut key`)
    assert.match(m.error.message, new RegExp(`tool '${called}'`), `${called}: pesan wajib menyebut tool '${called}' — dapat: ${m.error.message}`)
  }
})

test("P2-2: contract identity 3 alias TIDAK pecah oleh fix nama (evaluate === js_eval dst)", async () => {
  const tools = await createTools() // instance sendiri — identity diuji dalam SATU createTools
  const get = (n) => tools.find((t) => t.name === n)
  assert.equal(get("evaluate").handler, get("js_eval").handler)
  assert.equal(get("console").handler, get("console_get").handler)
  assert.equal(get("network_list").handler, get("network_logs").handler)
})
