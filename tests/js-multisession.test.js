// tests/js-multisession.test.js — P1 R6: engine js multi-SESI (serve --js ≥2 klien).
// `globalThis` cuma satu per proses → tanpa isolasi, navigate dua sesi PARALEL
// balapan patch global: module sesi A dieksekusi saat global menunjuk halaman
// sesi B (bleed silang SENYAP — bukti critic probe-js2/js3: document.title
// "B|MOD|MOD", halaman A tak pernah di-boot) dan reset() sesi A melepas patch
// milik sesi B (globalThis.document = undefined padahal B masih hidup).
// FIX yang diuji MEKANISMEnya di sini:
//   (1) navigasi engine js diserialkan lewat antrean global TUNGGAL
//       (withJsLock, src/engine-js.js) + patch global berswap PEMILIK per page;
//   (2) reset() hanya mengembalikan global bila page itu pemiliknya (GLOBAL_OWNER).
// Kunci regresi: module A sengaja LAMBAT (200ms) — tanpa kunci, import A pasti
// jalan setelah sesi B mengambil alih global → bleed DETERMINISTIK (merah), bukan
// kebetulan hijau.
import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.MCWEB_ALLOW_PRIVATE = "1"
const { createJsPage } = await import("../src/engine-js.js")
const { createPage: createDomPage } = await import("../src/browser.js")

const MOD = 'document.title = document.title + "|MOD";'
let srv
let base
let cacheSeq = 0

function freshCacheDir() {
  const dir = path.join(os.tmpdir(), "mw-multisession-" + ++cacheSeq)
  fs.rmSync(dir, { recursive: true, force: true })
  return dir
}
const titles = (A, B) => `document.title A=${JSON.stringify(A.document && A.document.title)} B=${JSON.stringify(B.document && B.document.title)}`

test.before(async () => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1")
    if (u.pathname === "/ma.js") {
      // module A sengaja LAMBAT → tanpa kunci, eksekusinya jatuh SETELAH sesi B
      // mengambil alih globalThis (bleed deterministik untuk regresi).
      const t = setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/javascript" })
        res.end(MOD)
      }, 200)
      if (typeof t.unref === "function") t.unref()
      return
    }
    if (u.pathname === "/mb.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" })
      res.end(MOD)
      return
    }
    const name = u.pathname === "/b" ? "B" : "A"
    const mod = u.pathname === "/b" ? "/mb.js" : "/ma.js"
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(`<!doctype html><html><head><title>${name}</title><script type="module" src="${mod}"></script></head><body>${name}</body></html>`)
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${srv.address().port}`
})

test.after(() => {
  srv.closeAllConnections?.()
  srv.close()
})

test("R6-1: 2 sesi engine js navigasi PARALEL → module masing-masing dieksekusi TEPAT 1× ke halaman SENDIRI", async () => {
  const cacheDir = freshCacheDir() // dua sesi = dua JsPage (pola probe critic: 2 klien serve --js)
  const A = createJsPage({ cacheDir, waitMs: 50 })
  const B = createJsPage({ cacheDir, waitMs: 50 })
  await Promise.all([A.navigate(`${base}/a`), B.navigate(`${base}/b`)])

  assert.equal(A.document.title, "A|MOD", `halaman A wajib dapat module A tepat 1× — ${titles(A, B)}`)
  assert.equal(B.document.title, "B|MOD", `halaman B wajib dapat module B tepat 1× — ${titles(A, B)}`)
  assert.equal((A.document.title.match(/\|MOD/g) || []).length, 1, "module A TIDAK boleh dobel di halaman A")
  assert.equal((B.document.title.match(/\|MOD/g) || []).length, 1, "module B TIDAK boleh dobel di halaman B")
  // field title (dipakai summary/preview) ikut ter-update dari document.title sendiri
  assert.equal(A.title, "A|MOD", `title sesi A = halamannya sendiri — ${titles(A, B)}`)
  assert.equal(B.title, "B|MOD", `title sesi B = halamannya sendiri — ${titles(A, B)}`)
  // tiap sesi mencatat module-nya sendiri (bukan dobel, bukan milik sesi lain)
  assert.equal(A.consoleLogs.filter((l) => /module loaded/.test(l.message)).length, 1, "log sesi A: tepat 1 module loaded")
  assert.equal(B.consoleLogs.filter((l) => /module loaded/.test(l.message)).length, 1, "log sesi B: tepat 1 module loaded")
  assert.ok(A.consoleLogs.some((l) => /ma\.js/.test(l.message)), "sesi A memuat module /ma.js")
  assert.ok(B.consoleLogs.some((l) => /mb\.js/.test(l.message)), "sesi B memuat module /mb.js")
  A.reset()
  B.reset()
})

test("R6-2: reset sesi A TIDAK melepas patch global milik sesi B (kepemilikan per page)", async () => {
  const cacheDir = freshCacheDir()
  const A = createJsPage({ cacheDir, waitMs: 50 })
  const B = createJsPage({ cacheDir, waitMs: 50 })
  await A.navigate(`${base}/a`)
  await B.navigate(`${base}/b`) // B navigasi terakhir → pemilik globalThis

  assert.equal(globalThis.document, B.document, "pemilik global = sesi B (navigate paling akhir)")
  A.reset() // dulu: restoreGlobals GLOBAL → patch B ikut hilang
  assert.equal(globalThis.document, B.document, "reset sesi A wajib MEMPERTAHANKAN patch milik sesi B")
  assert.equal(globalThis.document.title, "B|MOD", "halaman B + efek module B tetap utuh setelah A.reset()")
  assert.ok(B.document && B.window, "state halaman B tetap hidup")

  B.reset() // pemiliknya sendiri → global kembali pristine
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, "document"), false, "reset PEMILIK → global kembali seperti aslinya Node")
  assert.equal(globalThis.document, undefined, "sesudah kedua sesi reset: tanpa document di global")
})

test("R6-3: engine dom TIDAK memakai fetch global (global ter-patch engine js tetap tak beracun bagi dom)", async () => {
  const cacheDir = freshCacheDir()
  const jsA = createJsPage({ cacheDir, waitMs: 50 })
  await jsA.navigate(`${base}/a`) // sesi js mem-PATCH globalThis (owner = A)
  assert.equal(globalThis.document, jsA.document, "prasyarat: global memang ter-patch sesi js")

  // Racuni global: fetch milik sesi js kini menjawab STUB (pola regresi
  // tests/abort-mislabel.test.js P2-3 — dulu navigate dom ikut memakainya).
  const domPage = createDomPage()
  jsA._fetch = async () => new Response("<!doctype html><html><head><title>STUB-SESAL</title></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } })

  // port mati → engine dom wajib ECONNREFUSED dari fetch ASLI proses,
  // bukan 200-STUB dari fetch global yang ter-patch sesi js.
  const srv = http.createServer(() => {})
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const deadPort = srv.address().port
  await new Promise((r) => srv.close(r))
  await assert.rejects(
    () => domPage.navigate(`http://127.0.0.1:${deadPort}/`, { timeoutMs: 5000 }),
    /navigate gagal.*ECONNREFUSED/,
    "navigate dom memakai fetch global ter-patch sesi js (bleed silang-engine)",
  )
  jsA.reset() // owner → global bersih lagi
  assert.equal(Object.prototype.hasOwnProperty.call(globalThis, "document"), false)
})
