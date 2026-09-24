// mcp-web — critic R4 P2: pembatalan navigate salah tuduh + sinyal pemanggil
// diclobber + kegagalan tanpa cause.
//
// P2-1: isCancel dulu terlalu luas — nama error "AbortError" SAJA dianggap
// batal navigate → script/module HALAMAN yang melempar AbortError miliknya
// (mis. fetch halaman dibatalkan halaman) mengubah navigate jadi "gagal
// Timeout setelah Xms" PALSU. Fix: batal HANYA dari state milik KITA
// (controller navigate di-abort stop/timeout ATAU flag stop) — AbortError
// halaman = error biasa → di-log, navigate TETAP SUKSES. Kontrol: AbortError
// yang datang saat state kita batal (stop atas fetch script) → TETAP batal.
//
// P2-2: fetch dengan `Request` yang SUDAH membawa sinyal sendiri — suntik
// sinyal navigate default dulu MENIMPA sinyal pemanggil (abort halaman jadi
// tak berdaya / bisa menggantung). Fix: digabung (AbortSignal.any) → abort
// PEMANGGIL dan abort navigate sama-sama berlaku.
//
// P2-3: pesan `navigate gagal` menyertakan e.cause (ECONNREFUSED dst) —
// rantai bukti akar kegagalan jangan putus (HUKUM 11).
//
// Test DETERMINISTIK: stub fetch ber-promise-pending sampai release()/abort
// (gate = stub itu sendiri, tanpa server, tanpa tidur acak) + watchdog.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import { createJsPage } from "../src/engine-js.js"
import { createPage } from "../src/browser.js"

// Fixture test ada di 127.0.0.1 → izinkan target private.
process.env.MCWEB_ALLOW_PRIVATE = "1"

const outcome = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

async function raced(p, ms) {
  let t
  const wd = new Promise((r) => { t = setTimeout(() => r({ watchdog: true }), ms) })
  const out = await Promise.race([p, wd])
  clearTimeout(t)
  return out
}

async function until(cond, ms, msg) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(msg)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const DOC = "https://site.test/dir/page.html"

const cacheDirs = []
function freshPage(waitMs = 50) {
  const dir = path.join(os.tmpdir(), `mcpweb-r4-p2-${process.pid}-${cacheDirs.length + 1}`)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* belum ada */ }
  cacheDirs.push(dir)
  return createJsPage({ cacheDir: dir, waitMs })
}
after(() => {
  for (const d of cacheDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ } }
})

// ===================== stub fetch =====================
// Halaman: html + script yang melempar AbortError MILIKNYA (tanpa stop,
// tanpa timeout) — reproduksi P2-1.
const HTML_CLASSIC_ABORT = `<!doctype html><html><head><title>OwnAbort</title>
<script src="/own-abort.js"></script></head><body><p>p2-1</p></body></html>`
const SCRIPT_OWN_ABORT = `throw Object.assign(new Error("x"), { name: "AbortError" });`
const HTML_MODULE_ABORT = `<!doctype html><html><head><title>ModAbort</title>
<script type="module" src="/mod-abort.js"></script></head><body><p>p2-1m</p></body></html>`
const MODULE_OWN_ABORT = `throw Object.assign(new Error("x"), { name: "AbortError" });`

// fetch stub: dokumen resolve; `gated:true` → URL gate ditahan (pending
// sampai release/abort — pola tests/stop-settle-hang.test.js); `gated:false`
// → URL gate langsung diserve script (untuk skenario script yang melempar
// AbortError MILIKNYA sendiri tanpa hambatan).
function makeStub({ html, gateEndsWith, script, gated = true }) {
  const calls = []
  let release
  const released = new Promise((r) => { release = r })
  let releasedFlag = false

  const fetchStub = (input, init = {}) => {
    const url = String(input)
    const signal = (init && init.signal) || null
    calls.push({ url, signal })
    if (gateEndsWith && url.endsWith(gateEndsWith) && gated) {
      return new Promise((resolve, reject) => {
        let settled = false
        released.then(() => {
          if (settled) return
          settled = true
          resolve(new Response(script, { status: 200, headers: { "content-type": "application/javascript" } }))
        })
        if (!signal) return // TANPA signal: gantung selamanya
        const onAbort = () => {
          if (settled) return
          settled = true
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
        }
        if (signal.aborted) return onAbort()
        signal.addEventListener("abort", onAbort, { once: true })
      })
    }
    return Promise.resolve(
      gateEndsWith && url.endsWith(gateEndsWith)
        ? new Response(script, { status: 200, headers: { "content-type": "application/javascript" } })
        : new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    )
  }
  return {
    fetch: fetchStub,
    calls,
    gateCalls: () => calls.filter((c) => gateEndsWith && c.url.endsWith(gateEndsWith)),
    release: () => { releasedFlag = true; release() },
    get released() { return releasedFlag },
  }
}

// ===================== P2-1-a: classic script AbortError MILIK halaman =====================

test("P2-1-a: script halaman melempar AbortError sendiri (tanpa stop/timeout) → navigate SUKSES + log galat (bukan 'Timeout')", async () => {
  const page = freshPage()
  const stub = makeStub({ html: HTML_CLASSIC_ABORT, gateEndsWith: "/own-abort.js", script: SCRIPT_OWN_ABORT, gated: false })
  page._fetch = stub.fetch
  const r = await raced(outcome(page.navigate(DOC, { timeoutMs: 30000, waitMs: 50 })), 15000)
  assert.ok(!r.watchdog, "navigate menggantung — AbortError halaman tak boleh menggantungkan apa pun")
  assert.equal(r.ok, true,
    `navigate TANPA stop/TANPA timeout wajib SUKSES walau script melempar AbortError — dapat: ${r.ok ? "" : r.e.message}`)
  assert.equal(r.v.status, 200)
  assert.equal(r.v.title, "OwnAbort")
  const logs = page.consoleLogs.slice()
  assert.ok(logs.some((l) => l.level === "error" && /classic script gagal/.test(l.message)),
    `AbortError halaman wajib tercatat sebagai log galat script, logs: ${JSON.stringify(logs.map((l) => l.message))}`)
  assert.ok(!logs.some((l) => /Timeout setelah/.test(l.message)),
    `TANPA timeout → jangan ada klaim 'Timeout setelah Xms', logs: ${JSON.stringify(logs.map((l) => l.message))}`)
  assert.ok(!logs.some((l) => /dibatalkan oleh stop/.test(l.message)),
    "TANPA stop → jangan ada klaim 'dibatalkan oleh stop'")
})

// ===================== P2-1-b: module AbortError MILIK halaman =====================

test("P2-1-b: module halaman melempar AbortError sendiri → navigate SUKSES + log 'module gagal'", async () => {
  const page = freshPage()
  const stub = makeStub({ html: HTML_MODULE_ABORT, gateEndsWith: "/mod-abort.js", script: MODULE_OWN_ABORT, gated: false })
  page._fetch = stub.fetch
  const r = await raced(outcome(page.navigate(DOC, { timeoutMs: 30000, waitMs: 50 })), 15000)
  assert.ok(!r.watchdog, "navigate menggantung — AbortError module tak boleh menggantungkan apa pun")
  assert.equal(r.ok, true,
    `navigate TANPA stop/TANPA timeout wajib SUKSES walau module melempar AbortError — dapat: ${r.ok ? "" : r.e.message}`)
  const logs = page.consoleLogs.slice()
  assert.ok(logs.some((l) => l.level === "error" && /module gagal/.test(l.message)),
    `AbortError module wajib tercatat sebagai log galat module, logs: ${JSON.stringify(logs.map((l) => l.message))}`)
  assert.ok(!logs.some((l) => /Timeout setelah|dibatalkan oleh stop/.test(l.message)),
    `jangan ada klaim batal/timeout palsu, logs: ${JSON.stringify(logs.map((l) => l.message))}`)
})

// ===================== P2-1 kontrol: state KITA batal → TETAP batal =====================

test("P2-1-kontrol: AbortError datang saat stop membatalkan fetch script → navigate TETAP 'dibatalkan oleh stop' (bukan sukses)", async () => {
  const page = freshPage()
  const stub = makeStub({ html: HTML_CLASSIC_ABORT, gateEndsWith: "/own-abort.js", script: SCRIPT_OWN_ABORT })
  page._fetch = stub.fetch
  const out = outcome(page.navigate(DOC, { timeoutMs: 30000, waitMs: 50 }))
  try {
    await until(() => stub.gateCalls().length > 0, 15000, "fetch script tak pernah dipanggil (stub rusak)")
    // stop = pola persis src/tools.js (tandai flag dulu, lalu abort).
    page._abort.__mcpStoppedByStop = true
    page._abort.abort()
    const r = await raced(out, 10000)
    assert.ok(!r.watchdog, "navigate menggantung setelah stop")
    assert.equal(r.ok, false, "stop atas fetch script → navigate wajib BATAL (isCancel baca state kita)")
    assert.match(r.e.message, /dibatalkan oleh stop/)
    assert.ok(!/Timeout setelah/.test(r.e.message), "bukan pesan timeout — ini diminta stop")
  } finally {
    stub.release()
  }
})

// ===================== P2-2: Request bersignal sendiri — sinyal pemanggil dihormati =====================

// Stub yang menggantung sampai signal (mirip undici): tanpa signal = gantung
// selamanya (reproduksi bug: sinyal pemanggil ditimpa → tak berdaya).
function hangUntilSignal(calls) {
  return (input, init = {}) => {
    const url = String(input)
    // undici memakai init.signal bila ada; input Request punya signal sendiri.
    const sig = (init && init.signal) || null
    calls.push({ url, initSignal: sig, inputSignal: (input && input.signal) || null })
    return new Promise((_, reject) => {
      if (!sig) return // TANPA signal di init: gantung selamanya = detektor mutasi
      const onAbort = () => reject(sig.reason ?? Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
      if (sig.aborted) return onAbort()
      sig.addEventListener("abort", onAbort, { once: true })
    })
  }
}

test("P2-2-a: fetch(Request bersignal pemanggil) + abort PEMANGGIL saat navigate aktif → fetch REJECT sesuai sinyal pemanggil (bukan menggantung)", async () => {
  const page = freshPage()
  const calls = []
  page._fetch = hangUntilSignal(calls)
  page._abort = new AbortController() // simulasi navigate berjalan (fase settle)
  const ac = new AbortController()
  const p = outcome(page._trackedFetch(new Request("https://site.test/api", { signal: ac.signal })))
  try {
    await until(() => calls.length > 0, 10000, "fetch tak pernah dipanggil (stub rusak)")
    assert.ok(calls[0].initSignal, "P2-2: fetch TANPA signal di init → sinyal pemanggil tak terbawa (bug reproduksi)")
    ac.abort(new Error("caller-cancel"))
    const r = await raced(p, 5000)
    assert.ok(!r.watchdog,
      "MASIH MENGANTUNG setelah abort PEMANGGIL — sinyal Request ditimpa sinyal navigate (P2-2 reproduksi)")
    assert.equal(r.ok, false, "abort pemanggil → fetch wajib REJECT")
    assert.match(String(r.e?.message || r.e), /caller-cancel/,
      `reason wajib dari sinyal PEMANGGIL, dapat: ${r.e?.message || r.e}`)
  } finally {
    page._abort = null
  }
})

test("P2-2-b kontrol: fetch(Request bersignal pemanggil) + abort NAVIGATE → fetch tetap REJECT (gabungan sinyal, bukan menggantung)", async () => {
  const page = freshPage()
  const calls = []
  page._fetch = hangUntilSignal(calls)
  page._abort = new AbortController() // navigate berjalan
  const ac = new AbortController()    // sinyal pemanggil (tak pernah diabort)
  const p = outcome(page._trackedFetch(new Request("https://site.test/api", { signal: ac.signal })))
  try {
    await until(() => calls.length > 0, 10000, "fetch tak pernah dipanggil (stub rusak)")
    page._abort.abort() // navigate dibatalkan (stop/timeout)
    const r = await raced(p, 5000)
    assert.ok(!r.watchdog, "MASIH MENGANTUNG setelah abort navigate — gabungan sinyal gagal")
    assert.equal(r.ok, false, "abort navigate → fetch wajib REJECT (bukan sukses, bukan menggantung)")
  } finally {
    page._abort = null
  }
})

// ===================== P2-3: e.cause ikut di pesan navigate gagal =====================

test("P2-3: ECONNREFUSED (engine js & dom) → pesan 'navigate gagal' menyertakan cause (rantai bukti utuh)", async () => {
  // Port terbuka lalu ditutup → connect pasti ECONNREFUSED.
  const srv = http.createServer(() => {})
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  const url = `http://127.0.0.1:${port}/`

  const jsPage = freshPage()
  const rJs = await raced(outcome(jsPage.navigate(url, { timeoutMs: 5000 })), 15000)
  assert.ok(!rJs.watchdog, "navigate ECONNREFUSED menggantung")
  assert.equal(rJs.ok, false, "port mati → navigate wajib gagal")
  assert.match(rJs.e.message, /navigate gagal/)
  assert.match(rJs.e.message, /cause:/, `engine js: e.cause wajib ikut, dapat: ${rJs.e.message}`)
  assert.match(rJs.e.message, /ECONNREFUSED/, `engine js: cause wajib menunjuk akar (ECONNREFUSED), dapat: ${rJs.e.message}`)

  const domPage = createPage()
  const rDom = await raced(outcome(domPage.navigate(url, { timeoutMs: 5000 })), 15000)
  assert.ok(!rDom.watchdog, "navigate dom ECONNREFUSED menggantung")
  console.error("DEBUG rDom=", JSON.stringify(rDom.ok ? rDom.v : { err: String(rDom.e) }).slice(0, 400))
  assert.equal(rDom.ok, false, "port mati → navigate dom wajib gagal")
  assert.match(rDom.e.message, /navigate gagal/)
  assert.match(rDom.e.message, /cause:/, `engine dom: e.cause wajib ikut, dapat: ${rDom.e.message}`)
  assert.match(rDom.e.message, /ECONNREFUSED/, `engine dom: cause wajib menunjuk akar, dapat: ${rDom.e.message}`)
})
