// WebDrive MCP — engine halaman.
// Navigasi + DOM model tanpa browser engine (tanpa Chromium/root/proot).
// Fetch bawaan Node + linkedom untuk parsing DOM. Semua state per-sesi.
import { parseHTML } from "linkedom"
import { CookieJar } from "./cookies.js"
import { CappedArray } from "./logs.js"
import { assertSafeTarget } from "./security.js"
import { McpError, SERVER_INFO } from "./protocol.js"
import { PRISTINE_FETCH } from "./pristine.js"

export const DEFAULT_OPTIONS = {
  timeoutMs: 30000,
  maxBytes: 5 * 1024 * 1024, // 5MB — anti botak
  userAgent: `mcp-web/${SERVER_INFO.version} (+termux)`, // versi dari package.json (single source)
  followRedirects: true,
}

export const MAX_REDIRECTS = 10 // hop redirect maksimum — anti loop tanpa batas

export class Page {
  constructor() {
    this.reset()
  }

  reset() {
    this.document = null
    this.window = null
    this.currentUrl = null
    this.status = null
    this.headers = {}
    this.redirects = []
    this.timing = null
    this.consoleLogs = new CappedArray() // dibatasi LOG_CAP — buang entri paling lama
    this.networkLogs = new CappedArray()
    this.history = [] // stack URL yang sudah dikunjungi
    this.historyIndex = -1
    this.cookies = new CookieJar()
    this.title = ""
    // Multi-tab: map id → snapshot {url,title,html,history,...} tab NON-aktif.
    // Tab aktif hidup di field di atas (document/currentUrl/history).
    this.tabs = new Map()
    this.activeTabId = null // diisi saat tab pertama dibuka (tab-1)
    this.tabSeq = 0 // counter id tab — monotonik selama sesi
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

  // Bersihkan bagian navigasi — dipakai kalau konten gagal diparse,
  // supaya tak pernah meninggalkan state setengah-jadi.
  clearPageState() {
    this.document = null
    this.window = null
    this.currentUrl = null
    this.status = null
    this.headers = {}
    this.timing = null
    this.title = ""
  }

  // --- navigasi ---
  async navigate(url, { headers = {}, timeoutMs = DEFAULT_OPTIONS.timeoutMs, userAgent = DEFAULT_OPTIONS.userAgent, maxBytes = DEFAULT_OPTIONS.maxBytes, redirectHops = 0 } = {}) {
    assertSafeTarget(url)
    if (redirectHops >= MAX_REDIRECTS) throw new Error(`terlalu banyak redirect (maks ${MAX_REDIRECTS} hop)`)
    const start = Date.now()
    const controller = new AbortController()
    this._abort = controller // tool `stop` boleh membatalkan fetch ini
    this._inflight = { url, startedAt: start, phase: "fetch" }
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const reqHeaders = { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...headers }
      const cookie = this.cookieHeader(url)
      if (cookie) reqHeaders.Cookie = cookie

      // fetch ASLI proses (src/pristine.js) — BUKAN `fetch` telanjang: global
      // bisa sedang ter-patch engine js (per sesi, P1 R6) → navigate dom boleh
      // bawa fetch milik sesi lain/stub (bleed silang-engine, P1 R6).
      const res = await PRISTINE_FETCH(url, { headers: reqHeaders, redirect: "manual", signal: controller.signal })
      const timing = Date.now() - start

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        // Satu push per hop saja (bukan dobel: network log + recordResult dulu).
        const loc = new URL(res.headers.get("location"), url).toString()
        assertSafeTarget(loc) // redirect tak boleh menuju target private (SSRF via redirect)
        this.networkLogs.push({ url, status: res.status, type: "redirect", timing })
        this.redirects.push({ from: url, to: loc, status: res.status })
        const cookieHeader = res.headers.getSetCookie ? res.headers.getSetCookie() : []
        this.storeCookies(url, cookieHeader)
        return this.navigate(loc, { headers, timeoutMs, userAgent, maxBytes, redirectHops: redirectHops + 1 })
      }

      const buf = await res.arrayBuffer()
      // --- FASE SETTLE: sisa pekerjaan engine dom (parse + commit state)
      // SEMUANYA sinkron — tanpa await berikutnya, stop tak punya jendela
      // masuk seperti engine js. Phase tetap dicerminkan agar bentuk output
      // `stop` seragam antar engine.
      if (this._inflight && this._inflight.startedAt === start) this._inflight.phase = "settle"
      const html = Buffer.from(buf).toString("utf8").slice(0, maxBytes)
      const finalUrl = res.url || url

      // Konten non-HTML (mis. JSON/API) → tolak SEBELUM menyentuh state.
      const ct = String(res.headers.get("content-type") || "")
      if (ct && !/(html|xml)/i.test(ct)) {
        this.clearPageState()
        throw new Error(`konten bukan HTML (content-type: ${ct.split(";")[0].trim()})`)
      }
      // Parse + baca title dulu di variabel lokal — kalau gagal, state tak tercemar.
      let document, window, title
      try {
        const parsed = parseHTML(html)
        document = parsed.document
        window = parsed.window
        title = document.title || ""
      } catch (e) {
        this.clearPageState()
        throw new Error(`konten bukan HTML: ${e.message}`)
      }
      this.document = document
      this.window = window
      this.title = title
      this.currentUrl = finalUrl
      this.status = res.status
      this.headers = Object.fromEntries(res.headers.entries())
      this.timing = { durationMs: timing, bytes: buf.byteLength, truncated: buf.byteLength > maxBytes }

      // Tab aktif: navigasi pertama membuka tab-1 (bila belum ada).
      if (!this.activeTabId) {
        if (!(this.tabSeq >= 1)) this.tabSeq = 1
        this.activeTabId = `tab-${this.tabSeq}`
      }

      // Hook dialog: alert/confirm/prompt halaman → antrian `dialog` (bukan crash).
      try {
        window.alert = (m) => this._pushDialog("alert", m)
        window.confirm = (m) => { this._pushDialog("confirm", m); return true }
        window.prompt = (m, d) => { this._pushDialog("prompt", m); return d ?? "" }
      } catch { /* window read-only — dialog tak terkumpul, js_eval tetap jalan */ }

      // push history
      if (this.history[this.historyIndex] !== finalUrl) {
        this.history = this.history.slice(0, this.historyIndex + 1)
        this.history.push(finalUrl)
        this.historyIndex = this.history.length - 1
      }

      const setCookieHeader = res.headers.getSetCookie ? res.headers.getSetCookie() : []
      this.storeCookies(finalUrl, setCookieHeader)

      this.networkLogs.push({ url: finalUrl, status: res.status, type: "document", timing, bytes: buf.byteLength })
      this.consoleLogs.push({ level: "info", message: `Loaded ${finalUrl} (${res.status}) in ${timing}ms` })

      // Guard struktural anti-"sukses palsu" (pola sama engine js). Jalur
      // post-fetch dom kini sinkron → tak terjangkau stop, tapi cek ini
      // menutup celah kalau ada await baru ditambahkan di masa depan.
      if (controller.__mcpStoppedByStop) {
        const e = new Error("dibatalkan oleh stop")
        e.name = "AbortError"
        throw e
      }
      return this.summary()
    } catch (e) {
      if (e instanceof McpError) throw e // pesan guard (SSRF dll) sampai utuh ke klien
      if (e.name === "AbortError") {
        // Abort = timer timeout ATAU diminta tool `stop` → pesan jujur, jangan
        // menyalahkan timeout saat yang mematikan adalah stop.
        throw new Error(controller.__mcpStoppedByStop ? "navigate gagal: dibatalkan oleh stop" : `navigate gagal: Timeout setelah ${timeoutMs}ms`)
      }
      // P2-3 R4: sertakan e.cause (ECONNREFUSED/EMFILE dst) — pola sama
      // src/engine-js.js — rantai bukti akar kegagalan jangan putus (HUKUM 11).
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
    const body = this.document.body
    if (!body) return ""
    const txt = body.textContent.replace(/\s+/g, " ").trim()
    return txt.slice(0, 20000)
  }

  html() {
    if (!this.document) return ""
    return this.document.toString().slice(0, 50000)
  }
}

export function createPage() {
  return new Page()
}
