// WebDrive MCP — engine halaman.
// Navigasi + DOM model tanpa browser engine (tanpa Chromium/root/proot).
// Fetch bawaan Node + linkedom untuk parsing DOM. Semua state per-sesi.
import { parseHTML } from "linkedom"

export const DEFAULT_OPTIONS = {
  timeoutMs: 30000,
  maxBytes: 5 * 1024 * 1024, // 5MB — anti botak
  userAgent: "mcp-web/1.1.0 (+termux)",
  followRedirects: true,
}

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
    this.consoleLogs = []
    this.networkLogs = []
    this.history = [] // stack URL yang sudah dikunjungi
    this.historyIndex = -1
    this.cookies = new Map() // domain -> Map(name -> {value, path, ...})
    this.title = ""
  }

  // --- cookie store sederhana ---
  storeCookies(url, setCookieHeader) {
    try {
      const host = new URL(url).hostname
      if (!this.cookies.has(host)) this.cookies.set(host, new Map())
      const store = this.cookies.get(host)
      for (const raw of setCookieHeader || []) {
        const [pair, ...attrs] = raw.split(";").map((s) => s.trim())
        const eq = pair.indexOf("=")
        if (eq < 0) continue
        const name = pair.slice(0, eq)
        const value = pair.slice(eq + 1)
        store.set(name, { value, attrs })
      }
    } catch {}
  }

  cookieHeader(url) {
    try {
      const host = new URL(url).hostname
      const store = this.cookies.get(host)
      if (!store || store.size === 0) return undefined
      return [...store.entries()].map(([k, v]) => `${k}=${v.value}`).join("; ")
    } catch {
      return undefined
    }
  }

  getCookiesForCurrent() {
    const out = []
    for (const [host, store] of this.cookies) {
      for (const [name, c] of store) out.push({ domain: host, name, value: c.value })
    }
    return out
  }

  clearCookies() {
    this.cookies.clear()
    return this.cookies.size === 0
  }

  // --- navigasi ---
  async navigate(url, { headers = {}, timeoutMs = DEFAULT_OPTIONS.timeoutMs, userAgent = DEFAULT_OPTIONS.userAgent, maxBytes = DEFAULT_OPTIONS.maxBytes } = {}) {
    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const reqHeaders = { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...headers }
      const cookie = this.cookieHeader(url)
      if (cookie) reqHeaders.Cookie = cookie

      const res = await fetch(url, { headers: reqHeaders, redirect: "manual", signal: controller.signal })
      const timing = Date.now() - start

      // redirect manual handling (direkam di network log)
      this.networkLogs.push({
        url, status: res.status, type: "redirect", timing,
      })
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const loc = new URL(res.headers.get("location"), url).toString()
        this.redirects.push({ from: url, to: loc, status: res.status })
        this.recordResult(url, res.status, {}, { durationMs: timing })
        const cookieHeader = res.headers.getSetCookie ? res.headers.getSetCookie() : []
        this.storeCookies(url, cookieHeader)
        return this.navigate(loc, { headers, timeoutMs, userAgent, maxBytes })
      }

      const buf = await res.arrayBuffer()
      const html = Buffer.from(buf).toString("utf8").slice(0, maxBytes)
      const finalUrl = res.url || url

      const { document, window } = parseHTML(html)
      this.document = document
      this.window = window
      this.title = document.title || ""
      this.currentUrl = finalUrl
      this.status = res.status
      this.headers = Object.fromEntries(res.headers.entries())
      this.timing = { durationMs: timing, bytes: buf.byteLength, truncated: buf.byteLength > maxBytes }

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

      return this.summary()
    } catch (e) {
      const err = e.name === "AbortError" ? new Error(`Timeout setelah ${timeoutMs}ms`) : e
      throw new Error(`navigate gagal: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  recordResult(url, status, headers, extra) {
    // dipakai untuk redirect step — tidak menimpa document
    this.networkLogs.push({ url, status, ...extra })
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

  get(url) { return this.document ? this.document : null }
}

export function createPage() {
  return new Page()
}