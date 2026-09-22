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