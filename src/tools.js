// WebDrive MCP — registrasi tool MCP (54 tool).
// Inti lama (14): navigate, get_content, query, click, fill, submit, wait,
//   js_eval, console_get, network_logs, cookies, history, reset, screenshot.
// Surface builtin opencode.browser (45 nama dotted → flat di MCP: tabs_*, files_*,
//   network_*, trace_*, cpu_*, heap_*, lighthouse, back/forward/reload/...).
// Alias: evaluate→js_eval, console→console_get, network_list→network_logs.
// Total = 45 surface + 9 tool lama = 54. Satu sumber untuk MCP & plugin OpenCode.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createPage } from "./browser.js"
import { McpError, ERR } from "./protocol.js"
import { assertSafeTarget } from "./security.js"

// Header request yang TIDAK BOLEH datang dari argumen klien:
// kredensial (Authorization/Cookie) & spoofing Host.
const BLOCKED_REQUEST_HEADERS = new Set(["authorization", "cookie", "host"])

// P2-5 R5: batas regex tool `find` — pola pemanggil dijalankan di dalam vm
// timeout FIND_TIMEOUT_MS (sama filosofi dgn js_eval vm 2000ms), panjang pola
// dibatasi FIND_PATTERN_MAX karakter.
export const FIND_TIMEOUT_MS = 2000
export const FIND_PATTERN_MAX = 1000

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {}
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (BLOCKED_REQUEST_HEADERS.has(String(k).toLowerCase())) continue // strip
    out[k] = v
  }
  return out
}

function text(result) {
  return { content: [{ type: "text", text: result }], isError: false }
}

// Base64 ketat: Buffer.from(..., "base64") SENYAP membuang karakter sampah →
// tolak di sini dengan error jujur, jangan hasilkan payload rusak.
function decodeBase64Strict(raw) {
  const s = String(raw).replace(/\s+/g, "")
  const valid = /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 !== 1
  if (!valid) throw new McpError(ERR.INVALID_PARAMS, "base64 tidak valid")
  return s
}

function toJson(obj) {
  return JSON.stringify(obj, null, 2)
}

// P3-7 R5: PNG screenshot MENUMPUK di tmpdir (+30 file untuk 30 shot, RSS
// +74MB pada probe). Simpan hanya SHOT_KEEP file terbaru per proses — file
// tertua dihapus saat menulis berikutnya. Sapu SEKALI file sisa run lama
// (mcpweb-shot-* berumur > 1 jam) — milik tool ini sendiri, tak menyentuh
// file lain di tmpdir.
const SHOT_KEEP = 8
const shotFiles = []
let shotSeq = 0
let shotSwept = false

function sweepStaleShots() {
  if (shotSwept) return
  shotSwept = true
  try {
    const dir = os.tmpdir()
    const cutoff = Date.now() - 60 * 60 * 1000 // 1 jam
    for (const f of fs.readdirSync(dir)) {
      if (!/^mcpweb-shot-\d+-/.test(f)) continue
      const full = path.join(dir, f)
      try {
        const st = fs.statSync(full)
        if (st.isFile() && st.mtimeMs < cutoff) fs.rmSync(full, { force: true })
      } catch { /* file lenyap/di-lock — abaikan */ }
    }
  } catch { /* tmpdir tak terbaca — abaikan */ }
}

function writeShotFile(buf) {
  sweepStaleShots()
  const file = path.join(os.tmpdir(), `mcpweb-shot-${process.pid}-${Date.now()}-${shotSeq++}.png`)
  fs.writeFileSync(file, buf)
  shotFiles.push(file)
  while (shotFiles.length > SHOT_KEEP) {
    const old = shotFiles.shift()
    try { fs.rmSync(old, { force: true }) } catch { /* sudah hilang */ }
  }
  return file
}

function requirePage(page) {
  if (!page.document) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "Belum ada halaman. Jalankan 'navigate' dulu.")
}

function parseSelector(sel) {
  if (!sel || typeof sel !== "string") throw new McpError(ERR.INVALID_PARAMS, "selector wajib string")
  return sel
}

// Validasi argumen terhadap inputSchema — SATU tempat untuk semua transport
// (stdio, http, plugin) karena ketiganya memakai handler dari createTools().
// Argumen asing TIDAK diabaikan senyap: error jujur -32602 dengan nama key.
// P2-2 R5: `required` kini DIPEGANG — dulu fill({selector}) tanpa `value` lolos
// dan MENULIS literal "undefined" ke form (sukses palsu + data korup senyap),
// dan argumen hilang malah error arah salah ("Belum ada halaman").
export function assertToolArgs(name, input, schema) {
  const required = schema && Array.isArray(schema.required) ? schema.required : []
  const missingKeys = (obj) =>
    required.filter((k) => !Object.prototype.hasOwnProperty.call(obj, k) || obj[k] === undefined || obj[k] === null)
  const throwMissing = (keys) => {
    throw new McpError(
      ERR.INVALID_PARAMS,
      `argumen wajib hilang untuk tool '${name}': ${keys.join(", ")} — lihat inputSchema.required`,
    )
  }
  if (input === undefined || input === null) {
    // Tanpa `arguments` sama sekali → tetap wajib penuhi required (bukan lolos).
    if (required.length) throwMissing(required)
    return // tanpa argumen & tanpa required = sah
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new McpError(ERR.INVALID_PARAMS, `arguments tool '${name}' wajib object`)
  }
  const props = (schema && schema.properties) || {}
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      throw new McpError(ERR.INVALID_PARAMS, `argumen '${key}' tidak didukung tool '${name}' — lihat inputSchema`)
    }
    const v = input[key]
    if (v === undefined || v === null) continue // null/undefined = tidak diisi (dicek `required` di bawah)
    const p = props[key] || {}
    if (Array.isArray(p.enum) && !p.enum.includes(v)) {
      throw new McpError(
        ERR.INVALID_PARAMS,
        `argumen '${key}' tidak valid untuk tool '${name}': ${JSON.stringify(v)} — nilai harus ${p.enum.join("|")}`,
      )
    }
    const t = p.type
    const bad =
      (t === "string" && typeof v !== "string") ||
      (t === "number" && (typeof v !== "number" || !Number.isFinite(v))) ||
      (t === "boolean" && typeof v !== "boolean") ||
      (t === "array" && !Array.isArray(v)) ||
      (t === "object" && (typeof v !== "object" || Array.isArray(v)))
    if (bad) throw new McpError(ERR.INVALID_PARAMS, `argumen '${key}' untuk tool '${name}' wajib ${t}`)
  }
  // required = kunci hilang ATAU bernilai null/undefined (tak boleh "undefined" tertulis)
  const miss = missingKeys(input)
  if (miss.length) throwMissing(miss)
}

// fireEvent() kini ada di dalam createTools (butuh akses createDomEvent) —
// semua pemanggilan berada di lingkup itu.

// Async supaya jsdom (engine-js) di-import DINAMIS hanya saat engine="js" —
// engine DOM (default) tak pernah memuat jsdom → startup cepat.
export async function createTools({ engine = "dom" } = {}) {
  const page = engine === "js" ? (await import("./engine-js.js")).createJsPage() : createPage()
  const jsMode = page.isJs === true

  // ================= util tool baru (semua engine) =================

  // Definisi tool ringkas: name + deskripsi + properties + handler (+ required).
  function def(name, description, properties = {}, handler, required) {
    return {
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        ...(required && required.length ? { required } : {}),
      },
      handler,
    }
  }

  // Path CSS ringkas dari elemen (tag#id | tag:nth-of-type(n) chain s/d html).
  function selectorPathOf(el) {
    const parts = []
    let node = el
    for (let depth = 0; node && depth < 8; depth++) {
      const tag = (node.tagName || "").toLowerCase()
      if (!tag) break
      if (node.id) { parts.unshift(`${tag}#${node.id}`); break }
      const parent = node.parentNode
      const sibs = parent && parent.children
        ? [...parent.children].filter((c) => (c.tagName || "").toLowerCase() === tag)
        : []
      if (sibs.length > 1) {
        const idx = sibs.findIndex((c) => c === node) + 1
        parts.unshift(`${tag}:nth-of-type(${idx})`)
      } else parts.unshift(tag)
      if (tag === "html") break
      node = parent
    }
    return parts.join(" > ") || (el.tagName || "").toLowerCase()
  }

  const MOUSE_TYPES = new Set(["click", "dblclick", "mouseover", "mouseout", "mouseenter", "mouseleave", "mousemove", "mousedown", "mouseup", "dragstart", "drag", "dragenter", "dragover", "dragleave", "drop", "dragend"])

  // Buat event sintetis: pakai konstructor khusus (MouseEvent/KeyboardEvent)
  // bila ada di window engine; linkedom hanya punya Event → fallback aman.
  function createDomEvent(page, type, init = {}) {
    const w = page.window || {}
    const ctors = []
    if (init.key !== undefined) ctors.push(w.KeyboardEvent, globalThis.KeyboardEvent)
    if (MOUSE_TYPES.has(type)) ctors.push(w.MouseEvent, globalThis.MouseEvent)
    ctors.push(w.Event, globalThis.Event)
    for (const C of ctors) {
      if (typeof C !== "function") continue
      try { return new C(type, { bubbles: true, cancelable: true, ...init }) } catch { /* coba konstructor berikut */ }
    }
    return null
  }

  // Dispatch event ke elemen; extra (mis. dataTransfer polyfill) ditempel ke event.
  function dispatchOn(page, el, type, init = {}, extra = null) {
    try {
      const ev = createDomEvent(page, type, init)
      if (!ev) return false
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          try { Object.defineProperty(ev, k, { value: v, configurable: true }) } catch { try { ev[k] = v } catch { /* readonly */ } }
        }
      }
      return el.dispatchEvent(ev)
    } catch { return false }
  }

  // Event default (tanpa init) — dipertahankan utk tool lama (click/fill/dll).
  function fireEvent(page, el, type) {
    try {
      const E = page.window?.Event
      if (E) el.dispatchEvent(new E(type))
    } catch {}
  }

  // Hook alert/confirm/prompt → queue `dialog`. Idempotent; dipanggil sebelum
  // js_eval & saat tab dipulihkan dari snapshot (window baru tanpa hook).
  function installDialogHooks(page) {
    const w = page?.window
    if (!w) return false
    try {
      w.alert = (m) => page._pushDialog("alert", m)
      w.confirm = (m) => { page._pushDialog("confirm", m); return true }
      w.prompt = (m, d) => { page._pushDialog("prompt", m); return d ?? "" }
      return true
    } catch { return false }
  }

  // ---- tab store (state di page — browser.js / engine-js.js) ----
  function ensureTabState(page) {
    if (!(page.tabs instanceof Map)) page.tabs = new Map()
    if (!(typeof page.tabSeq === "number")) page.tabSeq = 0
    if (!Array.isArray(page.dialogQueue)) page.dialogQueue = []
  }

  const tabNum = (id) => Number(String(id).replace(/\D/g, "")) || 0

  function listTabsView(page) {
    ensureTabState(page)
    const out = []
    for (const t of page.tabs.values()) {
      out.push({ id: t.id, url: t.url, title: t.title, status: t.status, active: false, savedAt: t.savedAt })
    }
    if (page.document && page.activeTabId) {
      out.push({ id: page.activeTabId, url: page.currentUrl, title: page.title, status: page.status, active: true })
    }
    out.sort((a, b) => tabNum(a.id) - tabNum(b.id))
    return out
  }

  const TAB_HTML_CAP = 2 * 1024 * 1024 // batas snapshot HTML per tab (2MB)
  const MAX_TABS = 16 // cap jumlah tab — tanpa ini 60× tabs_open bikin tab tanpa batas

  // Simpan tab aktif (live) ke map sebagai snapshot — dipakai tabs_open/focus/close.
  function saveActiveTab(page) {
    if (!page.document || !page.activeTabId) return false
    ensureTabState(page)
    let html = ""
    try { html = page.document.toString() } catch { return false }
    let truncated = false
    if (html.length > TAB_HTML_CAP) { html = html.slice(0, TAB_HTML_CAP); truncated = true }
    page.tabs.set(page.activeTabId, {
      id: page.activeTabId,
      url: page.currentUrl,
      title: page.title,
      status: page.status,
      html,
      truncated,
      history: [...(page.history || [])],
      historyIndex: page.historyIndex,
      savedAt: Date.now(),
    })
    return true
  }

  // Pulihkan tab dari snapshot HTML lokal (TANPA refetch — jujur di note).
  // Script di-strip: restore tak menjalankan ulang JS halaman.
  async function restoreTab(page, snap) {
    ensureTabState(page)
    const html = String(snap.html || "").slice(0, TAB_HTML_CAP).replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    if (jsMode) {
      const { JSDOM } = await import("jsdom")
      const dom = new JSDOM(html, { url: snap.url || "http://localhost/", pretendToBeVisual: true })
      page.window = dom.window
      page.document = dom.window.document
      if (typeof page._patchGlobals === "function") {
        try {
          // Tukar pemilik globalThis lewat antrean YANG SAMA dengan navigate
          // (P1 R6): jangan curi patch di tengah navigate sesi lain.
          const { withJsLock } = await import("./engine-js.js")
          await withJsLock(() => page._patchGlobals(dom.window))
        } catch { /* best-effort */ }
      }
    } else {
      const { parseHTML } = await import("linkedom")
      const p = parseHTML(html)
      page.window = p.window
      page.document = p.document
    }
    installDialogHooks(page)
    page.currentUrl = snap.url
    page.title = snap.title || ""
    page.status = snap.status ?? null
    page.headers = {} // snapshot tanpa response headers asli
    page.timing = null
    page.history = Array.isArray(snap.history) ? [...snap.history] : []
    page.historyIndex = Number.isInteger(snap.historyIndex) ? snap.historyIndex : page.history.length - 1
    page.activeTabId = snap.id
    page.tabs.delete(snap.id)
    page.consoleLogs.push({ level: "info", message: `tab ${snap.id} dipulihkan dari snapshot lokal (script tidak dijalankan ulang)` })
  }

  // Matikan halaman live (dipakai saat tab aktif ditutup tanpa pengganti).
  function clearLivePage(page) {
    page.document = null
    page.window = null
    page.currentUrl = null
    page.status = null
    page.headers = {}
    page.timing = null
    page.title = ""
    page.activeTabId = null
    page.history = []
    page.historyIndex = -1
  }

  // ---- isi form (dipakai fill + fill_form) ----
  function setSelectValue(page, el, value) {
    const opts = [...(el.options || el.querySelectorAll("option"))]
    const opt = opts.find((o) => o.value === value || (o.textContent || "").trim() === value)
    if (!opt) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Option tidak ditemukan: ${value}`)
    try { opt.selected = true } catch { /* linkedom: setter opsional */ }
    try { el.value = opt.value } catch { /* readonly */ }
    fireEvent(page, el, "change")
    return String(el.value || opt.value)
  }

  function fillElement(page, selector, value) {
    const sel = parseSelector(selector)
    const el = page.document.querySelector(sel)
    if (!el) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
    const tag = el.tagName?.toLowerCase()
    if (tag === "select") {
      const v = setSelectValue(page, el, value)
      return { filled: sel, type: "select", select: v, value: v }
    }
    el.value = String(value)
    el.setAttribute?.("value", String(value))
    fireEvent(page, el, "input")
    fireEvent(page, el, "change")
    return { filled: sel, type: tag, value: String(value) }
  }

  // ---- file: File/FileList/DataTransfer polyfill (engine tanpa picker OS) ----
  function makeFile({ name = "upload.txt", content, base64, type = "text/plain" } = {}) {
    const buf = base64 ? Buffer.from(decodeBase64Strict(base64), "base64") : Buffer.from(String(content ?? ""), "utf8")
    const FileC = (page.window && page.window.File) || globalThis.File
    if (typeof FileC === "function") {
      try { return new FileC([buf], name, { type }) } catch { /* fallback Blob */ }
    }
    const BlobC = (page.window && page.window.Blob) || globalThis.Blob
    if (typeof BlobC === "function") {
      try {
        const b = new BlobC([buf], { type })
        try { b.name = name } catch { /* Blob frozen */ }
        return b
      } catch { /* fallback objek */ }
    }
    return { name, type, size: buf.length, __buf: buf, async text() { return buf.toString("utf8") } }
  }

  function makeFileList(files) {
    const list = { length: files.length, item: (i) => files[i] ?? null }
    files.forEach((f, i) => { list[i] = f })
    return list
  }

  function attachFileList(el, files) {
    const list = makeFileList(files)
    try { Object.defineProperty(el, "files", { value: list, configurable: true, writable: true }) }
    catch { try { el.files = list } catch { /* getter-only */ } }
    try { el.__mcpFiles = files } catch { /* elemen frozen */ }
    if (files[0]) { try { el.value = `C:\\fakepath\\${files[0].name}` } catch { /* file input readonly */ } }
    return list
  }

  function makeDataTransfer(files = [], data = {}) {
    const store = { ...data }
    return {
      data: store, // referensi langsung — setData/clearData memodifikasi objek yang sama
      files: makeFileList(files),
      items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
      types: Object.keys(store),
      dropEffect: "none",
      effectAllowed: "all",
      setData(k, v) { store[k] = String(v); if (!this.types.includes(k)) this.types.push(k) },
      getData(k) { return store[k] ?? "" },
      clearData() { for (const k of Object.keys(store)) delete store[k]; this.types = [] },
    }
  }

  function requireFileInput(page, selector) {
    const sel = parseSelector(selector)
    const el = page.document.querySelector(sel)
    if (!el) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
    const tag = el.tagName?.toLowerCase()
    const type = (el.getAttribute?.("type") || el.type || "").toLowerCase()
    if (tag !== "input" || type !== "file") throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Bukan input[type=file]: ${sel}`)
    return { sel, el }
  }

  // ---- state closure: trace / cpu (per-instance, dibersihkan tool reset) ----
  const perfNow = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now())
  let traceState = null // {label, t0, marks:[]} — sedang berjalan
  let lastTrace = null // hasil trace terakhir (setelah stop) — bahan analyze
  let cpuState = null
  let lastCpu = null
  let lastHoverEl = null // elemen hover terakhir — hover berikutnya kirim mouseout dulu

  // Tool yang butuh desktop browser/Chromium — engine js/dom TIDAK punya
  // CDP/DevTools. Error terstruktur, JANGAN mengarang hasil (sama jujurnya
  // dengan builtin "No desktop browser is connected").
  function desktopOnly(name, description) {
    return def(name, description, {}, () => {
      throw new McpError(ERR.TOOL_EXECUTION_FAILED, "butuh desktop browser/Chromium — engine js/dom tidak mendukung")
    })
  }

  const tools = [
    {
      name: "navigate",
      description: "Buka halaman web. Ambil HTML, parse DOM, siapkan interaksi. Wajib dipanggil pertama.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL tujuan (http/https)" },
          headers: { type: "object", description: "Header request tambahan (opsional)" },
          timeoutMs: { type: "number", description: "Timeout dalam ms (default 30000)" },
        },
        required: ["url"],
      },
      async handler({ url, headers, timeoutMs }) {
        assertSafeTarget(url) // tolak non-http(s) + target private/lokal (SSRF)
        const s = await page.navigate(url, { headers: sanitizeHeaders(headers), timeoutMs })
        return text(toJson(s))
      },
    },

    {
      name: "get_content",
      description: "Lihat isi halaman: teks bersih (default), HTML mentah, atau metadata. Untuk 'melihat tampilan' tanpa browser visual.",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string", enum: ["text", "html", "summary"],
            description: "text = teks halaman, html = HTML mentah (terpotong 50KB), summary = ringkasan metadata",
          },
        },
      },
      async handler({ format = "text" }) {
        requirePage(page)
        if (format === "html") return text(page.html())
        if (format === "summary") return text(toJson(page.summary()))
        return text(page.textContent())
      },
    },

    {
      name: "query",
      description: "Cari elemen dengan CSS selector. Return daftar elemen (tag, id, class, teks pendek).",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
          limit: { type: "number", description: "Maks hasil (default 20)" },
        },
        required: ["selector"],
      },
      async handler({ selector, limit = 20 }) {
        requirePage(page)
        const sel = parseSelector(selector)
        const max = Number.isInteger(limit) && limit > 0 ? limit : 20
        const all = page.document.querySelectorAll(sel) // sekali query — total & potongan dari hasil yang sama
        const els = [...all].slice(0, max)
        const out = els.map((el, i) => ({
          index: i,
          tag: el.tagName?.toLowerCase(),
          id: el.id || undefined,
          cls: el.className && typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3) : undefined,
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
          href: el.getAttribute?.("href") || undefined,
          src: el.getAttribute?.("src") || undefined,
        }))
        return text(toJson({ count: els.length, total: all.length, items: out }))
      },
    },

    {
      name: "click",
      description: "Klik elemen via CSS selector. Untuk link: ikuti href (navigasi). Untuk button/checkbox: simulasikan klik.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector elemen" },
        },
        required: ["selector"],
      },
      async handler({ selector }) {
        requirePage(page)
        const sel = parseSelector(selector)
        const el = page.document.querySelector(sel)
        if (!el) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
        const tag = el.tagName?.toLowerCase()
        if (tag === "a" && el.getAttribute("href")) {
          const href = el.getAttribute("href")
          const url = new URL(href, page.currentUrl).toString()
          assertSafeTarget(url) // klik link tak boleh menuju target private/lokal (SSRF)
          page.consoleLogs.push({ level: "info", message: `click link ${sel} → ${url}` })
          const s = await page.navigate(url)
          return text(toJson({ clicked: sel, navigated: true, ...s }))
        }
        if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
          el.checked = !el.checked
          page.consoleLogs.push({ level: "info", message: `toggle ${sel} → ${el.checked}` })
          return text(toJson({ clicked: sel, type: "toggle", checked: el.checked }))
        }
        // button / div — trigger event click. Mode JS (jsdom): listener halaman DIEKSEKUSI (SPA hidup).
        fireEvent(page, el, "click")
        page.consoleLogs.push({ level: "info", message: `click ${sel} (${tag})` })
        const note = jsMode ? "JS engine aktif — listener halaman dieksekusi" : "klik DOM (tanpa JS engine penuh)"
        return text(toJson({ clicked: sel, type: tag, engine: jsMode ? "js" : "dom", note }))
      },
    },

    {
      name: "fill",
      description: "Isi input/textarea/select. Untuk select: value option.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string" },
          value: { type: "string", description: "Nilai yang diisi" },
        },
        required: ["selector", "value"],
      },
      async handler({ selector, value }) {
        requirePage(page)
        // Logika isi field dipakai bersama fill_form (fillElement).
        return text(toJson(fillElement(page, selector, value)))
      },
    },

    {
      name: "submit",
      description: "Submit form via CSS selector. Form method GET → ikuti action dengan query param; POST → catat (butuh JS engine untuk AJAX).",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector form (default 'form')" },
        },
      },
      async handler({ selector = "form" }) {
        requirePage(page)
        const sel = parseSelector(selector)
        const form = page.document.querySelector(sel)
        if (!form) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Form tidak ditemukan: ${sel}`)
        const method = (form.getAttribute("method") || "GET").toUpperCase()
        const action = form.getAttribute("action") || page.currentUrl
        const data = new URLSearchParams()
        for (const el of form.querySelectorAll("input, select, textarea")) {
          const name = el.getAttribute("name")
          if (!name) continue
          const tag = el.tagName?.toLowerCase()
          if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
            if (el.checked || el.hasAttribute?.("checked")) data.append(name, el.value || "on")
          } else if (tag === "select") {
            data.append(name, el.value)
          } else {
            data.append(name, el.value ?? "")
          }
        }
        if (method === "GET") {
          const target = new URL(action, page.currentUrl)
          data.forEach((v, k) => target.searchParams.append(k, v))
          assertSafeTarget(target.toString()) // submit GET tak boleh menuju target private/lokal (SSRF)
          page.consoleLogs.push({ level: "info", message: `form GET ${sel} → ${target}` })
          const s = await page.navigate(target.toString())
          return text(toJson({ submitted: sel, method, ...s }))
        }
        // POST: tanpa JS engine catat saja; dengan JS engine, form submit asli tetap perlu
        // tombol submit di halaman — kami catat agar tidak salah eksekusi.
        page.consoleLogs.push({ level: "warn", message: `form POST ${sel} — tidak dieksekusi langsung (jelas via tombol submit / JS)` })
        return text(toJson({ submitted: sel, method, engine: jsMode ? "js" : "dom", note: jsMode ? "POST tidak dieksekusi langsung — pakai click() pada tombol submit bila perlu" : "POST butuh JS engine — hanya dicatat", action }))
      },
    },

    {
      name: "wait",
      description: "Tunggu beberapa detik (bukan sleep murni — bantu halaman yang lambat).",
      inputSchema: {
        type: "object",
        properties: { ms: { type: "number", description: "Milidetik (default 1000)" } },
      },
      async handler({ ms = 1000 }) {
        const waitMs = Math.min(Math.max(Number(ms) || 0, 0), 30000)
        await new Promise((r) => setTimeout(r, waitMs))
        const note = jsMode ? "jeda — JS engine memproses timer/microtask halaman" : "dalam mode tanpa JS engine, wait tidak menambah apa pun selain jeda"
        return text(toJson({ waitedMs: waitMs, note }))
      },
    },

    {
      name: "js_eval",
      description: "Jalankan ekspresi JavaScript di konteks halaman (debug) — HANYA untuk klien tepercaya. Engine JS (stdio --js): window.eval penuh — window/document/location/sessionStorage/getComputedStyle LIVE. Engine DOM: vm minimal (document + window sederhana; API browser tak ada — pakai engine JS untuk konteks penuh). vm BUKAN sandbox keamanan.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Ekspresi/statement JS. Gunakan return ... untuk hasil." },
        },
        required: ["code"],
      },
      async handler({ code }) {
        requirePage(page)
        if (!code || typeof code !== "string") throw new McpError(ERR.INVALID_PARAMS, "code wajib string")
        // Hook alert/confirm/prompt SEBELUM eval → dialog masuk antrean, tidak crash.
        installDialogHooks(page)
        // Mode JS: eksekusi di konteks halaman penuh (window.eval — JS hidup).
        // `return ...` top-level = ilegal di eval → fallback bungkus function body
        // (ekspresi biasa tetap dapat completion value seperti biasa).
        if (jsMode) {
          const run = (src) => page.window.eval(src)
          let result
          try {
            result = run(code)
          } catch (e) {
            if (e && e.name === "SyntaxError" && /Illegal return/i.test(String(e.message))) {
              result = run(`(function(){\n${code}\n})()`)
            } else throw e
          }
          return text(toJson({ engine: "js", result: typeof result === "string" ? result : result }))
        }
        // Mode DOM: solusi ringan dengan vm; ekspos document/window minimal.
        // CATATAN KEAMANAN: vm BUKAN sandbox — context bisa di-escape.
        // Tool ini hanya untuk klien tepercaya (lihat deskripsi tool).
        const vm = await import("vm")
        const sandbox = {
          document: page.document,
          window: { location: { href: page.currentUrl }, title: page.title },
          // dialog → antrean `dialog` (engine DOM tak punya window penuh).
          alert: (m) => page._pushDialog("alert", m),
          confirm: (m) => { page._pushDialog("confirm", m); return true },
          prompt: (m, d) => { page._pushDialog("prompt", m); return d ?? "" },
          URL, console, JSON, Math, Date, encodeURIComponent,
        }
        vm.createContext(sandbox)
        let result
        try {
          result = vm.runInContext(code, sandbox, { timeout: 2000 })
        } catch (e) {
          if (e && e.name === "SyntaxError" && /Illegal return/i.test(String(e.message))) {
            result = vm.runInContext(`(function(){\n${code}\n})()`, sandbox, { timeout: 2000 })
          } else throw e
        }
        return text(toJson({ engine: "dom", result: typeof result === "string" ? result : result, note: "engine DOM — API browser (sessionStorage/location/getComputedStyle) hanya di engine JS (stdio --js)" }))
      },
    },

    {
      name: "console_get",
      description: "Ambil log console yang terekam selama sesi (debug).",
      inputSchema: { type: "object", properties: { clear: { type: "boolean", description: "Kosongkan setelah diambil" } } },
      async handler({ clear = false }) {
        const logs = page.consoleLogs.slice()
        if (clear) page.consoleLogs.length = 0
        return text(toJson({ count: logs.length, logs }))
      },
    },

    {
      name: "network_logs",
      description: "Riwayat request/response sesi (debug): URL, status, tipe, timing.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        return text(toJson({ count: page.networkLogs.length, logs: page.networkLogs }))
      },
    },

    {
      name: "cookies",
      description: "Lihat cookie yang berlaku untuk host halaman SAAT INI (termasuk induk domainnya) / bersihkan semua cookie sesi. 'list' tidak menampilkan cookie domain lain.",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["list", "clear"], description: "default list" } },
      },
      async handler({ action = "list" }) {
        if (action === "clear") {
          page.clearCookies()
          return text(toJson({ cleared: true }))
        }
        return text(toJson({ cookies: page.getCookiesForCurrent() })) // difilter per-host current
      },
    },

    {
      name: "history",
      description: "Riwayat navigasi sesi + opsi back/forward.",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["list", "back", "forward"], description: "default list" } },
      },
      async handler({ action = "list" }) {
        if (action === "back" || action === "forward") {
          const dir = action === "back" ? -1 : 1
          const next = page.historyIndex + dir
          if (next < 0 || next >= page.history.length) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Tidak bisa ${action} (di ujung history)`)
          page.historyIndex = next
          const url = page.history[next]
          const s = await page.navigate(url)
          return text(toJson({ action, url, ...s }))
        }
        return text(toJson({ history: page.history, index: page.historyIndex }))
      },
    },

    {
      name: "screenshot",
      description: "Screenshot halaman → PNG wireframe utk dilihat AI (murni Node: TANPA Chromium, TANPA Playwright) + box tree meta. Fitur: <img> asli (decode PNG/JPEG), overflow clip, border-radius, gradient, deviceScale 1–3. format text/html = snapshot struktural lama; format tree = JSON layout ringan tanpa gambar. CSS cascade penuh di engine js.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["text", "html", "png", "tree"], description: "default text; png = gambar wireframe; tree = box tree JSON (tanpa PNG)" },
          width: { type: "number", description: "lebar px, default 1024 (64–4096)" },
          height: { type: "number", description: "tinggi px, default 768 (64–4096)" },
          selector: { type: "string", description: "render subtree ini saja (CSS selector); default body" },
          fullPage: { type: "boolean", description: "tinggi = tinggi konten penuh (maks 8192)" },
          deviceScale: { type: "number", description: "rasio piksel 1–3 (2 = retina/tajam), default 1" },
          outline: { type: "boolean", description: "outline merah di tepi (hanya dgn selector) — penanda target" },
          maxDepth: { type: "number", description: "kedalaman box tree, default 12 (tree) / 8 (meta png)" },
          maxNodes: { type: "number", description: "maks node box tree, default 800/400" },
        },
      },
      async handler({ format = "text", width, height, selector, fullPage, deviceScale, outline, maxDepth, maxNodes } = {}) {
        requirePage(page)
        if (format === "text" || format === "html") {
          return text(format === "html" ? page.html() : page.textContent())
        }
        // P1 R4: aset (stylesheet/gambar) di-fetch dgn timeout 10s — gagal =
        // render LANJUT tanpa aset itu + `notes` jujur, TIDAK menggantung
        // (dulu: stylesheet/gambar yang tak pernah merespons menggantungkan
        // screenshot ±301 detik). Catat kegagalannya di sini.
        // P2-4 R5: screenshot mendaftarkan AbortController SENDIRI ke page
        // (page._shotCtl + _inflight kind:'shot') → tool `stop` kini bisa
        // membatalkan fetch aset & render yang sedang jalan (dulu stop jawab
        // "tidak ada inflight" dan screenshot lanjut 32176ms).
        const ctl = new AbortController()
        const inflight = { url: page.currentUrl || "screenshot", startedAt: Date.now(), phase: "assets", kind: "shot" }
        page._shotCtl = ctl
        page._inflight = inflight
        const guard = () => {
          if (ctl.signal.aborted) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "screenshot dibatalkan oleh stop")
        }
        try {
          const notes = []
          if (typeof page.ensureStyles === "function") {
            try {
              const st = await page.ensureStyles()
              for (const f of st?.failed || []) notes.push(`stylesheet gagal dimuat: ${f}`)
            } catch (e) {
              notes.push(`stylesheet gagal dimuat: ${e?.message || e}`) // cascade best-effort
            }
          }
          guard()
          if (format === "tree") {
            const { layoutTree } = await import("./render-shot.js")
            const out = await layoutTree(page, { width, selector, maxDepth, maxNodes })
            guard()
            return text(toJson({ format: "tree", ...out, ...(notes.length ? { notes } : {}) }))
          }
          const { renderShot } = await import("./render-shot.js")
          const out = await renderShot(page, { width, height, selector, fullPage, deviceScale, outline, maxDepth, maxNodes })
          guard()
          for (const f of out.imageFailed || []) notes.push(`gambar gagal dimuat: ${f}`)
          const file = writeShotFile(out.png)
          return {
            content: [
              { type: "image", data: out.png.toString("base64"), mimeType: "image/png" },
              {
                type: "text",
                text: toJson({
                  format: "png",
                  file,
                  width: out.width,
                  height: out.height,
                  pixels: { width: out.pixelWidth, height: out.pixelHeight },
                  deviceScale: out.deviceScale,
                  boxes: out.boxes,
                  images: out.images,  // <img> asli ter-decode
                  css: out.css,        // cascade (engine js) | inline (engine dom)
                  font: out.font,      // false = teks tak digambar (boxes tetap)
                  truncated: out.truncated,
                  tree: out.tree,      // box ringkas utk AI (cap node)
                  ...(notes.length ? { notes } : {}),
                  note: "wireframe (layout approximation) — bukan pixel-perfect; bila image tak tampil, buka file",
                }),
              },
            ],
            isError: false,
          }
        } finally {
          // Bersihkan state HANYA kalau masih milik call ini (tak menimpa
          // inflight milik navigate lain yang mungkin sedang berjalan).
          if (page._shotCtl === ctl) page._shotCtl = null
          if (page._inflight === inflight) page._inflight = null
        }
      },
    },

    {
      name: "reset",
      description: "Reset seluruh sesi (bersihkan halaman, history, cookies, log, tab, dialog, trace/cpu).",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        page.reset()
        // State closure (bukan milik page) — bersihkan juga di sini.
        traceState = null
        lastTrace = null
        cpuState = null
        lastCpu = null
        lastHoverEl = null
        return text(toJson({ reset: true }))
      },
    },
  ]

  // ================= 40 tool baru = 37 handler + 3 alias =================
  // Surface builtin opencode.browser (45) + 9 tool lama = 54. Nama MCP flat:
  // dotted → underscore (tabs.list → tabs_list, dll). Plugin OpenCode
  // menerjemahkan balik ke dotted via namespace per-tool.
  tools.push(
    // ---- tabs (multi-halaman, state di page: browser.js / engine-js.js) ----
    def("tabs_list", "Daftar tab terbuka: id, url, title, tab aktif. Tab non-aktif = snapshot HTML lokal, tab aktif = halaman live.", {}, () => {
      ensureTabState(page)
      const tabs = listTabsView(page)
      return text(toJson({ count: tabs.length, active: page.activeTabId || null, tabs }))
    }),

    def("tabs_open", "Buka URL di tab BARU: tab aktif disimpan dulu sebagai snapshot, lalu navigasi. Nav stack tab baru mulai kosong.", {
      url: { type: "string", description: "URL tujuan (http/https)" },
    }, async ({ url }) => {
      assertSafeTarget(url)
      ensureTabState(page)
      // Cap tab: cek SEBELUM menyentuh state (saveActiveTab/navigate).
      if (listTabsView(page).length >= MAX_TABS) {
        throw new McpError(ERR.TOOL_EXECUTION_FAILED, `tab penuh (maks ${MAX_TABS}) — tutup dulu`)
      }
      const prevId = page.activeTabId
      const hadPage = !!page.document
      if (hadPage) saveActiveTab(page)
      page.history = [] // nav stack tab baru
      page.historyIndex = -1
      page.tabSeq = (page.tabSeq || 0) + 1
      page.activeTabId = `tab-${page.tabSeq}`
      try {
        const s = await page.navigate(url)
        return text(toJson({ opened: page.activeTabId, tabs: listTabsView(page), ...s }))
      } catch (e) {
        // Navigasi gagal → pulihkan keadaan tab sebelumnya (snapshot ada di map).
        const snap = hadPage && prevId ? page.tabs.get(prevId) : null
        if (snap && !page.document) {
          try { await restoreTab(page, snap) } catch { /* snapshot tak terpakai — biarkan */ }
        } else if (snap) {
          page.activeTabId = prevId
          page.tabs.delete(prevId)
          page.history = [...snap.history]
          page.historyIndex = snap.historyIndex
        } else {
          page.activeTabId = hadPage ? prevId : null
          if (!hadPage) page.tabSeq = Math.max(0, page.tabSeq - 1)
        }
        throw e
      }
    }, ["url"]),

    def("tabs_focus", "Pindah ke tab lain: tab aktif disimpan ke snapshot, tab tujuan dipulihkan dari snapshot HTML lokal (tanpa refetch, script TIDAK dijalankan ulang).", {
      id: { type: "string", description: "Id tab (lihat tabs_list)" },
    }, async ({ id }) => {
      ensureTabState(page)
      if (!id || typeof id !== "string") throw new McpError(ERR.INVALID_PARAMS, "id wajib string")
      if (id === page.activeTabId && page.document) {
        return text(toJson({ focused: id, unchanged: true, tabs: listTabsView(page) }))
      }
      const snap = page.tabs.get(id)
      if (!snap) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Tab tidak ditemukan: ${id}`)
      if (page.document && page.activeTabId) saveActiveTab(page)
      await restoreTab(page, snap)
      return text(toJson({ focused: id, url: page.currentUrl, title: page.title, tabs: listTabsView(page), note: "tab dipulihkan dari snapshot HTML lokal — script tidak dijalankan ulang" }))
    }, ["id"]),

    def("tabs_close", "Tutup tab. Tab non-aktif: snapshot dihapus. Tab aktif: fokus pindah ke tab tersimpan terakhir; bila itu tab terakhir → tidak ada halaman aktif.", {
      id: { type: "string", description: "Id tab (lihat tabs_list)" },
    }, async ({ id }) => {
      ensureTabState(page)
      if (!id || typeof id !== "string") throw new McpError(ERR.INVALID_PARAMS, "id wajib string")
      if (id !== page.activeTabId) {
        if (!page.tabs.has(id)) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Tab tidak ditemukan: ${id}`)
        page.tabs.delete(id)
        return text(toJson({ closed: id, active: page.activeTabId || null, tabs: listTabsView(page) }))
      }
      // Tab aktif ditutup — state live sengaja dibuang (tanpa snapshot).
      page.tabs.delete(id)
      const remaining = [...page.tabs.keys()]
      clearLivePage(page)
      if (remaining.length) {
        const nextId = remaining[remaining.length - 1]
        await restoreTab(page, page.tabs.get(nextId))
        return text(toJson({ closed: id, active: nextId, tabs: listTabsView(page), note: "tab aktif ditutup — fokus pindah ke tab tersimpan terakhir" }))
      }
      page.tabSeq = 0 // tab terakhir — penomoran tab mulai segar
      return text(toJson({ closed: id, active: null, tabs: [], note: "tab terakhir ditutup — tidak ada halaman aktif (navigate untuk buka lagi)" }))
    }, ["id"]),

    // ---- navigasi ----
    def("preview", "Pratinjau cepat halaman: url, judul, kepala teks (200 karakter).", {}, () => {
      requirePage(page)
      return text(toJson({ url: page.currentUrl, title: page.title, status: page.status, textHead: page.textContent().slice(0, 200) }))
    }),

    def("back", "Kembali ke kunjungan sebelumnya (nav stack per tab) — muat ulang via refetch seperti navigate.", {}, async () => {
      requirePage(page)
      const next = page.historyIndex - 1
      if (next < 0) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "Tidak bisa back (di ujung history)")
      const url = page.history[next]
      page.historyIndex = next
      const s = await page.navigate(url)
      return text(toJson({ action: "back", url, tab: page.activeTabId, ...s }))
    }),

    def("forward", "Maju ke kunjungan berikutnya (nav stack per tab) — muat ulang via refetch seperti navigate.", {}, async () => {
      requirePage(page)
      const next = page.historyIndex + 1
      if (next >= page.history.length) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "Tidak bisa forward (di ujung history)")
      const url = page.history[next]
      page.historyIndex = next
      const s = await page.navigate(url)
      return text(toJson({ action: "forward", url, tab: page.activeTabId, ...s }))
    }),

    def("reload", "Muat ulang URL sekarang: refetch penuh, DOM dibangun ulang.", {}, async () => {
      requirePage(page)
      if (!page.currentUrl) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "Belum ada halaman. Jalankan 'navigate' dulu.")
      const url = page.currentUrl
      const s = await page.navigate(url)
      return text(toJson({ reloaded: url, tab: page.activeTabId, ...s, note: "refetch penuh — DOM dibangun ulang" }))
    }),

    def("stop", "Batalkan navigasi inflight ATAU screenshot yang sedang berjalan. Navigasi: AbortController dipicu → navigate melempar error 'dibatalkan oleh stop'. Screenshot: AbortController screenshot (page._shotCtl) dipicu → fetch aset stylesheet/gambar DI-ABORT + render berhenti → tool screenshot melempar error 'screenshot dibatalkan oleh stop' (dulu stop mustahil menyentuh screenshot — jawab 'tidak ada inflight' sementara screenshot lanjut puluhan detik menahan antrean). Fase settle (engine js, post-fetch): signal navigate kini dibawa oleh SEMUA I/O settle (fetch script klasik, mirror module, fetch halaman, import module di-race) → stop MEMBATALKAN I/O itu → navigate DIPASTIKAN melempar 'dibatalkan oleh stop' segera, tidak diselesaikan sukses; batas jujur: kode sync halaman (mis. eval loop tak terputus / `while(true)` di script halaman) membekukan SELURUH proses — stop dan SEMUA tool ikut mati sampai proses di-kill, jadi stop tak menolong di skenario itu. Tanpa inflight → {stopped:false, note:'tidak ada inflight'} (jujur, bukan sukses palsu).", {}, () => {
      const infl = page._inflight
      if (!infl) return text(toJson({ stopped: false, note: "tidak ada inflight" }))
      // P2-4 R5: yang berjalan adalah SCREENSHOT (bukan navigate) → batalkan
      // lewat AbortController milik screenshot: fetch aset langsung abort,
      // guard di handler screenshot melempar error 'dibatalkan oleh stop'.
      if (infl.kind === "shot") {
        const ctl = page._shotCtl
        let aborted = false
        if (ctl && typeof ctl.abort === "function") {
          try {
            ctl.__mcpStoppedByStop = true
            ctl.abort()
            aborted = ctl.signal?.aborted === true
          } catch { /* controller sudah dilepas */ }
        }
        return text(toJson({
          stopped: aborted,
          kind: "shot",
          phase: "assets",
          inflight: { url: infl.url, ageMs: Date.now() - infl.startedAt, phase: "assets", kind: "shot" },
          note: aborted
            ? "screenshot dibatalkan — fetch aset (stylesheet/gambar) di-abort → tool screenshot melempar error 'dibatalkan oleh stop', antrean tidak lagi tertahan"
            : "screenshot inflight tapi AbortController tak tersedia — hanya ditandai, tak dihentikan",
        }))
      }
      let aborted = false
      if (page._abort && typeof page._abort.abort === "function") {
        try {
          // Tandai controller SEBELUM abort → navigate membedakan
          // "dibatalkan oleh stop" vs "Timeout setelah Xms" (browser.js/engine-js.js).
          page._abort.__mcpStoppedByStop = true
          page._abort.abort()
          aborted = page._abort.signal?.aborted === true
        } catch { /* controller sudah dilepas */ }
      }
      // fase = 'settle' berarti body sudah terbaca: sejak fix P1 R3 signal
      // abort DIWARISKAN ke semua I/O fase settle → abort di baris atas ikut
      // membatalkan fetch script/module yang menggantung; flag tetap menutup
      // titik tanpa await → outcome batal, bukan "stop bohong, navigate sukses".
      const phase = infl.phase === "settle" ? "settle" : "fetch"
      return text(toJson({
        stopped: aborted,
        phase,
        inflight: { url: infl.url, ageMs: Date.now() - infl.startedAt, phase },
        note: aborted
          ? phase === "fetch"
            ? "AbortController dipicu — fetch inflight dibatalkan (navigate berjalan akan melempar error 'dibatalkan oleh stop')"
            : "fase settle (body sudah terbaca) — signal abort navigate kini membawa semua I/O settle (fetch script, mirror module, import module) → stop MEMBATALKAN I/O itu dan navigate dilempar error 'dibatalkan oleh stop' segera, TIDAK diselesaikan sukses; batas: kode sync halaman (eval loop tak terputus / while(true) di script halaman) membekukan SELURUH proses — stop dan semua tool mati sampai proses di-kill"
          : "inflight terdeteksi tapi tidak ada AbortController aktif — hanya ditandai, tak dihentikan",
      }))
    }),

    def("frames", "Daftar iframe/frame di DOM: src, id, loaded. Konten iframe TIDAK di-fetch engine js/dom. Tanpa iframe → [].", {}, () => {
      requirePage(page)
      const els = [...page.document.querySelectorAll("iframe, frame")]
      const items = els.map((el, i) => ({
        index: i,
        selectorPath: selectorPathOf(el),
        src: el.getAttribute("src") || "",
        id: el.id || undefined,
        title: el.getAttribute("title") || undefined,
        loaded: !!(el.contentDocument || el.contentWindow),
      }))
      return text(toJson({ count: items.length, frames: items, note: "daftar iframe di DOM hasil parse — engine js/dom tidak me-load isi iframe" }))
    }),

    // ---- inspeksi ----
    def("snapshot", "Outline terstruktur halaman (tag+id+class+teks, rekursif, ber-batas) — framing ringkas untuk AI, berbeda dari get_content.", {
      maxDepth: { type: "number", description: "Kedalaman maks pohon (default 6, cap 32)" },
      maxNodes: { type: "number", description: "Maks node (default 400, cap 5000)" },
    }, ({ maxDepth = 6, maxNodes = 400 } = {}) => {
      requirePage(page)
      const depthLim = Number.isInteger(maxDepth) && maxDepth > 0 ? Math.min(maxDepth, 32) : 6
      const cap = Number.isInteger(maxNodes) && maxNodes > 0 ? Math.min(maxNodes, 5000) : 400
      const budget = { n: 0, max: cap }
      const outline = (el, d) => {
        if (!el || budget.n >= budget.max) return null
        budget.n++
        const node = { tag: (el.tagName || "").toLowerCase() }
        if (el.id) node.id = el.id
        const cls = typeof el.className === "string" ? el.className.trim() : ""
        if (cls) node.cls = cls.split(/\s+/).slice(0, 3).join(" ")
        let own = ""
        for (const c of el.childNodes || []) if (c.nodeType === 3) own += c.textContent + " "
        own = own.replace(/\s+/g, " ").trim()
        if (own) node.text = own.slice(0, 80)
        const kids = [...(el.children || [])]
        if (kids.length) {
          if (d < depthLim) {
            const out = []
            for (const k of kids) {
              const cn = outline(k, d + 1)
              if (!cn) break
              out.push(cn)
            }
            if (out.length) node.children = out
            else node.truncated = true
          } else node.childrenOmitted = kids.length
        }
        return node
      }
      const root = outline(page.document.documentElement || page.document.body, 0)
      return text(toJson({ url: page.currentUrl, title: page.title, maxDepth: depthLim, maxNodes: cap, truncated: budget.n >= cap, root }))
    }),

    def("find", "Cari teks biasa ATAU regex di DOM (pencocokan teks langsung elemen) → [{selectorPath, tag, text}], maks 50 hasil. Regex pemanggil dijalankan dengan batas waktu FIND_TIMEOUT_MS — pola jahat (ReDoS) dihentikan, bukan membekukan proses.", {
      text: { type: "string", description: "Teks yang dicari (contains)" },
      pattern: { type: "string", description: "Sumber regex JS — alternatif text" },
      flags: { type: "string", description: "Flag regex (default 'i')" },
      limit: { type: "number", description: "Maks hasil (default 50, cap 50)" },
    }, async ({ text: q, pattern, flags = "i", limit = 50 } = {}) => {
      requirePage(page)
      if (!q && !pattern) throw new McpError(ERR.INVALID_PARAMS, "butuh text atau pattern")
      const max = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 50
      const all = [...page.document.querySelectorAll("*")].slice(0, 5000)
      // Kumpulkan teks langsung per elemen dulu (urutan sama dgn loop lama;
      // elemen tanpa teks langsung tetap di-skip saat mencocokkan).
      const texts = []
      const els = []
      for (const el of all) {
        let own = ""
        for (const c of el.childNodes || []) if (c.nodeType === 3) own += c.textContent + " "
        texts.push(own.replace(/\s+/g, " ").trim())
        els.push(el)
      }
      let hits // indeks elemen yang cocok
      if (pattern) {
        // P2-5 R5: regex MILIK PEMANGGIL dijalankan sinkron → pola ReDoS
        // ("(a+)+b" atas "a"×30 = 83543ms terukur) membekukan SELURUH proses
        // (stop & semua tool ikut mati). Kini dijalankan di dalam vm DENGAN
        // TIMEOUT: backtracking eksplosif diputus V8 (terbukti: n=30 berhenti
        // tepat di 1004ms dengan timeout 1000ms) → error jujur, proses hidup.
        if (String(pattern).length > FIND_PATTERN_MAX) {
          throw new McpError(ERR.INVALID_PARAMS, `pattern terlalu panjang (maks ${FIND_PATTERN_MAX} karakter)`)
        }
        try {
          new RegExp(pattern, flags) // validasi sintaks + flag SEBELUM vm
        } catch (e) {
          throw new McpError(ERR.INVALID_PARAMS, `regex tidak valid: ${e.message}`)
        }
        const vm = await import("node:vm")
        const ctx = { pattern: String(pattern), flags: String(flags), texts, limit: max, hits: null }
        vm.createContext(ctx)
        try {
          vm.runInContext(
            "const re = new RegExp(pattern, flags); const out = []; for (let i = 0; i < texts.length; i++) { const s = texts[i]; if (!s) continue; re.lastIndex = 0; if (re.test(s)) { out.push(i); if (out.length >= limit) break } } hits = out",
            ctx,
            { timeout: FIND_TIMEOUT_MS },
          )
        } catch (e) {
          if (/timed out/i.test(String(e?.message || e))) {
            throw new McpError(
              ERR.TOOL_EXECUTION_FAILED,
              `regex terlalu lambat — dihentikan setelah ${FIND_TIMEOUT_MS}ms (kemungkinan ReDoS/backtracking eksplosif): ${String(pattern).slice(0, 120)}`,
            )
          }
          throw new McpError(ERR.INVALID_PARAMS, `regex gagal dijalankan: ${e?.message || e}`)
        }
        hits = Array.isArray(ctx.hits) ? ctx.hits : []
      } else {
        const needle = String(q)
        hits = []
        for (let i = 0; i < texts.length; i++) {
          if (!texts[i]) continue
          if (texts[i].includes(needle)) {
            hits.push(i)
            if (hits.length >= max) break
          }
        }
      }
      const items = hits.map((i) => ({
        selectorPath: selectorPathOf(els[i]),
        tag: (els[i].tagName || "").toLowerCase(),
        text: texts[i].slice(0, 120),
      }))
      return text(toJson({ count: items.length, limit: max, scanned: all.length, items, note: "pencocokan teks langsung dalam elemen (direct text node) — teks gabungan anak tidak dihitung dobel" }))
    }),

    // ---- interaksi ----
    def("hover", "Hover sintetis: mouseout ke hover sebelumnya (bila masih tersambung), lalu mouseover+mousemove ke target. Tanpa layout — tak ada style :hover.", {
      selector: { type: "string", description: "CSS selector elemen" },
    }, ({ selector }) => {
      requirePage(page)
      const sel = parseSelector(selector)
      const el = page.document.querySelector(sel)
      if (!el) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
      const events = []
      const prev = lastHoverEl
      if (prev && prev !== el) {
        let connected = false
        try { connected = prev.isConnected !== false } catch { connected = false }
        if (connected && dispatchOn(page, prev, "mouseout")) events.push({ target: selectorPathOf(prev), type: "mouseout" })
      }
      if (dispatchOn(page, el, "mouseover")) events.push({ target: sel, type: "mouseover" })
      if (dispatchOn(page, el, "mousemove")) events.push({ target: sel, type: "mousemove" })
      lastHoverEl = el
      page.consoleLogs.push({ level: "info", message: `hover ${sel}` })
      return text(toJson({ hovered: sel, events, note: "event sintetis — engine tanpa layout/hit-testing; style :hover tidak diterapkan" }))
    }, ["selector"]),

    def("drag", "Drag sintetis: dragstart (sumber) → dragenter/dragover/drop (tujuan) → dragend, dengan DataTransfer polyfill. Target yang tak ada → error jelas.", {
      from: { type: "string", description: "CSS selector elemen sumber" },
      to: { type: "string", description: "CSS selector elemen tujuan" },
      data: { type: "object", description: "Data ikut serta: key → string (opsional)" },
    }, ({ from, to, data }) => {
      requirePage(page)
      const fromSel = parseSelector(from)
      const toSel = parseSelector(to)
      const src = page.document.querySelector(fromSel)
      if (!src) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${fromSel}`)
      const dst = page.document.querySelector(toSel)
      if (!dst) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${toSel}`)
      const dt = makeDataTransfer([], data && typeof data === "object" ? data : {})
      const events = []
      const step = (el, type) => { if (dispatchOn(page, el, type, {}, { dataTransfer: dt })) events.push(type) }
      step(src, "dragstart")
      step(dst, "dragenter")
      step(dst, "dragover")
      step(dst, "drop")
      step(src, "dragend")
      page.consoleLogs.push({ level: "info", message: `drag ${fromSel} → ${toSel}` })
      const dragNote = jsMode
        ? "JS engine aktif — listener halaman dieksekusi; event sintetis + DataTransfer polyfill — tanpa layout/hit-testing"
        : "engine dom — listener halaman SPA tidak dieksekusi; event sintetis + DataTransfer polyfill — tanpa layout/hit-testing"
      return text(toJson({ dragged: fromSel, to: toSel, events, dataKeys: Object.keys(dt.data), engine: jsMode ? "js" : "dom", note: dragNote }))
    }, ["from", "to"]),

    def("fill_form", "Isi banyak field sekaligus dari [{selector,value}] — input/textarea (event input+change) & select (cari option). Field hilang → error, sama seperti fill.", {
      fields: { type: "array", description: "Daftar {selector, value}", items: { type: "object" } },
    }, ({ fields }) => {
      requirePage(page)
      if (!Array.isArray(fields) || !fields.length) throw new McpError(ERR.INVALID_PARAMS, "fields wajib array [{selector,value}] non-kosong")
      const results = []
      for (const f of fields) {
        if (!f || typeof f !== "object" || !f.selector || f.value === undefined || f.value === null) {
          throw new McpError(ERR.INVALID_PARAMS, "setiap field butuh {selector, value}")
        }
        results.push(fillElement(page, f.selector, f.value))
      }
      return text(toJson({ filled: results.length, fields: results }))
    }, ["fields"]),

    def("select", "Pilih option <select> berdasar value/teks option + dispatch change.", {
      selector: { type: "string", description: "CSS selector <select>" },
      value: { type: "string", description: "Value option (atau teks option)" },
    }, ({ selector, value }) => {
      requirePage(page)
      const sel = parseSelector(selector)
      const el = page.document.querySelector(sel)
      if (!el) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
      if ((el.tagName || "").toLowerCase() !== "select") throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Bukan <select>: ${sel}`)
      const v = setSelectValue(page, el, value)
      return text(toJson({ selected: sel, value: v }))
    }, ["selector", "value"]),

    def("check", "Toggle/atur checkbox atau radio: set checked + dispatch click & change.", {
      selector: { type: "string", description: "CSS selector checkbox/radio" },
      checked: { type: "boolean", description: "Nilai tujuan (default: toggle)" },
    }, ({ selector, checked }) => {
      requirePage(page)
      const sel = parseSelector(selector)
      const el = page.document.querySelector(sel)
      if (!el) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
      const type = (el.getAttribute?.("type") || el.type || "").toLowerCase()
      if ((el.tagName || "").toLowerCase() !== "input" || (type !== "checkbox" && type !== "radio")) {
        throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Bukan checkbox/radio: ${sel}`)
      }
      const next = typeof checked === "boolean" ? checked : !el.checked
      el.checked = next
      fireEvent(page, el, "click")
      fireEvent(page, el, "change")
      return text(toJson({ toggled: sel, type, checked: next }))
    }, ["selector"]),

    def("press", "Kirim keydown→keypress→keyup sintetis ke elemen (atau activeElement). Modifier: ctrl|shift|alt|meta. Tanpa aksi bawaan browser.", {
      selector: { type: "string", description: "Target (default: activeElement/body)" },
      key: { type: "string", description: "Nama key (mis. Enter, a, Escape)" },
      modifiers: { type: "array", description: "Daftar modifier: ctrl|shift|alt|meta", items: { type: "string" } },
    }, ({ selector, key, modifiers }) => {
      requirePage(page)
      if (!key || typeof key !== "string") throw new McpError(ERR.INVALID_PARAMS, "key wajib string")
      let target
      let targetName = "activeElement/body"
      if (selector) {
        const sel = parseSelector(selector)
        target = page.document.querySelector(sel)
        if (!target) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
        targetName = sel
      } else {
        target = page.document.activeElement || page.document.body
      }
      if (!target) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "tidak ada elemen target")
      const mods = (Array.isArray(modifiers) ? modifiers : []).map((m) => String(m).toLowerCase())
      const init = {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        ctrlKey: mods.includes("ctrl") || mods.includes("control"),
        shiftKey: mods.includes("shift"),
        altKey: mods.includes("alt"),
        metaKey: mods.includes("meta") || mods.includes("cmd"),
      }
      const events = []
      for (const type of ["keydown", "keypress", "keyup"]) if (dispatchOn(page, target, type, init)) events.push(type)
      return text(toJson({ pressed: key, target: targetName, modifiers: mods, events, note: "event sintetis — tanpa layout/IME; aksi bawaan browser (submit/scroll) tidak dijalankan" }))
    }, ["key"]),

    def("scroll", "Scroll elemen (scrollIntoView bila API-nya ada) atau document + dispatch event scroll. CATATAN: engine js/dom TANPA layout — posisi viewport tidak nyata.", {
      selector: { type: "string", description: "Elemen target (default: document)" },
      y: { type: "number", description: "scrollTop tujuan (bila didukung engine)" },
      x: { type: "number", description: "scrollLeft tujuan (bila didukung engine)" },
      deltaY: { type: "number", description: "Geser RELATIF ke bawah: y baru = y sekarang + deltaY" },
    }, ({ selector, x, y, deltaY } = {}) => {
      requirePage(page)
      let target
      let targetName = "document"
      if (selector) {
        const sel = parseSelector(selector)
        target = page.document.querySelector(sel)
        if (!target) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
        targetName = sel
      } else {
        target = page.document.scrollingElement || page.document.documentElement || page.document.body
      }
      if (!target) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "tidak ada elemen untuk scroll")
      const hasApi = typeof target.scrollIntoView === "function"
      let invoked = false
      if (hasApi) { try { target.scrollIntoView(); invoked = true } catch { /* best-effort */ } }
      if (typeof y === "number" && "scrollTop" in target) { try { target.scrollTop = y } catch { /* readonly tanpa layout */ } }
      // deltaY (argumen builtin web_scroll) → konversi ke y RELATIF posisi sekarang.
      if (typeof deltaY === "number" && "scrollTop" in target) {
        try { target.scrollTop = (Number(target.scrollTop) || 0) + deltaY } catch { /* readonly tanpa layout */ }
      }
      if (typeof x === "number" && "scrollLeft" in target) { try { target.scrollLeft = x } catch { /* readonly tanpa layout */ } }
      const eventDispatched = dispatchOn(page, target, "scroll", { bubbles: false })
      return text(toJson({
        scrolled: targetName,
        scrollIntoViewAvailable: hasApi,
        scrollIntoViewCalled: invoked,
        scrollTop: "scrollTop" in target ? target.scrollTop : null,
        eventDispatched,
        note: "engine js/dom TANPA layout — scrollIntoView hanya bila tersedia; posisi viewport tidak nyata, event scroll tetap dikirim",
      }))
    }),

    def("dialog", "Dialog halaman (alert/confirm/prompt): list antrean / next yang belum di-dismiss / dismiss. js_eval atau script yang memanggil alert TIDAK crash — masuk antrean ini.", {
      action: { type: "string", enum: ["list", "next", "dismiss"], description: "default list" },
      index: { type: "number", description: "Indeks dialog utk dismiss (default: belum-dismiss pertama)" },
    }, ({ action = "list", index } = {}) => {
      ensureTabState(page)
      const queue = page.dialogQueue
      const noNative = "respons tidak dikirim ke halaman (engine tanpa native dialog)"
      if (action === "list") return text(toJson({ count: queue.length, dialogs: queue }))
      if (action === "next") return text(toJson({ next: queue.find((d) => !d.dismissed) || null, note: noNative }))
      if (action === "dismiss") {
        const i = Number.isInteger(index) ? index : queue.findIndex((d) => !d.dismissed)
        if (i < 0 || i >= queue.length) return text(toJson({ dismissed: null, note: "tidak ada dialog untuk dismiss" }))
        queue[i].dismissed = true
        return text(toJson({ dismissed: queue[i], note: noNative }))
      }
      throw new McpError(ERR.INVALID_PARAMS, "action harus list|next|dismiss")
    }),

    // ---- files ----
    def("files_list", "Semua <input type=file> di DOM + info (selectorPath, accept, multiple, jumlah file ter-attach). Tanpa input file → count 0.", {}, () => {
      requirePage(page)
      const els = [...page.document.querySelectorAll('input[type="file"]')]
      const items = els.map((el, i) => ({
        index: i,
        selectorPath: selectorPathOf(el),
        id: el.id || undefined,
        name: el.getAttribute("name") || undefined,
        accept: el.getAttribute("accept") || undefined,
        multiple: el.hasAttribute?.("multiple") || false,
        attached: (el.files && el.files.length) || 0,
      }))
      return text(toJson({ count: items.length, items }))
    }),

    def("files_upload", "Attach file ke input[type=file] (FileList sintetis via defineProperty) + event input/change. File dibuat dari content teks/base64 — bukan picker OS.", {
      selector: { type: "string", description: "CSS selector input[type=file]" },
      name: { type: "string", description: "Nama file (default upload.txt)" },
      content: { type: "string", description: "Isi file sebagai teks" },
      base64: { type: "string", description: "Isi file base64 (alternatif content)" },
      type: { type: "string", description: "MIME type (default text/plain)" },
    }, ({ selector, name = "upload.txt", content, base64, type }) => {
      requirePage(page)
      if (content === undefined && base64 === undefined) throw new McpError(ERR.INVALID_PARAMS, "butuh content atau base64")
      const { sel, el } = requireFileInput(page, selector)
      const file = makeFile({ name, content, base64, type })
      attachFileList(el, [file])
      fireEvent(page, el, "input")
      fireEvent(page, el, "change")
      const size = typeof file.size === "number" ? file.size : file.__buf?.length
      return text(toJson({ uploaded: sel, files: [{ name: file.name || name, size, type: file.type || type || "text/plain" }], note: "FileList sintetis (defineProperty) — API File, bukan pembacaan file asli dari OS" }))
    }, ["selector"]),

    def("files_drop", "Dispatch dragenter/dragover/drop dengan polyfill DataTransfer+File — menguji handler drop halaman tanpa OS.", {
      selector: { type: "string", description: "Elemen tujuan drop" },
      files: { type: "array", description: "Daftar {name, content|base64, type}", items: { type: "object" } },
      x: { type: "number", description: "clientX (default 0)" },
      y: { type: "number", description: "clientY (default 0)" },
    }, ({ selector, files, x = 0, y = 0 }) => {
      requirePage(page)
      if (!Array.isArray(files) || !files.length) throw new McpError(ERR.INVALID_PARAMS, "files wajib array [{name, content|base64}] non-kosong")
      const sel = parseSelector(selector)
      const el = page.document.querySelector(sel)
      if (!el) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
      const made = files.map((f) => {
        if (!f || typeof f !== "object" || (f.content === undefined && f.base64 === undefined)) {
          throw new McpError(ERR.INVALID_PARAMS, "setiap file butuh {name, content|base64}")
        }
        return makeFile({ name: f.name || "drop.txt", content: f.content, base64: f.base64, type: f.type })
      })
      const dt = makeDataTransfer(made, {})
      const events = []
      for (const type of ["dragenter", "dragover", "drop"]) {
        if (dispatchOn(page, el, type, { clientX: x, clientY: y }, { dataTransfer: dt })) events.push(type)
      }
      const dropNote = jsMode
        ? "JS engine aktif — listener halaman dieksekusi; DataTransfer/File polyfill lokal — handler halaman menerima e.dataTransfer.files sintetis"
        : "engine dom — listener halaman SPA tidak dieksekusi; DataTransfer/File polyfill lokal — handler halaman menerima e.dataTransfer.files sintetis"
      return text(toJson({
        dropped: sel,
        events,
        files: made.map((f) => ({ name: f.name, size: typeof f.size === "number" ? f.size : f.__buf?.length, type: f.type })),
        engine: jsMode ? "js" : "dom",
        note: dropNote,
      }))
    }, ["selector", "files"]),

    def("files_get", "Baca isi file: dari input ter-attach berdasar index, ATAU decode data URL (data:text/... ;base64). Dibaca sebagai text/utf8.", {
      selector: { type: "string", description: "Input[type=file] tempat file ter-attach" },
      index: { type: "number", description: "Indeks file (default 0)" },
      data: { type: "string", description: "Data URL (data:...) — baca langsung tanpa selector" },
    }, async ({ selector, index = 0, data }) => {
      if (data) {
        const m = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(String(data))
        if (!m) throw new McpError(ERR.INVALID_PARAMS, "bukan data URL valid (format data:[<mime>][;base64],<payload>)")
        const body = m[2] ? Buffer.from(decodeBase64Strict(m[3]), "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8")
        return text(toJson({ source: "data-url", mimeType: m[1] || "text/plain", size: body.length, content: body.toString("utf8") }))
      }
      requirePage(page)
      if (!selector) throw new McpError(ERR.INVALID_PARAMS, "butuh selector input[type=file] atau data")
      const { sel, el } = requireFileInput(page, selector)
      const list = el.__mcpFiles || el.files
      const total = list ? list.length : 0
      if (!total) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Tidak ada file ter-attach: ${sel}`)
      if (!Number.isInteger(index) || index < 0 || index >= total) {
        throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Index file di luar jangkauan: ${index} (total ${total})`)
      }
      const f = (list.item && list.item(index)) || list[index]
      let content
      if (f && f.__buf) content = f.__buf.toString("utf8")
      else if (f && typeof f.text === "function") content = await f.text()
      else content = f ? String(f.content ?? "") : ""
      return text(toJson({ selector: sel, index, name: f?.name, size: typeof f?.size === "number" ? f.size : content.length, type: f?.type, content, note: "dibaca sebagai text/utf8 — konten biner akan terbaca rusak (jujur)" }))
    }),

    // ---- network / trace / cpu / heap ----
    def("network_get", "Detail SATU entri network log berdasar index ATAU id (url).", {
      index: { type: "number", description: "Indeks entri (dari network_list)" },
      id: { type: "string", description: "Url entri (alternatif index)" },
    }, ({ index, id }) => {
      const logs = page.networkLogs
      if (index === undefined && id === undefined) throw new McpError(ERR.INVALID_PARAMS, "butuh index atau id")
      let i
      let entry
      if (index !== undefined) {
        if (!Number.isInteger(index) || index < 0 || index >= logs.length) {
          throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Index network log di luar jangkauan: ${index} (total ${logs.length})`)
        }
        i = index
        entry = logs[index]
      } else {
        i = logs.findIndex((l) => l.url === id)
        if (i < 0) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Network log tidak ditemukan untuk id: ${id}`)
        entry = logs[i]
      }
      return text(toJson({ index: i, entry, total: logs.length }))
    }),

    def("trace_start", "Mulai trace timing: catat mark performance.now — marks buatan tool, BUKAN DevTools trace.", {
      label: { type: "string", description: "Label opsional" },
    }, ({ label } = {}) => {
      if (traceState) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `trace sudah berjalan — jalankan trace_stop dulu (label: ${traceState.label ?? "-"})`)
      const t = perfNow()
      traceState = { label: label ?? null, t0: t, startedAt: Date.now(), marks: [{ name: "trace-start", t }] }
      return text(toJson({ started: true, label: label ?? null, kind: "approx-timing", note: "performance.now marks buatan tool — bukan DevTools trace" }))
    }),

    def("trace_stop", "Hentikan trace berjalan → durasi + marks. Tanpa trace aktif → error jelas.", {}, () => {
      if (!traceState) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "trace belum berjalan — jalankan trace_start dulu")
      const t = perfNow()
      traceState.marks.push({ name: "trace-stop", t })
      const t0 = traceState.t0
      lastTrace = {
        label: traceState.label,
        startedAt: traceState.startedAt,
        durationMs: Math.round((t - t0) * 100) / 100,
        markCount: traceState.marks.length,
        marks: traceState.marks.map((m) => ({ name: m.name, t: Math.round(m.t * 100) / 100, offsetMs: Math.round((m.t - t0) * 100) / 100 })),
      }
      traceState = null
      return text(toJson({ stopped: true, kind: "approx-timing", ...lastTrace, note: "performance.now marks buatan tool — bukan DevTools trace" }))
    }),

    def("trace_analyze", "Agregasi trace TERAKHIR (setelah trace_stop): total durasi + delta antar marks.", {}, () => {
      if (!lastTrace) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "belum ada trace untuk analyze — jalankan trace_start lalu trace_stop")
      const marks = lastTrace.marks.map((m, i, arr) => ({ ...m, deltaMs: i === 0 ? 0 : Math.round((m.t - arr[i - 1].t) * 100) / 100 }))
      const gaps = marks.slice(1).map((m, i) => ({ from: marks[i].name, to: m.name, deltaMs: m.deltaMs }))
      return text(toJson({ kind: "approx-timing", label: lastTrace.label, totalMs: lastTrace.durationMs, markCount: lastTrace.markCount, marks, gaps, note: "agregasi durasi antar-marks buatan tool — bukan DevTools/CPU profile" }))
    }),

    def("cpu_start", "Mulai pengukuran timing kasar (Date.now) — hasil berlabel approx-timing: timing marks, bukan CPU profiler.", {
      label: { type: "string", description: "Label opsional" },
    }, ({ label } = {}) => {
      if (cpuState) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `cpu sudah berjalan — jalankan cpu_stop dulu (label: ${cpuState.label ?? "-"})`)
      const t = Date.now()
      cpuState = { label: label ?? null, t0: t, marks: [{ name: "cpu-start", t }] }
      return text(toJson({ started: true, label: label ?? null, kind: "approx-timing", note: "engine js/dom: timing marks, bukan CPU profiler" }))
    }),

    def("cpu_stop", "Hentikan pengukuran timing → durasi + marks (label approx-timing).", {}, () => {
      if (!cpuState) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "cpu belum berjalan — jalankan cpu_start dulu")
      const t = Date.now()
      cpuState.marks.push({ name: "cpu-stop", t })
      const t0 = cpuState.t0
      lastCpu = {
        label: cpuState.label,
        durationMs: t - t0,
        markCount: cpuState.marks.length,
        marks: cpuState.marks.map((m) => ({ name: m.name, t: m.t, offsetMs: m.t - t0 })),
      }
      cpuState = null
      return text(toJson({ stopped: true, kind: "approx-timing", note: "engine js/dom: timing marks, bukan CPU profiler", ...lastCpu }))
    }),

    def("cpu_analyze", "Agregasi pengukuran timing terakhir (setelah cpu_stop) — tetap berlabel approx-timing.", {}, () => {
      if (!lastCpu) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "belum ada cpu untuk analyze — jalankan cpu_start lalu cpu_stop")
      const gaps = lastCpu.marks.slice(1).map((m, i) => ({ from: lastCpu.marks[i].name, to: m.name, deltaMs: m.t - lastCpu.marks[i].t }))
      return text(toJson({
        kind: "approx-timing",
        note: "engine js/dom: timing marks, bukan CPU profiler",
        label: lastCpu.label,
        totalMs: lastCpu.durationMs,
        markCount: lastCpu.markCount,
        marks: lastCpu.marks,
        gaps,
      }))
    }),

    def("heap_summary", "Statistik heap PROSES engine Node (v8.getHeapStatistics + process.memoryUsage) — BUKAN heap halaman/tab, diberi catatan jujur.", {}, async () => {
      const { getHeapStatistics } = await import("node:v8")
      const hs = getHeapStatistics()
      let mem = null
      try { mem = process.memoryUsage() } catch { /* runtime non-Node */ }
      return text(toJson({
        kind: "process-heap",
        note: "heap PROSES engine Node (v8.getHeapStatistics + process.memoryUsage) — bukan heap halaman/tab",
        heap: {
          used_heap_size: hs.used_heap_size,
          total_heap_size: hs.total_heap_size,
          total_available_size: hs.total_available_size,
          heap_size_limit: hs.heap_size_limit,
          malloced_memory: hs.malloced_memory,
          peak_malloced_memory: hs.peak_malloced_memory,
          total_physical_size: hs.total_physical_size,
          number_of_native_contexts: hs.number_of_native_contexts,
          number_of_detached_contexts: hs.number_of_detached_contexts,
        },
        memoryUsage: mem ? { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external } : null,
      }))
    }),

    // 5 tool engine-tak-mungkin: error terstruktur, TANPA hasil palsu —
    // persis seperti builtin yang error "No desktop browser is connected".
    desktopOnly("heap_snapshot", "Snapshot heap halaman (DevTools/.heapsnapshot) — TIDAK didukung engine js/dom: butuh desktop browser/Chromium (error terstruktur, bukan hasil palsu)."),
    desktopOnly("heap_query", "Query objek di heap snapshot (DevTools) — TIDAK didukung engine js/dom: butuh desktop browser/Chromium."),
    desktopOnly("heap_object", "Detail objek dari heap snapshot — TIDAK didukung engine js/dom: butuh desktop browser/Chromium."),
    desktopOnly("heap_compare", "Bandingkan dua heap snapshot — TIDAK didukung engine js/dom: butuh desktop browser/Chromium."),
    desktopOnly("lighthouse", "Audit Lighthouse halaman — TIDAK didukung engine js/dom: butuh desktop browser/Chromium (butuh Chrome headless)."),
  )

  // ---- 3 alias: nama surface builtin → handler lama (reference persis) ----
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  tools.push(
    { ...byName.js_eval, name: "evaluate", description: "Alias surface builtin `evaluate` → handler js_eval. Jalankan ekspresi JS di konteks halaman (debug, klien tepercaya saja)." },
    { ...byName.console_get, name: "console", description: "Alias surface builtin `console` → handler console_get. Ambil log console yang terekam selama sesi (debug)." },
    { ...byName.network_logs, name: "network_list", description: "Alias surface builtin `network.list` → handler network_logs. Riwayat request/response sesi (debug): URL, status, tipe, timing." },
  )

  // Validasi inputSchema di SATU tempat — menutup stdio + http + plugin
  // (ketiganya memakai handler dari createTools). Wrapper DI-MEMO per handler
  // ASLI supaya 3 alias tetap berbagi referensi handler yang sama persis
  // (contract test surface.test.js:61-66).
  const wrapped = new Map()
  for (const t of tools) {
    if (wrapped.has(t.handler)) { t.handler = wrapped.get(t.handler); continue }
    const inner = t.handler
    const schema = t.inputSchema
    // calledAs = nama tool yang DIPANGGIL klien — protocol.callTool & plugin
    // wrapExecute meneruskannya sebagai argumen ke-2. Tanpa ini, 3 alias
    // (evaluate/console/network_list) memakai wrapper memo yang menangkap nama
    // tool PERTAMa (js_eval dst) → pesan error argumen asing menyebut nama
    // yang tidak dipanggil. Identity `evaluate === js_eval` TETAP (satu
    // referensi wrapper sama) — contract tests/surface.test.js:61 aman.
    const w = async (args, calledAs) => {
      // async → validasi yang gagal jadi REJECTED promise (aman utk .catch() pemanggil)
      assertToolArgs(calledAs || t.name, args, schema)
      return inner(args)
    }
    wrapped.set(inner, w)
    t.handler = w
  }

  return tools
}