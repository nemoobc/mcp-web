// WebDrive MCP — engine "live JS".
// Browser sungguhan TANPA binary browser: jsdom (DOM + event + classic scripts)
// + eksekusi ES module via Node import() dengan global diarahkan ke window.
// Hasil POC terbukti: SPA (Bear-Tool) hidup — klik membuka modal, ethers jalan.
// Catatan keamanan: mode ini mengeksekusi script situs (seperti browser).
// Hanya gunakan untuk situs tepercaya.
import { JSDOM, VirtualConsole } from "jsdom"
import { pathToFileURL } from "url"
import path from "path"
import fs from "fs"
import os from "os"
import { CookieJar } from "./cookies.js"
import { CappedArray } from "./logs.js"
import { ASSET_TIMEOUT_MS } from "./assets.js"
import { assertSafeTarget } from "./security.js"
import { McpError, SERVER_INFO } from "./protocol.js"

const CACHE_ROOT = path.join(os.homedir(), ".cache", "mcp-web", "js-modules")

// Fetch ASLI proses — SATU sumber kebenaran di src/pristine.js (disnapshot saat
// boot, SEBELUM patch pertama). Tanpa ini, reset() bisa mengambil fetch hasil
// patch → wrap dobel/rekursi.
import { PRISTINE_FETCH as ORIGINAL_FETCH } from "./pristine.js"

// Snapshot descriptor global asli (sekali, sebelum patch pertama) →
// supaya reset() bisa mengembalikan keadaan Node persis seperti semula.
const GLOBAL_SNAPSHOT = new Map()

function captureGlobal(g, key) {
  if (!GLOBAL_SNAPSHOT.has(key)) GLOBAL_SNAPSHOT.set(key, Object.getOwnPropertyDescriptor(g, key) ?? null)
}

function restoreGlobals(g) {
  for (const [key, desc] of GLOBAL_SNAPSHOT) {
    try {
      if (desc) Object.defineProperty(g, key, desc)
      else delete g[key]
    } catch {}
  }
  GLOBAL_SNAPSHOT.clear()
}

// --- isolasi antar-SESI engine js (P1 R6) -----------------------------------
// `globalThis` cuma ADA SATU per proses, sedangkan `serve --js` melayani banyak
// klien (tiap klien = satu JsPage/createTools). Tanpa aturan, dua navigate
// PARALEL balapan menyalin document/window ke global → module session A jalan
// saat global menunjuk halaman session B (bleed silang SENYAP; bukti critic:
// probe-js2/js3 → B.document.title = "B|MOD|MOD", halaman A tak pernah
// di-boot), dan reset() session A ikut melepas patch milik session B.
// Dua kunci (pilihan A di VERDICT R6 — isolasi benar, bukan cuma fail-fast):
//   (1) SERIALISASI: SEMUA navigate engine js lewat antrean global TUNGGAL
//       (withJsLock) → satu navigate selesai penuh (fetch → classic → import
//       module → wait → patch akhir) sebelum navigate berikutnya mulai. Patch
//       global DI-SWAP per navigasi dan module hanya di-import ketika global
//       sudah menunjuk HALAMAN ITU → tiap module dieksekusi TEPAT 1x ke
//       halamannya sendiri, walau 2 sesi navigasi bersamaan.
//   (2) KEPEMILIKAN: GLOBAL_OWNER = page pemilik patch global saat ini.
//       reset() sesi LAIN tidak akan mengembalikan global (patch tetap milik
//       pemiliknya); sesi berikutnya menukar kepemilikan secara sadar.
// Batas jujur: kode module yang menunda eksekusi (setInterval/callback dengan
// identifier global telanjang) jalan SETELAH navigate selesai — saat itu global
// boleh sudah milik sesi lain. Yang dijamin bebas bleed = fase boot module.
let GLOBAL_OWNER = null
let JS_LOCK = Promise.resolve()

// Antrean tunggal lintas-sesi: fn dijalankan setelah navigate sebelumnya
// selesai (sukses ATAU gagal — rantai tidak pernah putus/mati).
export function withJsLock(fn) {
  const run = JS_LOCK.then(() => fn())
  JS_LOCK = run.then(() => {}, () => {})
  return run
}

export const MAX_REDIRECTS = 10 // hop redirect maksimum — anti loop tanpa batas

// Counter MONOTONIK PROSES-GLOBAL utk cache-busting module:
// Node ESM import() meng-cache per URL (?load=...). Kalau _loadId per-instance
// (reset ke 0 tiap page), DUA test dlm SATU proses pakai URL ?load=1 SAMA →
// Node balikan module cached TANPA re-execute → state bocor/listener tak jalan.
// Counter global → tiap navigate URL ?load= UNIK → import() selalu fresh.
let PROCESS_LOAD_SEQ = 0

// Pola import relatif di module (untuk mirror + rewrite).
const REL_IMPORT_RE = /(from\s*|import\s*\(\s*)(['"])(\.\/[^'"]+)\2/g

// --- pembatalan I/O FASE SETTLE (stop & timeoutMs) ---
// Root cause P1 R3: fetch script klasik (loop di navigate → _trackedFetch) dan
// mirror module (this._fetch) dipanggil TANPA `signal` = "abort-kebal" → stop
// melapor {stopped:true} tapi navigate menggantung, timeoutMs juga tak berlaku.
// Kini signal navigate DIWARISKAN ke semua fetch settle; helper di bawah
// menutup sisa I/O yang tak bisa di-signal (Node import() module) + mencegah
// AbortError tertelan catch biasa.
// P2-1 R4: batal HANYA dari state milik KITA (controller navigate di-abort
// stop/timeout ATAU flag stop) — nama error "AbortError" SAJA tidak cukup:
// script/module HALAMAN boleh melempar AbortError miliknya sendiri (mis.
// fetch dibatalkan halaman) → itu error halaman biasa, jangan diubah jadi
// "pembatalan navigate" (dulu: navigate gagal PALSU "Timeout setelah Xms").
function isCancel(controller) {
  return !!controller?.signal?.aborted || !!controller?.__mcpStoppedByStop
}

// Error batal standar → jatuh ke catch navigate yang membedakan
// "dibatalkan oleh stop" (flag) vs "Timeout setelah Xms" (timer abort).
function cancelError(controller, label = "dibatalkan") {
  const e = new Error(controller?.__mcpStoppedByStop ? "dibatalkan oleh stop" : label)
  e.name = "AbortError"
  return e
}

// Race I/O fase settle terhadap abort navigate: I/O TANPA signal (mis.
// import() module graph) ikut berhenti saat stop/timeout, bukan menggantung.
function raceAbort(p, controller, label) {
  if (!controller) return p
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelError(controller, label))
    if (controller.signal.aborted) return onAbort()
    controller.signal.addEventListener("abort", onAbort, { once: true })
    p.then(
      (v) => { controller.signal.removeEventListener("abort", onAbort); resolve(v) },
      (e) => { controller.signal.removeEventListener("abort", onAbort); reject(e) },
    )
  })
}

// jsdom v30 punya property read-only (mis. crypto) — assign aman dengan fallback defineProperty.
function defProp(target, key, value) {
  try {
    target[key] = value
  } catch {
    try {
      Object.defineProperty(target, key, { value, configurable: true, writable: true })
    } catch {}
  }
}

export class JsPage {
  constructor({ cacheDir = CACHE_ROOT, waitMs = 1200 } = {}) {
    this.cacheDir = cacheDir
    this.waitMs = waitMs
    this.isJs = true
    this.reset()
  }

  reset() {
    // Kembalikan global Node yang ter-patch (document/window/fetch/dst) ke
    // aslinya HANYA bila patch itu MILIK page ini — reset sesi A tak boleh
    // melepas patch milik sesi B yang sedang/ baru hidup (P1 R6; bukti lama:
    // sesudah A.reset() → globalThis.document = undefined padahal B masih
    // navigasi). global snapshot/owner memang berbagi SATU per proses.
    if (GLOBAL_OWNER === this) {
      restoreGlobals(globalThis)
      GLOBAL_OWNER = null
    }
    this.window = null
    this.document = null
    this.currentUrl = null
    this._stylesFor = null
    this._styleFailed = [] // alasan stylesheet gagal (P1 R4) utk `notes` screenshot
    this.status = null
    this.headers = {}
    this.redirects = []
    this.timing = null
    this.consoleLogs = new CappedArray() // dibatasi LOG_CAP — buang entri paling lama
    this.networkLogs = new CappedArray()
    this.history = []
    this.historyIndex = -1
    this.cookies = new CookieJar()
    this.title = ""
    this._fetch = ORIGINAL_FETCH // selalu fetch ASLI, bukan hasil patch
    // Multi-tab: map id → snapshot tab NON-aktif (lihat src/browser.js — model sama).
    this.tabs = new Map()
    this.activeTabId = null
    this.tabSeq = 0
    this.dialogQueue = [] // antrian dialog (alert/confirm/prompt) — tool `dialog`
    this._inflight = null // {url, startedAt, phase:'fetch'|'settle'} navigasi berjalan — tool `stop`
    this._abort = null // AbortController navigasi berjalan — tool `stop`
    this._shotCtl = null // AbortController tool screenshot — `stop` boleh membatalkan fetch aset (P2-4 R5)
  }

  // Rekam dialog halaman. alert/confirm/prompt di-hook ke sini — js_eval /
  // script halaman tak pernah crash hanya karena memanggil alert.
  _pushDialog(type, message) {
    const entry = { type, message: String(message ?? "").slice(0, 500), at: Date.now(), dismissed: false }
    if (!Array.isArray(this.dialogQueue)) this.dialogQueue = []
    this.dialogQueue.push(entry)
    this.consoleLogs.push({ level: "warn", message: `${type}: ${entry.message}` })
    return entry
  }

  // --- cookie store (delegasi ke CookieJar: Domain/Path/Secure/Expires dihormati) ---
  storeCookies(url, setCookieHeader) {
    this.cookies.add(url, setCookieHeader)
  }

  cookieHeader(url) {
    return this.cookies.header(url)
  }

  // Listing hanya cookie yang berlaku untuk host halaman current — bukan semua domain.
  getCookiesForCurrent() {
    return this.currentUrl ? this.cookies.listFor(this.currentUrl) : []
  }

  clearCookies() {
    this.cookies.clear()
    return this.cookies.size === 0
  }

  // --- fetch yang dicatat ke network log ---
  async _trackedFetch(input, init = {}) {
    const requestUrl = typeof input === "string" ? input : input?.url || String(input)
    const method = (init?.method || input?.method || "GET").toUpperCase()
    const start = Date.now()
    try {
      // jsdom AbortSignal ≠ Node AbortSignal — undici (this._fetch = Node
      // fetch) menolak instance asing ("Expected signal ... instance of
      // AbortSignal"). Jembatankan: propagate abort ke AbortController Node.
      let opts = init
      // Fetch fase settle tanpa signal caller (fetch halaman via w.fetch,
      // stylesheet, dst) → wirkan signal navigate berjalan (this._abort):
      // stop/timeout MENUTUP I/O ini, bukan cuma menandai flag. Signal caller
      // sendiri (mis. jsdom) dihormati — jangan ditimpa.
      // P2-2 R4: `input` bisa berupa Request yang SUDAH membawa sinyal sendiri
      // (sinyal ada di input, bukan init) — undici memakai init.signal bila ada,
      // jadi suntik default DULU MENIMPA sinyal pemanggil (abort halaman jadi
      // tak berdaya). Kini digabung (AbortSignal.any) supaya abort PEMANGGIL
      // dan abort navigate sama-sama berlaku; gagal gabung (sinyal asing) →
      // tanpa suntik → sinyal input menang apa adanya.
      const inputSignal = (input && typeof input === "object" && input.signal) ? input.signal : null
      if ((!opts || !opts.signal) && this._abort && this._abort.signal) {
        if (inputSignal) {
          let merged = null
          try { merged = AbortSignal.any([inputSignal, this._abort.signal]) } catch { /* sinyal asing → tanpa suntik */ }
          if (merged) opts = { ...(opts || {}), signal: merged }
          // tanpa merged → opts TANPA signal → undici memakai sinyal bawaan input
        } else {
          opts = { ...(opts || {}), signal: this._abort.signal }
        }
      }
      const sig = opts && opts.signal
      if (sig && typeof AbortSignal !== "undefined" && !(sig instanceof AbortSignal)) {
        const ac = new AbortController()
        if (sig.aborted) ac.abort(sig.reason)
        else sig.addEventListener("abort", () => ac.abort(sig.reason), { once: true })
        opts = { ...opts, signal: ac.signal }
      }
      const res = await this._fetch(input, opts)
      this.networkLogs.push({
        url: requestUrl,
        status: res.status,
        method,
        type: res.headers.get("content-type")?.startsWith("text/html") ? "document" : "fetch",
        timing: Date.now() - start,
        startedAt: start, // epoch ms — bukti kapan fetch MULAI (uji paralelisme aset)
        bytes: res.headers.get("content-length") ? Number(res.headers.get("content-length")) : undefined,
      })
      const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : []
      this.storeCookies(requestUrl, setC)
      return res
    } catch (e) {
      // P2-6 R5: entri GAGAL kini ikut `timing` + `startedAt` — gerbang test
      // mengukur MEKANISME timeout aset (durasi fetch-nya sendiri ±10s) alih-alih
      // wall-clock total screenshot yang rapuh di bawah kontensi CPU.
      this.networkLogs.push({ url: requestUrl, method, status: 0, type: "error", timing: Date.now() - start, startedAt: start, error: String(e).slice(0, 120) })
      throw e
    }
  }

  // --- mirror + jalankan module graph dengan cache-busting per load ---
  _cacheFile(host, rel) {
    const hostDir = path.join(this.cacheDir, host)
    const file = rel.replace(/^\//, "") || "index.js"
    return path.join(hostDir, file)
  }

  async _mirrorModule(modUrl, prefix, signal, seen = new Set()) {
    if (seen.has(modUrl)) return
    seen.add(modUrl)
    const u = new URL(modUrl)
    const rel = (u.pathname || "/index.js").replace(/^\//, "")
    const hostDir = path.join(this.cacheDir, u.host)
    fs.mkdirSync(hostDir, { recursive: true })
    const relDir = path.posix.dirname(rel)
    const relBase = path.posix.basename(rel)
    const outFile = this._cacheFile(u.host, relDir === "." ? `${prefix}${relBase}` : `${relDir}/${prefix}${relBase}`)
    if (fs.existsSync(outFile)) return
    fs.mkdirSync(this.cacheDir, { recursive: true })
    fs.mkdirSync(hostDir, { recursive: true })
    fs.mkdirSync(path.dirname(outFile), { recursive: true })

    // Fetch module = I/O fase settle → signal navigate WAJIB ikut (stop/timeout
    // harus membatalkan mirror, bukan menggantung berjam-jam).
    const res = await this._fetch(modUrl, { signal })
    if (!res.ok) throw new Error(`module ${modUrl} → HTTP ${res.status}`)
    let code = await res.text()

    // rewrite import relatif → file mirror ber-prefix + pastikan ekstensi .js
    const children = []
    code = code.replace(REL_IMPORT_RE, (m, pre, q, relPath) => {
      let child = relPath
      if (!path.extname(child)) child += ".js"
      children.push(new URL(child, modUrl).toString())
      // prefix nempel ke FILENAME — konsisten dgn lokasi mirror di atas/di bawah
      const cd = path.posix.dirname(child)
      const cb = path.posix.basename(child)
      const rew = cd === "." ? `./${prefix}${cb}` : `${cd}/${prefix}${cb}`
      return `${pre}${q}${rew}${q}`
    })
    for (const c of children) await this._mirrorModule(c, prefix, signal, seen)

    // mirror lengkap baru: tulis tmp → rename (atomic, hindari cache race/partial).
    const dir = path.dirname(outFile)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${outFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, code)
    fs.rmSync(outFile, { force: true })
    fs.renameSync(tmp, outFile)
  }

  async _runModules(window, controller = null) {
    const signal = controller ? controller.signal : undefined
    const mods = [...window.document.querySelectorAll("script[type='module'][src]")]
    for (const m of mods) {
      const modUrl = new URL(m.getAttribute("src"), this.currentUrl).toString()
      const loadId = PROCESS_LOAD_SEQ
      const prefix = `load${loadId}-`
      const u = new URL(modUrl)
      try {
        await this._mirrorModule(modUrl, prefix, signal)
        const rel = (u.pathname || "/index.js").replace(/^\//, "")
        const eDir = path.posix.dirname(rel)
        const eBase = path.posix.basename(rel)
        const entry = path.join(this.cacheDir, u.host, eDir === "." ? `${prefix}${eBase}` : `${eDir}/${prefix}${eBase}`)
        // import() = I/O fase settle TANPA signal (kode module bisa top-level
        // await selamanya) → race terhadap abort navigate.
        await raceAbort(import(pathToFileURL(entry).href + `?load=${loadId}`), controller, "dibatalkan")
        window.document.consoleLogs?.push?.({ level: "info", message: `module ${modUrl} loaded` })
        this.consoleLogs.push({ level: "info", message: `module loaded: ${modUrl}` })
      } catch (e) {
        // Batal KITA (stop/timeout — state controller) JANGAN berubah jadi
        // "module gagal" lalu lanjut — navigate wajib melempar batal jujur.
        // AbortError MILIK module (P2-1 R4) → bukan batal kita → jatuh ke log.
        if (isCancel(controller)) throw cancelError(controller)
        this.consoleLogs.push({ level: "error", message: `module gagal: ${modUrl} — ${String(e).slice(0, 200)}\n${(e.stack || "").split("\n").slice(1, 6).join("\n")}` })
      }
    }
    // inline module (tanpa src) — jarang; catat saja
    const inline = [...window.document.querySelectorAll("script[type='module']:not([src])")]
    if (inline.length) this.consoleLogs.push({ level: "warn", message: `${inline.length} inline module tidak dieksekusi (butuh bundling)` })
  }

  // patch global Node → arahkan ke window jsdom (module import pakai global ini).
  // Node globalThis.navigator/crypto dsb getter-only → semuanya lewat defProp.
  // Setiap key di-snapshot dulu (sekali) → bisa di-unpatch di reset().
  _patchGlobals(w) {
    const g = globalThis
    // Tukar kepemilikan secara sadar: patch lama milik sesi LAIN dikembalikan
    // dulu, baru patch halaman ini dipasang. Aman karena semua jalur patch
    // lewat antrean yang sama (navigate via withJsLock; restoreTab juga
    // withJsLock) → pemilik lama PASTI sudah selesai navigasinya (P1 R6).
    if (GLOBAL_OWNER && GLOBAL_OWNER !== this) {
      restoreGlobals(g)
      GLOBAL_OWNER = null
    }
    GLOBAL_OWNER = this
    const patch = (key, value) => {
      captureGlobal(g, key)
      defProp(g, key, value)
    }
    patch("document", w.document)
    patch("window", w)
    patch("navigator", w.navigator)
    patch("localStorage", w.localStorage)
    patch("sessionStorage", w.sessionStorage)
    patch("history", w.history)
    patch("location", w.location)
    patch("getComputedStyle", w.getComputedStyle.bind(w))
    patch("HTMLElement", w.HTMLElement)
    patch("Element", w.Element)
    patch("Event", w.Event)
    patch("CustomEvent", w.CustomEvent)
    patch("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 16))
    patch("cancelAnimationFrame", clearTimeout)
    patch("crypto", w.crypto)
    patch("ethers", w.ethers)
    patch("fetch", w.fetch)
    patch("alert", w.alert)
    patch("confirm", w.confirm)
    patch("prompt", w.prompt)
    patch("Buffer", w.Buffer || Buffer)
  }

  // Inject isi <link rel=stylesheet> sebagai <style> ke jsdom → getComputedStyle
  // cascade penuh (warna/border/font kebaca utk computed style & screenshot).
  // Idempotent per URL (jangan fetch ulang tiap render).
  // P1 R4: fetch stylesheet ber-TIMEOUT (10s) — dulu tanpa signal/timeout,
  // stylesheet yang tak pernah merespons menggantungkan screenshot ±301 detik.
  // Gagal load TIDAK melempar (tidak mematikan screenshot): dicatat jujur di
  // `failed` → tool screenshot meneruskannya sebagai `notes`.
  // P2-3 R5: fetch PARALEL (Promise.all) — dulu sekuensial `for ... await`, jadi
  // batas 10s berlaku PER LINK: 3 link menggantung = 30247ms tanpa batas N.
  // Kini seluruh link diborong serentak → plafon ±1x ASSET_TIMEOUT_MS + render.
  // P2-4 R5: `page._shotCtl` (AbortController milik tool screenshot) ikut
  // dibawa → `stop` MEMBATALKAN fetch stylesheet, bukan cuma navigasi.
  async ensureStyles() {
    if (!this.currentUrl) return { injected: 0, mode: "cascade", failed: [] }
    if (this._stylesFor === this.currentUrl) return { injected: 0, mode: "cascade", cached: true, failed: [...(this._styleFailed || [])] }
    this._stylesFor = this.currentUrl
    this._styleFailed = []
    const doc = this.window?.document
    if (!doc) return { injected: 0, mode: "none", failed: [] }
    const links = [...doc.querySelectorAll('link[rel="stylesheet"][href]')]
    if (!links.length) return { injected: 0, mode: "cascade", failed: [] }
    const stopSig = this._shotCtl ? this._shotCtl.signal : null
    const assetSignal = () => {
      const to = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ASSET_TIMEOUT_MS) : undefined
      if (!stopSig) return to
      if (!to) return stopSig
      try { return AbortSignal.any([to, stopSig]) } catch { return stopSig }
    }
    const results = await Promise.all(links.map(async (l, i) => {
      const rawHref = l.getAttribute("href") || ""
      try {
        const href = new URL(rawHref, this.currentUrl).toString()
        const res = await this._trackedFetch(href, { signal: assetSignal() })
        if (!res.ok) return { i, fail: `${href} (HTTP ${res.status})` }
        return { i, css: await res.text() }
      } catch (e) {
        // Wireframe LANJUT tanpa stylesheet ini (mungkin tanpa style — jujur),
        // BUKAN gantung dan BUKAN sukses palsu: alasan dicatat di failed.
        return { i, fail: `${rawHref} (${e?.name || "Error"}: ${e?.message || e})` }
      }
    }))
    // Fetch paralel, tapi INJEKSI urut dokumen → urutan cascade tetap sama
    // dengan urutan <link> (link kemudian menang, seperti browser).
    let injected = 0
    for (const r of results.sort((a, b) => a.i - b.i)) {
      if (r.fail !== undefined) { this._styleFailed.push(r.fail); continue }
      if (!r.css) continue
      const st = doc.createElement("style")
      st.textContent = r.css
      ;(doc.head || doc.documentElement).appendChild(st)
      injected++
    }
    return { injected, mode: "cascade", failed: [...this._styleFailed] }
  }

  // Titik masuk SEMUA navigasi engine js — di-serialisasi lewat antrean global
  // TUNGGAL (P1 R6): `serve --js` dengan 2 klien paralel = antrian, bukan
  // balapan patch globalThis. Redirect tak boleh lewat sini (deadlock — sudah
  // di dalam lock) → panggil _navigateLocked langsung.
  navigate(url, opts = {}) {
    return withJsLock(() => this._navigateLocked(url, opts))
  }

  async _navigateLocked(url, { headers = {}, timeoutMs = 30000, userAgent = `mcp-web/${SERVER_INFO.version} (+termux)`, maxBytes = 5 * 1024 * 1024, redirectHops = 0 } = {}) {
    assertSafeTarget(url)
    if (redirectHops >= MAX_REDIRECTS) throw new Error(`terlalu banyak redirect (maks ${MAX_REDIRECTS} hop)`)
    const start = Date.now()
    const controller = new AbortController()
    this._abort = controller // tool `stop` boleh membatalkan fetch ini
    this._inflight = { url, startedAt: start, phase: "fetch" }
    // Checkpoint anti-"sukses palsu": stop bisa datang DI FASE SETTLE (setelah
    // body selesai dibaca). Sejak fix P1 R3 signal navigate DIWARISKAN ke semua
    // fetch settle (script klasik, mirror module, fetch halaman) + import()
    // module di-race → I/O settle ikut batal; checkpoint ini tetap jaring
    // pengaman utk titik tanpa await (dan utk timeoutMs yang lewat di settle).
    // Lempar name:"AbortError" → jatuh ke jalur catch di bawah yang sudah
    // membedakan "dibatalkan oleh stop" vs "Timeout setelah Xms".
    const checkStop = () => {
      if (controller.__mcpStoppedByStop) {
        const e = new Error("dibatalkan oleh stop")
        e.name = "AbortError"
        throw e
      }
      if (controller.signal.aborted) {
        // timeoutMs lewat di fase settle → jangan kembalikan SUKSES palsu.
        const e = new Error(`dibatalkan (timeout ${timeoutMs}ms)`)
        e.name = "AbortError"
        throw e
      }
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const reqHeaders = { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...headers }
      const cookie = this.cookieHeader(url)
      if (cookie) reqHeaders.Cookie = cookie

      const res = await this._trackedFetch(url, { headers: reqHeaders, redirect: "manual", signal: controller.signal })
      if (res.status >= 300 && res.status < 400) {
        // redirect tercatat di network log; lanjut manual agar URL final akurat
        const loc = res.headers.get("location")
        if (loc) {
          const next = new URL(loc, url).toString()
          assertSafeTarget(next) // redirect tak boleh menuju target private (SSRF via redirect)
          this.redirects.push({ from: url, to: next, status: res.status })
          // rekursi DI DALAM lock (jangan navigate() → deadlock antrean global)
          return this._navigateLocked(next, { headers, timeoutMs, userAgent, maxBytes, redirectHops: redirectHops + 1 })
        }
      }
      const html = (await res.text()).slice(0, maxBytes)
      // --- FASE SETTLE dimulai: body utuh terbaca. phase → stop melapor jujur;
      // signal navigate masih HIDUP (timer `timeoutMs` belum dibersihkan) dan
      // kini dibawa oleh setiap fetch settle → stop/timeout tetap membatalkan
      // I/O di sini. checkStop() = jaring pengaman utk titik tanpa await.
      if (this._inflight && this._inflight.startedAt === start) this._inflight.phase = "settle"
      checkStop()
      const finalUrl = res.url || url
      const timing = Date.now() - start

      PROCESS_LOAD_SEQ ++
      this.consoleLogs.push({ level: "info", message: `Loaded ${finalUrl} (${res.status}) in ${timing}ms` })

      const vc = new VirtualConsole()
      vc.on("log", (...a) => this.consoleLogs.push({ level: "info", message: a.map(String).join(" ") }))
      vc.on("info", (...a) => this.consoleLogs.push({ level: "info", message: a.map(String).join(" ") }))
      vc.on("warn", (...a) => this.consoleLogs.push({ level: "warn", message: a.map(String).join(" ") }))
      vc.on("error", (...a) => this.consoleLogs.push({ level: "error", message: a.map(String).join(" ") }))
      vc.on("jsdomError", (e) => this.consoleLogs.push({ level: "error", message: String(e).slice(0, 300) }))

      // --- localStorage antar navigate (session-scoped) ---
      // JSDOM baru = storage kosong; tanpa ini wallet/state hilang tiap reload.
      // Snapshot dari window SEBELUM diganti → di-restore ke JSDOM berikutnya.
      const lsPrev = {}
      try {
        const old = this.window && this.window.localStorage
        if (old) {
          for (let i = 0; i < old.length; i++) { const k = old.key(i); lsPrev[k] = old.getItem(k) }
        }
      } catch { /* window lama tanpa storage — skip */ }

      const dom = new JSDOM("", { url: finalUrl, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc })
      const w = dom.window
      try {
        for (const k of Object.keys(lsPrev)) w.localStorage.setItem(k, lsPrev[k])
      } catch { /* storage tak tersedia — lanjut tanpa restore */ }

      // --- inject API browser dari Node ---
      defProp(w, "crypto", globalThis.crypto)
      defProp(w, "fetch", (input, init) => this._trackedFetch(input, init))
      defProp(w, "TextEncoder", globalThis.TextEncoder)
      defProp(w, "TextDecoder", globalThis.TextDecoder)
      // property jsdom lain yang getter-only juga → semua lewat defProp.
      defProp(w, "navigator", globalThis.navigator)
      defProp(w, "location", w.location)
      defProp(w, "history", this.historyJsdom || w.history)
      defProp(w, "window", w)
      defProp(w, "document", w.document)
      defProp(w, "parent", w.parent)
      if (!w.URL.createObjectURL) w.URL.createObjectURL = () => ""
      if (!w.matchMedia) defProp(w, "matchMedia", () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }))
      defProp(w, "alert", (m) => this._pushDialog("alert", m))
      defProp(w, "confirm", (m) => { this._pushDialog("confirm", m); return true })
      defProp(w, "prompt", (m, d) => { this._pushDialog("prompt", m); return d ?? "" })

      // Konten bukan HTML → gagal SEBELUM state di-commit (tak ada state setengah-jadi).
      try {
        w.document.write(html)
      } catch (e) {
        throw new Error(`konten bukan HTML: ${e.message}`)
      }

      // classic scripts: fetch + eval di konteks window
      for (const s of [...w.document.querySelectorAll("script[src]")]) {
        checkStop() // di LUAR try — lemparan stop jangan tertelan catch "script gagal"
        if (s.type === "module") continue
        const src = s.src || new URL(s.getAttribute("src"), finalUrl).toString()
        try {
          // fetch script = I/O fase settle → signal navigate ikut (P1 R3):
          // stop/timeout MEMBATALKAN fetch ini, bukan menggantung tanpa batas.
          const code = await (await this._trackedFetch(src, { signal: controller.signal })).text()
          w.eval(code)
        } catch (e) {
          // Batal KITA (stop/timeout — state controller) JANGAN berubah jadi
          // "classic script gagal" → navigate lanjut/sukses lewat timeout.
          // AbortError MILIK script (P2-1 R4) → error halaman biasa → log saja.
          if (isCancel(controller)) throw cancelError(controller)
          this.consoleLogs.push({ level: "error", message: `classic script gagal: ${src} — ${String(e).slice(0, 150)}` })
        }
      }
      checkStop() // stop semasa fetch script terakhir → jangan lanjut settle

      this.window = w
      this.document = w.document
      this.currentUrl = finalUrl
      this.status = res.status
      this.headers = Object.fromEntries(res.headers.entries())
      this.title = w.document.title || ""
      this.timing = { durationMs: timing, bytes: html.length }

      // Tab aktif: navigasi pertama membuka tab-1 (bila belum ada).
      if (!this.activeTabId) {
        if (!(this.tabSeq >= 1)) this.tabSeq = 1
        this.activeTabId = `tab-${this.tabSeq}`
      }

      // history
      if (this.history[this.historyIndex] !== finalUrl) {
        this.history = this.history.slice(0, this.historyIndex + 1)
        this.history.push(finalUrl)
        this.historyIndex = this.history.length - 1
      }

      // module scripts — patch globals DULU (module via Node import() jalan di
      // scope Node: apalagi `window is not defined` kalau globalThis belum diarahkan).
      this._patchGlobals(w)
      await this._runModules(w, controller)
      checkStop() // stop semasa mirror/import module → jangan lanjut

      // boot event + tunggu halaman tenang — putus SEGERA bila stop/timeout
      // datang di tengah jendela waitMs (checkStop sesudahnya melempar).
      w.document.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true }))
      await new Promise((r) => {
        if (controller.signal.aborted || controller.__mcpStoppedByStop) return r() // sudah batal → jangan tunggu waitMs penuh
        const t = setTimeout(r, this.waitMs)
        const onAbort = () => { clearTimeout(t); r() }
        controller.signal.addEventListener("abort", onAbort, { once: true })
      })
      checkStop()

      // module/SPA bisa mengubah document.title SETELAH this.title diisi di
      // atas → laporkan nilai TERBARU (jujur), bukan snapshot pre-module.
      this.title = w.document.title || ""

      // inject global after load (module mungkin set window props)
      this._patchGlobals(w)

      checkStop() // jaring pengaman terakhir: TANPA ini navigate boleh
      // selesai sukses sementara stop/timeout sudah membatalkan = sukses palsu.
      return this.summary()
    } catch (e) {
      if (e instanceof McpError) throw e // pesan guard (SSRF dll) sampai utuh ke klien
      // AbortError = batal HANYA bila state KITA yang batal (controller di-abort
      // stop/timeout atau flag stop). AbortError MILIK HALAMAN yang lolos ke sini
      // (P2-1 R4) jangan diklaim "Timeout"/"stop" — jatuh ke pesan `navigate gagal`
      // di bawah (jujur, tanpa menyalahkan timeout yang tak pernah ada).
      if (e.name === "AbortError" && (controller.signal.aborted || controller.__mcpStoppedByStop)) {
        // Abort = timer timeout ATAU diminta tool `stop` → pesan jujur (pola sama src/browser.js).
        // Berlaku utk SEMUA fase: fetch, fetch settle (script/module, kini
        // ikut signal) dan jendela waitMs.
        throw new Error(controller.__mcpStoppedByStop ? "navigate gagal: dibatalkan oleh stop" : `Timeout setelah ${timeoutMs}ms`)
      }
      // P2-3 R4: sertakan e.cause (ECONNREFUSED/EMFILE dst) — pola sama
      // src/browser.js — supaya rantai bukti akar kegagalan tidak putus.
      throw new Error(`navigate gagal: ${e.message}${e?.cause ? ` (cause: ${e.cause})` : ""}`)
    } finally {
      clearTimeout(timer)
      if (this._abort === controller) this._abort = null
      if (this._inflight && this._inflight.startedAt === start) this._inflight = null
    }
  }

  summary() {
    if (!this.document) return { currentUrl: null, status: null, title: "" }
    const doc = this.document
    const count = (sel) => {
      try { return doc.querySelectorAll(sel).length } catch { return 0 }
    }
    return {
      currentUrl: this.currentUrl,
      status: this.status,
      title: this.title,
      engine: "jsdom (JS hidup)",
      stats: {
        links: count("a"), buttons: count("button"), inputs: count("input"),
        forms: count("form"), images: count("img"),
      },
      redirects: this.redirects.length,
      consoleLogs: this.consoleLogs.length,
      networkLogs: this.networkLogs.length,
    }
  }

  textContent() {
    if (!this.document) return ""
    const txt = (this.document.body?.textContent || "").replace(/\s+/g, " ").trim()
    return txt.slice(0, 20000)
  }

  html() {
    if (!this.document) return ""
    return this.document.toString().slice(0, 50000)
  }
}

export function createJsPage(options) {
  return new JsPage(options)
}