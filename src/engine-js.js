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

const CACHE_ROOT = path.join(os.homedir(), ".cache", "mcp-web", "js-modules")

// Counter MONOTONIK PROSES-GLOBAL utk cache-busting module:
// Node ESM import() meng-cache per URL (?load=...). Kalau _loadId per-instance
// (reset ke 0 tiap page), DUA test dlm SATU proses pakai URL ?load=1 SAMA →
// Node balikan module cached TANPA re-execute → state bocor/listener tak jalan.
// Counter global → tiap navigate URL ?load= UNIK → import() selalu fresh.
let PROCESS_LOAD_SEQ = 0

// Pola import relatif di module (untuk mirror + rewrite).
const REL_IMPORT_RE = /(from\s*|import\s*\(\s*)(['"])(\.\/[^'"]+)\2/g

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
    this.window = null
    this.document = null
    this.currentUrl = null
    this.status = null
    this.headers = {}
    this.redirects = []
    this.timing = null
    this.consoleLogs = []
    this.networkLogs = []
    this.history = []
    this.historyIndex = -1
    this.cookies = new Map()
    this.title = ""
    this._fetch = globalThis.fetch.bind(globalThis)
  }

  // --- cookie store (sama dengan engine DOM) ---
  storeCookies(url, setCookieHeader) {
    try {
      const host = new URL(url).hostname
      if (!this.cookies.has(host)) this.cookies.set(host, new Map())
      const store = this.cookies.get(host)
      for (const raw of setCookieHeader || []) {
        const [pair, ...attrs] = raw.split(";").map((s) => s.trim())
        const eq = pair.indexOf("=")
        if (eq < 0) continue
        store.set(pair.slice(0, eq), { value: pair.slice(eq + 1), attrs })
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

  // --- fetch yang dicatat ke network log ---
  async _trackedFetch(input, init = {}) {
    const requestUrl = typeof input === "string" ? input : input?.url || String(input)
    const method = (init?.method || input?.method || "GET").toUpperCase()
    const start = Date.now()
    try {
      const res = await this._fetch(input, init)
      this.networkLogs.push({
        url: requestUrl,
        status: res.status,
        method,
        type: res.headers.get("content-type")?.startsWith("text/html") ? "document" : "fetch",
        timing: Date.now() - start,
        bytes: res.headers.get("content-length") ? Number(res.headers.get("content-length")) : undefined,
      })
      const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : []
      this.storeCookies(requestUrl, setC)
      return res
    } catch (e) {
      this.networkLogs.push({ url: requestUrl, method, status: 0, type: "error", error: String(e).slice(0, 120) })
      throw e
    }
  }

  // --- mirror + jalankan module graph dengan cache-busting per load ---
  _cacheFile(host, rel) {
    const hostDir = path.join(this.cacheDir, host)
    const file = rel.replace(/^\//, "") || "index.js"
    return path.join(hostDir, file)
  }

  async _mirrorModule(modUrl, prefix, seen = new Set()) {
    if (seen.has(modUrl)) return
    seen.add(modUrl)
    const u = new URL(modUrl)
    const rel = (u.pathname || "/index.js").replace(/^\//, "")
    const hostDir = path.join(this.cacheDir, u.host)
    fs.mkdirSync(hostDir, { recursive: true })
    const outFile = this._cacheFile(u.host, `${prefix}${rel}`)
    if (fs.existsSync(outFile)) return
    fs.mkdirSync(this.cacheDir, { recursive: true })
    fs.mkdirSync(hostDir, { recursive: true })
    fs.mkdirSync(path.dirname(outFile), { recursive: true })

    const res = await this._fetch(modUrl)
    if (!res.ok) throw new Error(`module ${modUrl} → HTTP ${res.status}`)
    let code = await res.text()

    // rewrite import relatif → file mirror ber-prefix + pastikan ekstensi .js
    const children = []
    code = code.replace(REL_IMPORT_RE, (m, pre, q, relPath) => {
      let child = relPath
      if (!path.extname(child)) child += ".js"
      children.push(new URL(child, modUrl).toString())
      return `${pre}${q}./${prefix}${child.replace(/^\.?\//, "")}${q}`
    })
    for (const c of children) await this._mirrorModule(c, prefix, seen)

    // mirror lengkap baru: tulis tmp → rename (atomic, hindari cache race/partial).
    const dir = path.dirname(outFile)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${outFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, code)
    fs.rmSync(outFile, { force: true })
    fs.renameSync(tmp, outFile)
  }

  async _runModules(window) {
    const mods = [...window.document.querySelectorAll("script[type='module'][src]")]
    for (const m of mods) {
      const modUrl = new URL(m.getAttribute("src"), this.currentUrl).toString()
      const loadId = PROCESS_LOAD_SEQ
      const prefix = `load${loadId}-`
      const u = new URL(modUrl)
      try {
        await this._mirrorModule(modUrl, prefix)
        const rel = (u.pathname || "/index.js").replace(/^\//, "")
        const entry = path.join(this.cacheDir, u.host, `${prefix}${rel}`)
        await import(pathToFileURL(entry).href + `?load=${loadId}`)
        window.document.consoleLogs?.push?.({ level: "info", message: `module ${modUrl} loaded` })
        this.consoleLogs.push({ level: "info", message: `module loaded: ${modUrl}` })
      } catch (e) {
        this.consoleLogs.push({ level: "error", message: `module gagal: ${modUrl} — ${String(e).slice(0, 200)}\n${(e.stack || "").split("\n").slice(1, 6).join("\n")}` })
      }
    }
    // inline module (tanpa src) — jarang; catat saja
    const inline = [...window.document.querySelectorAll("script[type='module']:not([src])")]
    if (inline.length) this.consoleLogs.push({ level: "warn", message: `${inline.length} inline module tidak dieksekusi (butuh bundling)` })
  }

  // patch global Node → arahkan ke window jsdom (module import pakai global ini).
  // Node globalThis.navigator/crypto dsb getter-only → semuanya lewat defProp.
  _patchGlobals(w) {
    const g = globalThis
    defProp(g, "document", w.document)
    defProp(g, "window", w)
    defProp(g, "navigator", w.navigator)
    defProp(g, "localStorage", w.localStorage)
    defProp(g, "sessionStorage", w.sessionStorage)
    defProp(g, "history", w.history)
    defProp(g, "location", w.location)
    defProp(g, "getComputedStyle", w.getComputedStyle.bind(w))
    defProp(g, "HTMLElement", w.HTMLElement)
    defProp(g, "Element", w.Element)
    defProp(g, "Event", w.Event)
    defProp(g, "CustomEvent", w.CustomEvent)
    defProp(g, "requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 16))
    defProp(g, "cancelAnimationFrame", clearTimeout)
    defProp(g, "crypto", w.crypto)
    defProp(g, "ethers", w.ethers)
    defProp(g, "fetch", w.fetch)
    defProp(g, "alert", w.alert)
    defProp(g, "confirm", w.confirm)
    defProp(g, "prompt", w.prompt)
    defProp(g, "Buffer", w.Buffer || Buffer)
  }

  async navigate(url, { headers = {}, timeoutMs = 30000, userAgent = "mcp-web/1.2.0 (+termux)", maxBytes = 5 * 1024 * 1024 } = {}) {
    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const reqHeaders = { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...headers }
      const cookie = this.cookieHeader(url)
      if (cookie) reqHeaders.Cookie = cookie

      const res = await this._trackedFetch(url, { headers: reqHeaders, redirect: "follow", signal: controller.signal })
      if (res.status >= 300 && res.status < 400) {
        // redirect tercatat di network log; lanjut manual agar URL final akurat
        const loc = res.headers.get("location")
        if (loc) {
          const next = new URL(loc, url).toString()
          this.redirects.push({ from: url, to: next, status: res.status })
          return this.navigate(next, { headers, timeoutMs, userAgent, maxBytes })
        }
      }
      const html = (await res.text()).slice(0, maxBytes)
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

      const dom = new JSDOM("", { url: finalUrl, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc })
      const w = dom.window

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
      defProp(w, "alert", (m) => this.consoleLogs.push({ level: "warn", message: `alert: ${String(m).slice(0, 200)}` }))
      defProp(w, "confirm", () => true)
      defProp(w, "prompt", () => "")

      w.document.write(html)

      // classic scripts: fetch + eval di konteks window
      for (const s of [...w.document.querySelectorAll("script[src]")]) {
        if (s.type === "module") continue
        const src = s.src || new URL(s.getAttribute("src"), finalUrl).toString()
        try {
          const code = await (await this._trackedFetch(src)).text()
          w.eval(code)
        } catch (e) {
          this.consoleLogs.push({ level: "error", message: `classic script gagal: ${src} — ${String(e).slice(0, 150)}` })
        }
      }

      this.window = w
      this.document = w.document
      this.currentUrl = finalUrl
      this.status = res.status
      this.headers = Object.fromEntries(res.headers.entries())
      this.title = w.document.title || ""
      this.timing = { durationMs: timing, bytes: html.length }

      // history
      if (this.history[this.historyIndex] !== finalUrl) {
        this.history = this.history.slice(0, this.historyIndex + 1)
        this.history.push(finalUrl)
        this.historyIndex = this.history.length - 1
      }

      // module scripts — patch globals DULU (module via Node import() jalan di
      // scope Node: apalagi `window is not defined` kalau globalThis belum diarahkan).
      this._patchGlobals(w)
      await this._runModules(w)

      // boot event + tunggu halaman tenang
      w.document.dispatchEvent(new w.Event("DOMContentLoaded", { bubbles: true }))
      await new Promise((r) => setTimeout(r, this.waitMs))

      // inject global after load (module mungkin set window props)
      this._patchGlobals(w)

      return this.summary()
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`Timeout setelah ${timeoutMs}ms`)
      throw new Error(`navigate gagal: ${e.message}`)
    } finally {
      clearTimeout(timer)
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

  get() {
    return this.document
  }
}

export function createJsPage(options) {
  return new JsPage(options)
}