// mcp-web — test fungsional SEMUA tool baru (37 handler + alias) via fixture
// lokal. Happy path + path error: engine-impossible/selector hilang/param wajib.
// Urutan test penting: satu server bersama, node:test menjalankan berurutan.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { McpServer, processLine } from "../src/protocol.js"
import { createTools } from "../src/tools.js"
import { startFixtureServer, resultText, parseJson } from "./helpers.js"

// Fixture test ada di 127.0.0.1 → izinkan target private HANYA di proses test ini.
process.env.MCWEB_ALLOW_PRIVATE = "1"

let fx
let server
let nextId = 5000

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

// ===================== navigasi & inspeksi =====================

test("navigate /rich → fixture tool baru siap", async () => {
  const m = await call("navigate", { url: `${fx.base}/rich` })
  const p = parseJson(resultText(m.result))
  assert.equal(p.status, 200)
  assert.equal(p.title, "Rich")
})

test("preview → url + title + textHead maks 200 char", async () => {
  const m = await call("preview")
  const p = parseJson(resultText(m.result))
  assert.ok(p.url.endsWith("/rich"))
  assert.equal(p.title, "Rich")
  assert.ok(typeof p.textHead === "string" && p.textHead.length <= 200)
  assert.match(p.textHead, /Judul Rich/)
})

test("snapshot → outline terstruktur (tag+id+class+teks, ber-batas)", async () => {
  const m = await call("snapshot", { maxDepth: 8, maxNodes: 500 })
  const p = parseJson(resultText(m.result))
  assert.equal(p.root.tag, "html")
  const found = []
  const walk = (n) => { if (!n) return; found.push(n); for (const c of n.children || []) walk(c) }
  walk(p.root)
  assert.ok(found.some((n) => n.tag === "h1" && /Judul Rich/.test(n.text || "")), "node h1 tak ada di outline")
  assert.ok(found.some((n) => n.id === "box"), "div#box tak ada di outline")
  assert.equal(typeof p.truncated, "boolean")
  // cap node bekerja
  const m2 = await call("snapshot", { maxNodes: 5 })
  const p2 = parseJson(resultText(m2.result))
  assert.equal(p2.maxNodes, 5)
  assert.equal(p2.truncated, true)
})

test("find → teks/regex di DOM, selectorPath, cap 50, param wajib & regex valid", async () => {
  const m = await call("find", { text: "richpage" })
  const p = parseJson(resultText(m.result))
  assert.ok(p.count >= 1)
  assert.ok(p.items[0].selectorPath.length > 0)
  assert.match(p.items[0].text, /richpage/)
  const r = await call("find", { pattern: "rich\\w+", flags: "i" })
  const rp = parseJson(resultText(r.result))
  assert.ok(rp.count >= 1)
  const over = await call("find", { text: "i", limit: 999 })
  assert.ok(parseJson(resultText(over.result)).limit <= 50, "limit wajib cap 50")
  const e1 = await call("find", {})
  assert.ok(e1.error)
  assert.match(e1.error.message, /text atau pattern/)
  const e2 = await call("find", { pattern: "(unclosed" })
  assert.ok(e2.error)
  assert.match(e2.error.message, /regex tidak valid/)
})

test("frames → daftar iframe di /rich; tanpa iframe → [] (bukan error)", async () => {
  const m = await call("frames")
  const p = parseJson(resultText(m.result))
  assert.equal(p.count, 1)
  assert.equal(p.frames[0].id, "fr")
  assert.match(p.frames[0].src, /page3/)
  assert.equal(typeof p.frames[0].loaded, "boolean")
  await call("navigate", { url: `${fx.base}/` })
  const m2 = await call("frames")
  const p2 = parseJson(resultText(m2.result))
  assert.equal(p2.count, 0)
  assert.deepEqual(p2.frames, [])
})

// ===================== interaksi =====================

test("hover → mouseover ke target, mouseout dari hover sebelumnya; selector hilang → error", async () => {
  await call("navigate", { url: `${fx.base}/rich` })
  const m = await call("hover", { selector: "#box" })
  const p = parseJson(resultText(m.result))
  assert.equal(p.hovered, "#box")
  assert.ok(p.events.some((e) => e.type === "mouseover"))
  assert.match(p.note, /tanpa layout/)
  const m2 = await call("hover", { selector: ".lead" })
  const p2 = parseJson(resultText(m2.result))
  assert.ok(p2.events.some((e) => e.type === "mouseout"), "hover sebelumnya harus dapat mouseout")
  assert.ok(p2.events.some((e) => e.type === "mouseover"))
  const e = await call("hover", { selector: ".tidak-ada" })
  assert.ok(e.error)
  assert.match(e.error.message, /Elemen tidak ditemukan/)
})

test("drag → dragstart→dragover→drop→dragend + data; target hilang → error", async () => {
  const m = await call("drag", { from: "#src", to: "#dropzone", data: { text: "abc" } })
  const p = parseJson(resultText(m.result))
  assert.deepEqual(p.events, ["dragstart", "dragenter", "dragover", "drop", "dragend"])
  assert.ok(p.dataKeys.includes("text"))
  const e = await call("drag", { from: "#src", to: ".hilang" })
  assert.ok(e.error)
  assert.match(e.error.message, /Elemen tidak ditemukan: \.hilang/)
  const e2 = await call("drag", { from: ".hilang", to: "#dropzone" })
  assert.ok(e2.error)
  assert.match(e2.error.message, /Elemen tidak ditemukan: \.hilang/)
})

test("fill_form → isi banyak field sekaligus + alias evaluate memverifikasi", async () => {
  const m = await call("fill_form", {
    fields: [
      { selector: "#f1", value: "satu" },
      { selector: "#f2", value: "dua" },
      { selector: "#f3", value: "tiga" },
    ],
  })
  const p = parseJson(resultText(m.result))
  assert.equal(p.filled, 3)
  // alias evaluate = js_eval → baca nilai field di konteks halaman (engine dom)
  const v = await call("evaluate", { code: "return [document.querySelector('#f1').value, document.querySelector('#f2').value, document.querySelector('#f3').value].join(',')" })
  const vp = parseJson(resultText(v.result))
  assert.equal(vp.engine, "dom")
  assert.equal(vp.result, "satu,dua,tiga")
  const e1 = await call("fill_form", { fields: [{ selector: "#f1" }] })
  assert.ok(e1.error)
  assert.match(e1.error.message, /selector, value/)
  const e2 = await call("fill_form", {})
  assert.ok(e2.error)
  assert.equal(e2.error.code, -32602)
  // P2-2 R5: `required` dipegang di assertToolArgs → pesan MENYEBUT key wajib
  // (dulu lolos ke handler → "fields wajib array", arah salah).
  assert.match(e2.error.message, /argumen wajib hilang untuk tool 'fill_form': fields/)
})

test("select → set value + change; bukan select / option hilang → error", async () => {
  const m = await call("select", { selector: "#kop", value: "b" })
  const p = parseJson(resultText(m.result))
  assert.equal(p.selected, "#kop")
  assert.equal(p.value, "b")
  const v = await call("evaluate", { code: "return document.querySelector('#kop').value" })
  assert.equal(parseJson(resultText(v.result)).result, "b")
  const e1 = await call("select", { selector: "#kop", value: "zzz" })
  assert.ok(e1.error)
  assert.match(e1.error.message, /Option tidak ditemukan/)
  const e2 = await call("select", { selector: "#f1", value: "b" })
  assert.ok(e2.error)
  assert.match(e2.error.message, /Bukan <select>/)
})

test("check → toggle & tujuan eksplisit; bukan checkbox/radio → error", async () => {
  const m = await call("check", { selector: "#cb" })
  assert.equal(parseJson(resultText(m.result)).checked, true)
  const m2 = await call("check", { selector: "#cb" })
  assert.equal(parseJson(resultText(m2.result)).checked, false)
  const m3 = await call("check", { selector: "#r1", checked: true })
  const p3 = parseJson(resultText(m3.result))
  assert.equal(p3.checked, true)
  assert.equal(p3.type, "radio")
  const e = await call("check", { selector: "#f1" })
  assert.ok(e.error)
  assert.match(e.error.message, /Bukan checkbox\/radio/)
})

test("press → keydown/keypress/keyup + modifier; key wajib", async () => {
  const m = await call("press", { selector: "#f1", key: "Enter", modifiers: ["shift", "ctrl"] })
  const p = parseJson(resultText(m.result))
  assert.deepEqual(p.events, ["keydown", "keypress", "keyup"])
  assert.equal(p.pressed, "Enter")
  assert.ok(p.modifiers.includes("shift"))
  assert.ok(p.modifiers.includes("ctrl"))
  const e = await call("press", {})
  assert.ok(e.error)
  assert.equal(e.error.code, -32602)
  // P2-2 R5: required 'key' hilang → ditangkap SEBELUM handler (pesan key wajib).
  assert.match(e.error.message, /argumen wajib hilang untuk tool 'press': key/)
  const e2 = await call("press", { selector: ".hilang", key: "a" })
  assert.ok(e2.error)
  assert.match(e2.error.message, /Elemen tidak ditemukan/)
})

test("scroll → dispatch event + note jujur no-layout; selector hilang → error", async () => {
  const m = await call("scroll", { selector: "#scroller", y: 40 })
  const p = parseJson(resultText(m.result))
  assert.equal(p.scrolled, "#scroller")
  assert.equal(p.eventDispatched, true)
  assert.match(p.note, /TANPA layout/)
  const m2 = await call("scroll")
  const p2 = parseJson(resultText(m2.result))
  assert.equal(p2.scrolled, "document")
  assert.equal(p2.eventDispatched, true)
  const e = await call("scroll", { selector: ".hilang" })
  assert.ok(e.error)
  assert.match(e.error.message, /Elemen tidak ditemukan/)
})

// ===================== back/forward/reload/stop =====================

test("back/forward nav stack per tab + reload + stop jujur", async () => {
  await call("reset")
  await call("navigate", { url: `${fx.base}/` })
  const b0 = await call("back")
  assert.ok(b0.error)
  assert.match(b0.error.message, /ujung history/)
  const f0 = await call("forward")
  assert.ok(f0.error)
  assert.match(f0.error.message, /ujung history/)
  await call("navigate", { url: `${fx.base}/page2` })
  const b = await call("back")
  assert.equal(parseJson(resultText(b.result)).title, "Home")
  const f = await call("forward")
  assert.equal(parseJson(resultText(f.result)).title, "Page Two")
  const r = await call("reload")
  const rp = parseJson(resultText(r.result))
  assert.equal(rp.title, "Page Two")
  assert.match(rp.reloaded, /page2/)
  const s = await call("stop")
  const sp = parseJson(resultText(s.result))
  assert.equal(sp.stopped, false)
  assert.equal(sp.note, "tidak ada inflight")
})

// ===================== tabs =====================

test("tabs: list/open/focus/close riil (snapshot per tab) + error id tak dikenal", async () => {
  await call("reset")
  await call("navigate", { url: `${fx.base}/` })
  const l0 = await call("tabs_list")
  const lp0 = parseJson(resultText(l0.result))
  assert.equal(lp0.count, 1)
  assert.equal(lp0.active, "tab-1")
  const o = await call("tabs_open", { url: `${fx.base}/page2` })
  const op = parseJson(resultText(o.result))
  assert.equal(op.opened, "tab-2")
  assert.equal(op.title, "Page Two")
  const l1 = await call("tabs_list")
  const lp1 = parseJson(resultText(l1.result))
  assert.equal(lp1.count, 2)
  assert.equal(lp1.active, "tab-2")
  const saved = lp1.tabs.find((t) => t.id === "tab-1")
  assert.equal(saved.active, false)
  assert.match(saved.title, /Home/)
  // fokus balik → snapshot dipulihkan (Home), note jujur tanpa refetch
  const f = await call("tabs_focus", { id: "tab-1" })
  const fp = parseJson(resultText(f.result))
  assert.equal(fp.focused, "tab-1")
  assert.equal(fp.title, "Home")
  assert.match(fp.note, /snapshot HTML lokal/)
  // nav stack per tab: tab-1 punya history sendiri (Home dkk) setelah restore
  await call("navigate", { url: `${fx.base}/page3` })
  const b = await call("back")
  assert.equal(parseJson(resultText(b.result)).title, "Home")
  // tab-2 masih utuh
  const f2 = await call("tabs_focus", { id: "tab-2" })
  assert.equal(parseJson(resultText(f2.result)).title, "Page Two")
  // tutup tab non-aktif
  const c = await call("tabs_close", { id: "tab-1" })
  const cp = parseJson(resultText(c.result))
  assert.equal(cp.closed, "tab-1")
  assert.equal(cp.active, "tab-2")
  // tutup tab aktif terakhir → tidak ada halaman aktif
  const c2 = await call("tabs_close", { id: "tab-2" })
  const cp2 = parseJson(resultText(c2.result))
  assert.equal(cp2.active, null)
  assert.deepEqual(cp2.tabs, [])
  const gc = await call("get_content")
  assert.ok(gc.error)
  assert.match(gc.error.message, /Belum ada halaman/)
  // error path
  const e1 = await call("tabs_focus", { id: "tab-99" })
  assert.ok(e1.error)
  assert.match(e1.error.message, /Tab tidak ditemukan/)
  const e2 = await call("tabs_close", { id: "tab-99" })
  assert.ok(e2.error)
  assert.match(e2.error.message, /Tab tidak ditemukan/)
})

test("tabs_open gagal → state tab sebelumnya dipulihkan (bukan setengah-jadi)", async () => {
  await call("reset")
  await call("navigate", { url: `${fx.base}/` })
  const e = await call("tabs_open", { url: `${fx.base}/api/hello` }) // non-HTML → gagal
  assert.ok(e.error)
  assert.match(e.error.message, /navigate gagal/)
  const l = await call("tabs_list")
  const lp = parseJson(resultText(l.result))
  assert.equal(lp.count, 1)
  assert.equal(lp.active, "tab-1")
  assert.match(lp.tabs[0].title, /Home/)
  const gc = await call("get_content")
  assert.match(resultText(gc.result), /Go to page 2/)
})

// ===================== dialog =====================

test("dialog: js_eval alert TIDAK crash → antrean; list/next/dismiss", async () => {
  await call("reset")
  await call("navigate", { url: `${fx.base}/` })
  const ev = await call("evaluate", { code: "alert('halo-dialog'); confirm('ya?'); return 'ok'" })
  const evp = parseJson(resultText(ev.result))
  assert.equal(evp.result, "ok") // tidak crash — hasil eval tetap keluar
  const l = await call("dialog", { action: "list" })
  const lp = parseJson(resultText(l.result))
  assert.equal(lp.count, 2)
  assert.equal(lp.dialogs[0].type, "alert")
  assert.match(lp.dialogs[0].message, /halo-dialog/)
  assert.equal(lp.dialogs[0].dismissed, false)
  const n = await call("dialog", { action: "next" })
  assert.match(parseJson(resultText(n.result)).next.message, /halo-dialog/)
  const d = await call("dialog", { action: "dismiss" })
  assert.equal(parseJson(resultText(d.result)).dismissed.dismissed, true)
  const d2 = await call("dialog", { action: "dismiss" })
  assert.equal(parseJson(resultText(d2.result)).dismissed.type, "confirm")
  const d3 = await call("dialog", { action: "dismiss" })
  assert.equal(parseJson(resultText(d3.result)).dismissed, null)
  const e = await call("dialog", { action: "bogus" })
  assert.ok(e.error)
  assert.match(e.error.message, /list\|next\|dismiss/)
})

// ===================== files =====================

test("files: list/upload/get/drop + data URL + path error", async () => {
  await call("navigate", { url: `${fx.base}/rich` })
  const l = await call("files_list")
  const lp = parseJson(resultText(l.result))
  assert.equal(lp.count, 1)
  assert.equal(lp.items[0].id, "up")
  assert.equal(lp.items[0].multiple, false)
  const u = await call("files_upload", { selector: "#up", name: "cat.txt", content: "isi-file-123" })
  const up = parseJson(resultText(u.result))
  assert.equal(up.uploaded, "#up")
  assert.equal(up.files[0].name, "cat.txt")
  const g = await call("files_get", { selector: "#up", index: 0 })
  const gp = parseJson(resultText(g.result))
  assert.equal(gp.content, "isi-file-123")
  assert.equal(gp.name, "cat.txt")
  // attach kedua (base64) → files_get baca yang terakhir
  await call("files_upload", { selector: "#up", name: "b64.bin", base64: Buffer.from("halo-base64").toString("base64") })
  const g2 = await call("files_get", { selector: "#up" })
  assert.equal(parseJson(resultText(g2.result)).content, "halo-base64")
  // data URL langsung (tanpa selector)
  const gd = await call("files_get", { data: `data:text/plain;base64,${Buffer.from("hello-data").toString("base64")}` })
  const gdp = parseJson(resultText(gd.result))
  assert.equal(gdp.source, "data-url")
  assert.equal(gdp.content, "hello-data")
  // path error
  const e1 = await call("files_get", { selector: "#up", index: 9 })
  assert.ok(e1.error)
  assert.match(e1.error.message, /di luar jangkauan/)
  const e2 = await call("files_upload", { selector: "#up" })
  assert.ok(e2.error)
  assert.match(e2.error.message, /content atau base64/)
  const e3 = await call("files_upload", { selector: "#f1", content: "x" })
  assert.ok(e3.error)
  assert.match(e3.error.message, /input\[type=file\]/)
  const e4 = await call("files_get", { data: "bukan-data-url" })
  assert.ok(e4.error)
  assert.match(e4.error.message, /data URL valid/)
  // drop dengan polyfill DataTransfer/File
  const dr = await call("files_drop", { selector: "#dropzone", files: [{ name: "d.txt", content: "drop-isi" }] })
  const drp = parseJson(resultText(dr.result))
  assert.deepEqual(drp.events, ["dragenter", "dragover", "drop"])
  assert.equal(drp.files[0].name, "d.txt")
  const drErr = await call("files_drop", { selector: ".hilang", files: [{ name: "x", content: "y" }] })
  assert.ok(drErr.error)
  assert.match(drErr.error.message, /Elemen tidak ditemukan/)
  // halaman tanpa input file → count 0, bukan error
  await call("navigate", { url: `${fx.base}/` })
  const l2 = await call("files_list")
  assert.equal(parseJson(resultText(l2.result)).count, 0)
})

// ===================== network/trace/cpu/heap =====================

test("network_get → detail entri by index/id + error jelas", async () => {
  await call("reset")
  await call("navigate", { url: `${fx.base}/page2` })
  const m = await call("network_get", { index: 0 })
  const p = parseJson(resultText(m.result))
  assert.match(p.entry.url, /page2/)
  assert.equal(p.entry.status, 200)
  const m2 = await call("network_get", { id: `${fx.base}/page2` })
  assert.equal(parseJson(resultText(m2.result)).index, 0)
  const e1 = await call("network_get", { index: 999 })
  assert.ok(e1.error)
  assert.match(e1.error.message, /di luar jangkauan/)
  const e2 = await call("network_get", {})
  assert.ok(e2.error)
  assert.match(e2.error.message, /index atau id/)
})

test("trace: analyze/stop sebelum start → error; start→stop→analyze agregasi durasi", async () => {
  await call("reset") // reset membersihkan state closure trace juga
  const a0 = await call("trace_analyze")
  assert.ok(a0.error)
  assert.match(a0.error.message, /belum ada trace/)
  const s0 = await call("trace_stop")
  assert.ok(s0.error)
  assert.match(s0.error.message, /trace belum berjalan/)
  const st = await call("trace_start", { label: "blok-a" })
  const stp = parseJson(resultText(st.result))
  assert.equal(stp.started, true)
  assert.equal(stp.kind, "approx-timing")
  const dup = await call("trace_start")
  assert.ok(dup.error)
  assert.match(dup.error.message, /sudah berjalan/)
  const m = await call("trace_stop")
  const mp = parseJson(resultText(m.result))
  assert.equal(mp.stopped, true)
  assert.ok(mp.durationMs >= 0)
  assert.equal(mp.markCount, 2)
  const an = await call("trace_analyze")
  const ap = parseJson(resultText(an.result))
  assert.equal(ap.kind, "approx-timing")
  assert.equal(ap.markCount, 2)
  assert.ok(ap.totalMs >= 0)
  assert.equal(ap.gaps.length, 1)
  assert.equal(ap.gaps[0].from, "trace-start")
  assert.equal(ap.gaps[0].to, "trace-stop")
})

test("cpu: start/stop/analyze berlabel EXACT approx-timing (bukan CPU profiler)", async () => {
  const a0 = await call("cpu_analyze")
  assert.ok(a0.error)
  assert.match(a0.error.message, /belum ada cpu/)
  const s0 = await call("cpu_stop")
  assert.ok(s0.error)
  assert.match(s0.error.message, /cpu belum berjalan/)
  const st = await call("cpu_start", { label: "job" })
  const stp = parseJson(resultText(st.result))
  assert.equal(stp.kind, "approx-timing")
  assert.equal(stp.note, "engine js/dom: timing marks, bukan CPU profiler")
  const dup = await call("cpu_start")
  assert.ok(dup.error)
  assert.match(dup.error.message, /sudah berjalan/)
  const m = await call("cpu_stop")
  const mp = parseJson(resultText(m.result))
  assert.equal(mp.kind, "approx-timing")
  assert.equal(mp.note, "engine js/dom: timing marks, bukan CPU profiler")
  assert.ok(mp.durationMs >= 0)
  const an = await call("cpu_analyze")
  const ap = parseJson(resultText(an.result))
  assert.equal(ap.kind, "approx-timing")
  assert.equal(ap.note, "engine js/dom: timing marks, bukan CPU profiler")
  assert.ok(ap.totalMs >= 0)
  assert.equal(ap.markCount, 2)
})

test("heap_summary → heap PROSES engine (jujur, bukan heap halaman)", async () => {
  const m = await call("heap_summary")
  const p = parseJson(resultText(m.result))
  assert.equal(p.kind, "process-heap")
  assert.match(p.note, /bukan heap halaman/)
  assert.ok(typeof p.heap.used_heap_size === "number" && p.heap.used_heap_size > 0)
  assert.ok(typeof p.heap.heap_size_limit === "number")
  assert.ok(typeof p.memoryUsage.heapUsed === "number")
})

// ===================== alias & reset =====================

test("alias console → output identik console_get", async () => {
  await call("navigate", { url: `${fx.base}/` })
  const c1 = await call("console")
  const c2 = await call("console_get")
  assert.deepEqual(parseJson(resultText(c1.result)), parseJson(resultText(c2.result)))
})

test("alias network_list → output identik network_logs", async () => {
  const n1 = await call("network_list")
  const n2 = await call("network_logs")
  assert.deepEqual(parseJson(resultText(n1.result)), parseJson(resultText(n2.result)))
})

test("reset → tab/dialog/trace/cpu ikut bersih", async () => {
  await call("navigate", { url: `${fx.base}/` })
  await call("evaluate", { code: "alert('x'); return 1" })
  await call("tabs_open", { url: `${fx.base}/page2` })
  const r = await call("reset")
  assert.equal(parseJson(resultText(r.result)).reset, true)
  const l = await call("tabs_list")
  const lp = parseJson(resultText(l.result))
  assert.equal(lp.count, 0)
  assert.equal(lp.active, null)
  const d = await call("dialog")
  assert.equal(parseJson(resultText(d.result)).count, 0)
  const a = await call("trace_analyze")
  assert.ok(a.error, "state closure trace harus ikut ter-reset")
})
