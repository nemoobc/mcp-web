// mcp-web — P2-5 critic R5: tool `find` menjalankan regex MILIK PEMANGGIL
// sinkron TANPA timeout → ReDoS membekukan SELURUH proses:
//   "(a+)+b" atas "a"×30 = 83543ms (1 panggilan = proses beku, stop ikut mati).
// Fix diuji di sini: regex dijalankan di dalam vm DENGAN timeout
// (FIND_TIMEOUT_MS, src/tools.js) → backtracking eksplosif diputus V8 →
// error jujur + proses tetap hidup. Pola biasa & mode text harus tetap normal.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { McpServer, processLine } from "../src/protocol.js"
import { createTools, FIND_TIMEOUT_MS, FIND_PATTERN_MAX } from "../src/tools.js"

process.env.MCWEB_ALLOW_PRIVATE = "1" // fixture = 127.0.0.1 (pola file test lain)

// Race thd watchdog: tanpa fix, find() tak pernah kembali → watchdog yang menagih.
// catatan: processLine SELALU resolve dgn pesan {result|error} — watchdog object
// dibedakan lewat properti `watchdog` saja.
async function raced(p, ms) {
  let t
  const wd = new Promise((r) => { t = setTimeout(() => r({ watchdog: true }), ms) })
  const out = await Promise.race([p, wd])
  clearTimeout(t)
  return out
}

let srv
let tools
let server
let nextId = 61000

before(async () => {
  // Halaman berisi teks ReDoS: "a"×30 (probe kritikus: n=30 → 83543ms).
  srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(`<!doctype html><html><head><title>Redos</title></head><body>
      <p id="t">${"a".repeat(30)}</p>
      <p id="k">Kata Target di sini</p>
      <span>span biasa</span>
    </body></html>`)
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  tools = await createTools({ engine: "dom" })
  server = new McpServer({ name: "mcp-web", version: "test", tools })
  const base = `http://127.0.0.1:${srv.address().port}/`
  const nav = await processLine(server, JSON.stringify({
    jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "navigate", arguments: { url: base } },
  }))
  assert.ok(nav[0].result, `navigate fixture gagal: ${JSON.stringify(nav[0].error)}`)
})

after(async () => {
  srv.closeAllConnections?.()
  await new Promise((r) => srv.close(r))
})

async function call(name, args) {
  const out = await processLine(server, JSON.stringify({
    jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args },
  }))
  return out[0]
}

test("P2-5: ReDoS `(a+)+b` atas 'a'×30 → dihentikan ±FIND_TIMEOUT_MS (proses TIDAK beku)", async () => {
  const t0 = Date.now()
  const r = await raced(call("find", { pattern: "(a+)+b", flags: "" }), FIND_TIMEOUT_MS + 6000)
  const ms = Date.now() - t0
  assert.ok(!r.watchdog, `find ReDoS masih menggantung ≥${FIND_TIMEOUT_MS + 6000}ms — pembekuan proses (P2-5 reproduksi)`)
  assert.ok(r.error, `ReDoS wajib DITOLAK (bukan hasil), dapat: ${JSON.stringify(r.result ?? null).slice(0, 160)}`)
  assert.equal(r.error.code, -32003, "error eksekusi tool (bukan crash)")
  assert.match(r.error.message, /terlalu lambat|ReDoS/, `pesan wajib jujur soal ReDoS/timeout: ${r.error.message}`)
  assert.match(r.error.message, new RegExp(`setelah ${FIND_TIMEOUT_MS}ms`))
  // Plafon longgar utk timer starvation: vm timeout 2000ms + overhead — tanpa
  // fix angka ini = 83543ms (dan percobaan pertama kritikus: EXIT=124).
  assert.ok(ms < FIND_TIMEOUT_MS + 4000, `hentikan dalam <${FIND_TIMEOUT_MS + 4000}ms, dapat ${ms}ms`)
})

test("P2-5: proses HIDUP sesudah ReDoS — panggilan find berikutnya tetap jalan", async () => {
  const r = await call("find", { pattern: "Kata", flags: "i" })
  assert.ok(r.result, `find normal harus tetap sukses setelah percobaan ReDoS: ${JSON.stringify(r.error)}`)
  const p = JSON.parse(r.result.content[0].text)
  assert.ok(p.count >= 1, `pola biasa wajib ketemu, dapat count=${p.count}`)
  assert.ok(p.items.some((i) => /Kata Target/.test(i.text)))
})

test("P2-5: mode `text` (tanpa regex) tetap normal — contains literal", async () => {
  const r = await call("find", { text: "span biasa" })
  assert.ok(r.result, JSON.stringify(r.error))
  const p = JSON.parse(r.result.content[0].text)
  assert.equal(p.count, 1, `teks literal ketemu 1 elemen, dapat ${p.count}`)
  assert.equal(p.items[0].tag, "span")
})

test("P2-5: pattern terlalu panjang → ditolak SEBELUM dijalankan (-32602)", async () => {
  const r = await call("find", { pattern: "a".repeat(FIND_PATTERN_MAX + 1) })
  assert.ok(r.error, "wajib error")
  assert.equal(r.error.code, -32602)
  assert.match(r.error.message, new RegExp(`terlalu panjang \\(maks ${FIND_PATTERN_MAX}`))
})

test("P2-5: regex/flag tidak valid → tetap -32602 jujur (bukan timeout)", async () => {
  const bad = await call("find", { pattern: "(unclosed" })
  assert.equal(bad.error?.code, -32602)
  assert.match(bad.error.message, /regex tidak valid/)
  const badFlags = await call("find", { pattern: "a", flags: "zz" })
  assert.equal(badFlags.error?.code, -32602)
  assert.match(badFlags.error.message, /regex tidak valid/)
})
