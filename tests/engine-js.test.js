// Engine JS (jsdom + module import) — buktikan:
// 1. classic script dieksekusi (title berubah)
// 2. ES module dieksekusi (listener terpasang)
// 3. click membuka modal (JS hidup)
// 4. js_eval konteks halaman
// 5. reset
import test from "node:test"
import assert from "node:assert/strict"
import { createJsPage } from "../src/engine-js.js"
import { startFixtureServer } from "./fixtures/live-server.js"

// Fixture test ada di 127.0.0.1 → izinkan target private di proses test ini.
process.env.MCWEB_ALLOW_PRIVATE = "1"

// Snapshot global Node SEBELUM test apa pun mem-patch — dipakai test unpatch.
const PRISTINE_FETCH = globalThis.fetch
const PRISTINE_HAS_DOCUMENT = Object.prototype.hasOwnProperty.call(globalThis, "document")

let fx
test.before(async () => {
  fx = await startFixtureServer()
})

test.after(() => {
  fx.server.close()
})

// JsPage menulis cache module ke ~/.cache/mcp-web — pakai dir sementara per test.
// CATATAN: jangan hardcode "/tmp" — Di Termux /tmp tidak ada (os.tmpdir() → $PREFIX/usr/tmp).
import path from "path"
import os from "os"
    function freshPage() {
  const dir = path.join(os.tmpdir(), "mcpweb-test-modules")
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  return createJsPage({ cacheDir: dir, waitMs: 400 })
}

test("js engine: navigate → classic script jalan (title berubah)", async () => {
  const page = freshPage()
  const s = await page.navigate(fx.url)
  assert.equal(s.status, 200)
  assert.equal(s.title, "Classic OK") // classic.js mengubah title
  assert.equal(s.engine, "jsdom (JS hidup)")
})

test("js engine: module script dieksekusi (__moduleRan & __appReady)", async () => {
  const page = freshPage()
  await page.navigate(fx.url)
  // module men-set window.__moduleRan — baca lewat konteks halaman
  const ran = page.window.eval("window.__moduleRan")
  const ready = page.window.eval("window.__appReady")
  assert.equal(ran, 1)
  assert.equal(ready, true)
})

test("js engine: click membuka modal (listener halaman DIEKSEKUSI)", async () => {
  const page = freshPage()
  await page.navigate(fx.url)
  const modal = page.document.querySelector("#modal")
  assert.equal(modal.classList.contains("open"), false)
  page.document.querySelector("#btn").click() // event listener app.js jalan
  assert.equal(modal.classList.contains("open"), true)
  assert.equal(modal.textContent.trim(), "MODAL TERBUKA")
})

test("js engine: reload halaman → state module di-reset (cache-busting)", async () => {
  const page = freshPage()
  await page.navigate(fx.url)
  let ran = page.window.eval("window.__moduleRan")
  assert.equal(ran, 1)
  await page.navigate(fx.url) // load ulang
  ran = page.window.eval("window.__moduleRan")
  assert.equal(ran, 1) // bukan 2 — module dieksekusi ulang di window baru
})

test("js engine: js_eval dieksekusi di konteks halaman (DOM berubah)", async () => {
  const page = freshPage()
  await page.navigate(fx.url)
  const out = page.window.eval("document.querySelector('#name').value = 'Nemo'; document.querySelector('#name').value")
  assert.equal(out, "Nemo")
})

test("js engine: console & network logs terekam", async () => {
  const page = freshPage()
  await page.navigate(fx.url)
  assert.ok(page.consoleLogs.length > 0, "ada console log")
  assert.ok(page.networkLogs.some((n) => n.status === 200), "ada request 200")
  const s = page.summary()
  assert.equal(s.title, "Classic OK")
})

test("js engine: reset mengosongkan state", async () => {
  const page = freshPage()
  await page.navigate(fx.url)
  page.reset()
  assert.equal(page.document, null)
  assert.equal(page.history.length, 0)
  assert.equal(page.consoleLogs.length, 0)
})

// Subdir module: prefix mirror harus konsisten (filename) — reproduksi bug
// situs dgn struktur subfolder (dulu: specifier ./load1-child.js vs file
// child.js → ERR_MODULE_NOT_FOUND, app tak boot).
test("js engine: module subdir (deep/app.js → ./child.js) dieksekusi", async () => {
  const page = freshPage()
  await page.navigate(fx.url + "deep/")
  assert.equal(page.window.__deepReady, "DEEP_OK")
  assert.ok(page.consoleLogs.some((l) => /module loaded/.test(l.message)), "module loaded tercatat")
})

// jsdom AbortSignal ≠ Node AbortSignal — undici menolak instance asing tanpa
// bridge di _trackedFetch (reproduksi: semua RPC POST status 0 "Expected
// signal ... instance of AbortSignal" → app "You're offline").
test("js engine: fetch dgn jsdom AbortSignal tidak ditolak (bridge)", async () => {
  const page = freshPage()
  await page.navigate(fx.url)
  const ac = new page.window.AbortController() // signal = milik jsdom
  const url = new page.window.URL("classic.js", fx.url).toString() // app selalu pakai URL absolut
  const res = await page.window.fetch(url, { signal: ac.signal })
  assert.equal(res.status, 200)
  const ac2 = new page.window.AbortController()
  ac2.abort() // aborted dahulu — bridge harus meneruskan abort, bukan throw kelas
  await assert.rejects(() => page.window.fetch(url, { signal: ac2.signal }))
})

// WAJIB terakhir: memakai snapshot pristine dari awal file (test sebelumnya
// meninggalkan global ter-patch) — reset() harus mengembalikan ke aslinya.
test("js engine: reset meng-unpatch global (fetch/document kembali asli)", async () => {
  const page = freshPage()
  await page.navigate(fx.url)
  const patchedFetch = globalThis.fetch // masih ter-patch (window fetch) — belum di-reset
  page.reset() // global ter-patch saat navigate → wajib dipulihkan
  assert.equal(globalThis.fetch, PRISTINE_FETCH) // fetch kembali ASLI proses
  assert.notEqual(page._fetch, patchedFetch) // _fetch TIDAK rebind fetch hasil patch
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, "document"), PRISTINE_HAS_DOCUMENT)
})