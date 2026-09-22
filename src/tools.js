// WebDrive MCP — registrasi tool MCP.
// Semua tool web: navigate, get_content, query, click, fill, submit, wait,
// js_eval, console_get, network_logs, cookies, history, reset, screenshot.
import { createPage } from "./browser.js"
import { createJsPage } from "./engine-js.js"
import { McpError, ERR } from "./protocol.js"

function text(result) {
  return { content: [{ type: "text", text: result }], isError: false }
}

function toJson(obj) {
  return JSON.stringify(obj, null, 2)
}

function requirePage(page) {
  if (!page.document) throw new McpError(ERR.TOOL_EXECUTION_FAILED, "Belum ada halaman. Jalankan 'navigate' dulu.")
}

function parseSelector(sel) {
  if (!sel || typeof sel !== "string") throw new McpError(ERR.INVALID_PARAMS, "selector wajib string")
  return sel
}

// Kirim event DOM dengan aman. Event hanya dikirim kalau window.Event tersedia;
// listener JS di halaman akan terpanggil (mis. onClick). Error event dibungkam.
function fireEvent(page, el, type) {
  try {
    const E = page.window?.Event
    if (E) el.dispatchEvent(new E(type))
  } catch {}
}

export function createTools({ engine = "dom" } = {}) {
  const page = engine === "js" ? createJsPage() : createPage()
  const jsMode = page.isJs === true

  return [
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
        try { new URL(url) } catch { throw new McpError(ERR.INVALID_PARAMS, `URL tidak valid: ${url}`) }
        if (!/^https?:\/\//i.test(url)) throw new McpError(ERR.INVALID_PARAMS, "Hanya http/https yang didukung")
        const s = await page.navigate(url, { headers, timeoutMs })
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
        const els = [...page.document.querySelectorAll(sel)].slice(0, limit)
        const out = els.map((el, i) => ({
          index: i,
          tag: el.tagName?.toLowerCase(),
          id: el.id || undefined,
          cls: el.className && typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 3) : undefined,
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
          href: el.getAttribute?.("href") || undefined,
          src: el.getAttribute?.("src") || undefined,
        }))
        return text(toJson({ count: els.length, total: page.document.querySelectorAll(sel).length, items: out }))
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
        const sel = parseSelector(selector)
        const el = page.document.querySelector(sel)
        if (!el) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Elemen tidak ditemukan: ${sel}`)
        const tag = el.tagName?.toLowerCase()
        if (tag === "select") {
          const opt = [...(el.options || [])].find((o) => o.value === value || (o.textContent || "").trim() === value)
          if (!opt) throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Option tidak ditemukan: ${value}`)
          el.value = opt.value
          fireEvent(page, el, "change")
          return text(toJson({ filled: sel, select: opt.value }))
        }
        el.value = String(value)
        el.setAttribute?.("value", String(value))
        fireEvent(page, el, "input")
        fireEvent(page, el, "change")
        return text(toJson({ filled: sel, type: tag, value: String(value) }))
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
      description: "Jalankan ekspresi JavaScript di konteks halaman (debug). Kode dievaluasi dengan vm murni — DOM tersedia via page.document.",
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
        // Mode JS: eksekusi di konteks halaman penuh (window.eval — JS hidup).
        if (jsMode) {
          const result = page.window.eval(code)
          return text(toJson({ engine: "js", result: typeof result === "string" ? result : result }))
        }
        // Mode DOM: solusi ringan dengan vm; ekspos document/window minimal.
        const vm = await import("vm")
        const sandbox = {
          document: page.document,
          window: { location: { href: page.currentUrl }, title: page.title },
          URL, console, JSON, Math, Date, encodeURIComponent,
        }
        vm.createContext(sandbox)
        const result = vm.runInContext(code, sandbox, { timeout: 2000 })
        return text(toJson({ result: typeof result === "string" ? result : result }))
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
      description: "Lihat/bersihkan cookie sesi.",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["list", "clear"], description: "default list" } },
      },
      async handler({ action = "list" }) {
        if (action === "clear") {
          page.clearCookies()
          return text(toJson({ cleared: true }))
        }
        return text(toJson({ cookies: page.getCookiesForCurrent() }))
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
      description: "Snapshot struktural halaman (tanpa Chromium → bukan gambar piksel). Return teks/HTML yang bisa dibaca AI.",
      inputSchema: {
        type: "object",
        properties: { format: { type: "string", enum: ["text", "html"], description: "default text" } },
      },
      async handler({ format = "text" }) {
        requirePage(page)
        return text(format === "html" ? page.html() : page.textContent())
      },
    },

    {
      name: "reset",
      description: "Reset seluruh sesi (bersihkan halaman, history, cookies, log).",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        page.reset()
        return text(toJson({ reset: true }))
      },
    },
  ]
}