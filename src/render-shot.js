// render-shot.js — screenshot wireframe halaman → PNG, murni Node.
// TANPA Chromium, TANPA Playwright: DOM (linkedom/jsdom) + layout
// approximation + pureimage (raster pure-JS).
//
// Fitur v2 (combo maksimal MCP web.* + plugin browser.*):
//   • box + bg/border + teks wrap (word-wrap by measureText / estimator)
//   • <img> ASLI: fetch (tracked) + decode PNG/JPEG + drawImage contain-fit
//   • overflow clip (hidden/scroll/auto → ctx.clip ke content rect)
//   • border-radius (roundRect path fill/stroke)
//   • background gradient (linear-gradient → createLinearGradient horizontal)
//   • deviceScale 1–3 (bitmap Nx + ctx.scale → teks tajam)
//   • box tree JSON (tag#id.class @ x,y,w,h + teks) utk meta AI / format tree
//   • outline merah utk selector target (debug view)
//
// Layout = PERKIRAAN (block/inline/flex sederhana) — jsdom/linkedom tidak
// punya layout engine → wireframe akurat warna+struktur+gambar, bukan
// pixel-perfect. CSS cascade penuh hanya di engine js (getComputedStyle +
// stylesheet ter-inject via ensureStyles); engine dom = inline + default tag.
import fs from "node:fs"
import { PassThrough, Readable } from "node:stream"
import { PRISTINE_FETCH } from "./pristine.js"
import { ASSET_TIMEOUT_MS } from "./assets.js"
import { McpError, ERR } from "./protocol.js"

// P3-8 R5: cap luas-piksel GABUNGAN (lebar × tinggi × deviceScale²).
// Kombinasi yang tercatat SAH sebelumnya — width 4096 + fullPage H 8192 +
// scale 3 → 12288×24576 = 301.989.888 px = bitmap RGBA 1.152MB (RSS terukur
// 1296MB) dan encode PNG 4096² saja sudah 18,4s → risiko OOM membunuh proses
// MCP (semua tool ikut mati). 16.777.216 px = 4096×4096 → bitmap maks 64MB.
export const MAX_SHOT_PIXELS = 16_777_216

const FONT_CANDIDATES = [
  "/system/fonts/DroidSans.ttf",
  "/system/fonts/Roboto-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
]
const FAMILY = "wire"
let fontPromise = null

async function ensureFont(PImage) {
  if (fontPromise) return fontPromise
  fontPromise = (async () => {
    const file = FONT_CANDIDATES.find((p) => {
      try { return fs.existsSync(p) } catch { return false }
    })
    if (!file) return false
    try {
      const face = PImage.registerFont(file, FAMILY)
      // pureimage memilih loader: typeof window === "undefined" ? fs : XHR.
      // engine-js navigate meninggalkan window jsdom di global → XHR →
      // "XMLHttpRequest is not defined". Sembunyikan window selama load.
      const g = globalThis
      const had = "window" in g
      const saved = g.window
      if (had) g.window = undefined
      try {
        await face.load()
      } finally {
        if (had) g.window = saved
      }
      // BUG pureimage 0.4.20: opentype bundled crash di getKerningValue
      // ("h[d] is not a function") utk SEMUA font → fillText senyap 0 piksel.
      // Fix: getPath tanpa kerning (wireframe tak butuh kern pair).
      const f = face.font
      if (f && typeof f.getPath === "function" && !f.__noKern) {
        const orig = f.getPath.bind(f)
        f.getPath = (text, x, y, size, opt) => orig(text, x, y, size, { kerning: false, ...(opt || {}) })
        f.__noKern = true
      }
      return true
    } catch (e) {
      console.warn("mcp-web render-shot: font gagal dimuat:", e && e.message)
      return false
    }
  })()
  return fontPromise
}

// --- style helper -----------------------------------------------------------

const INLINE_TAGS = new Set([
  "SPAN", "A", "B", "I", "STRONG", "EM", "SMALL", "CODE", "LABEL", "ABBR",
  "CITE", "Q", "S", "U", "VAR", "KBD", "SAMP", "TIME", "MARK", "DEL", "INS",
  "SUB", "SUP", "BIG", "FONT",
])
const UA_DEFAULTS = {
  body: { display: "block", margin: "8px" },
  html: { display: "block" },
  head: { display: "none" },
  script: { display: "none" },
  style: { display: "none" },
  link: { display: "none" },
  meta: { display: "none" },
  title: { display: "none" },
  template: { display: "none" },
  noscript: { display: "none" },
}

function domStyle(el) {
  const tag = (el.tagName || "").toLowerCase()
  const inline = {}
  const raw = (typeof el.getAttribute === "function" && el.getAttribute("style")) || ""
  for (const decl of String(raw).split(";")) {
    const i = decl.indexOf(":")
    if (i > 0) inline[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim()
  }
  const get = (p) => {
    if (inline[p] != null && inline[p] !== "") return inline[p]
    const u = UA_DEFAULTS[tag]
    if (u && u[p] != null) return u[p]
    if (p === "display") return INLINE_TAGS.has(el.tagName || "") ? "inline-block" : "block"
    return ""
  }
  return { getPropertyValue: (p) => get(String(p).toLowerCase()) }
}

function makeStyleFn(page) {
  const win = page.window
  if (win && typeof win.getComputedStyle === "function") {
    const fn = (el) => {
      try { return win.getComputedStyle(el) } catch { return domStyle(el) }
    }
    fn.mode = "cascade"
    return fn
  }
  const fn = (el) => domStyle(el)
  fn.mode = "inline"
  return fn
}

function sv(style, prop) {
  if (!style) return ""
  try {
    if (typeof style.getPropertyValue === "function") return style.getPropertyValue(prop) || ""
  } catch { /* style rusak → "" */ }
  const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  const v = style[camel]
  return v == null ? "" : String(v)
}

// px | em | rem | % | pt → px. base = parent content width (utk %).
function px(v, base = 0, parent = 16) {
  if (v == null) return 0
  const s = String(v).trim()
  if (!s || s === "auto" || s === "none" || s === "normal") return 0
  const m = s.match(/^(-?\d*\.?\d+)(px|em|rem|%|pt)?$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  const u = m[2] || "px"
  if (u === "em") return n * (parent || 16)
  if (u === "rem") return n * 16
  if (u === "%") return (n * base) / 100
  if (u === "pt") return (n * 96) / 72
  return n
}

// Normalisasi warna → "rgb(r, g, b)" | "rgb(1,2,3)" hex/named/rgba | null.
function normColor(v) {
  if (!v) return null
  const s = String(v).trim()
  if (!s || s === "transparent" || s === "none" || s === "rgba(0, 0, 0, 0)") return null
  if (/gradient/i.test(s)) {
    const m = s.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/)
    return m ? normColor(m[0]) : null
  }
  let m = s.match(/^#([0-9a-fA-F]{3})$/)
  if (m) {
    const h = m[1]
    return `rgb(${parseInt(h[0] + h[0], 16)}, ${parseInt(h[1] + h[1], 16)}, ${parseInt(h[2] + h[2], 16)})`
  }
  m = s.match(/^#([0-9a-fA-F]{6})$/)
  if (m) {
    const h = m[1]
    return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`
  }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (m) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`
  if (/^[a-z]+$/i.test(s)) return s
  return null
}

// "linear-gradient(...)" → [[t, color], ...] utk createLinearGradient.
function gradStops(v) {
  const s = String(v || "")
  if (!/gradient/i.test(s)) return null
  const inner = (s.match(/gradient\((.*)\)/s) || [])[1]
  if (!inner) return null
  const parts = inner.split(/,(?![^(]*\))/) // comma di level-1 saja (rgba aman)
  const stops = []
  for (const raw of parts) {
    const p = raw.trim()
    const cm = p.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/) || (/^[a-z]+$/.test(p) ? [null, p] : [null, null])
    const col = cm ? normColor(cm[1] || cm[0]) : null
    if (!col) continue // skip "to right" / "circle"
    const pct = p.match(/(\d+(?:\.\d+)?)%\s*$/)
    stops.push([pct ? parseFloat(pct[1]) / 100 : null, col])
  }
  if (stops.length < 2) return null
  return stops.map(([t, c], i) => [t != null ? t : i / (stops.length - 1), c])
}

// --- text wrap --------------------------------------------------------------

function wrapText(ctx, text, size, maxW, hasFont) {
  const out = []
  if (!text) return out
  // pureimage parser font: "<size> <family>" (parseInt ambil angka awal)
  ctx.font = `${Math.round(size)} ${FAMILY}`
  for (const para of String(text).split("\n")) {
    const words = para.split(/(\s+)/)
    let line = ""
    for (const w of words) {
      if (!w) continue
      const cand = line + w
      const wide = hasFont
        ? ctx.measureText(cand).width > maxW
        : cand.length * size * 0.55 > maxW
      if (wide && line.trim()) {
        out.push(line.replace(/\s+$/, ""))
        line = w.replace(/^\s+/, "")
      } else {
        line = cand
      }
      if (!hasFont && line.length * size * 0.55 > maxW) { out.push(line); line = "" }
    }
    out.push(line.replace(/\s+$/, ""))
  }
  return out
}

// --- images (fetch + decode) ------------------------------------------------

async function loadImages(root, page) {
  const map = new Map()
  map.failed = [] // alasan <img> gagal dimuat (P1 R4) → `notes` screenshot jujur
  if (!root || typeof root.querySelectorAll !== "function") return map
  const imgs = [...root.querySelectorAll("img[src]")]
  if (!imgs.length) return map
  const currentUrl = page.currentUrl || page.window?.location?.href || ""
  // P1 R4: fetch gambar ber-TIMEOUT (10s, sama dgn stylesheet) — gambar yang
  // tak pernah merespons dulu menggantungkan screenshot ±301 detik.
  // P2-4 R5: signal `stop` selama screenshot (page._shotCtl) ikut digabung →
  // stop MEMBATALKAN fetch gambar, bukan cuma navigasi.
  const assetSignal = () => {
    const to = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ASSET_TIMEOUT_MS) : undefined
    const stop = page && page._shotCtl ? page._shotCtl.signal : null
    if (!stop) return to
    if (!to) return stop
    try { return AbortSignal.any([to, stop]) } catch { return stop }
  }
  // fetcher: engine js → _trackedFetch halamannya; engine dom → fetch ASLI
  // proses (src/pristine.js), JANGAN `fetch` telanjang — global bisa ter-patch
  // engine js sesi lain (bleed silang-engine, P1 R6).
  const fetcher = typeof page._trackedFetch === "function"
    ? (u) => page._trackedFetch(u, { signal: assetSignal() })
    : (u) => PRISTINE_FETCH(u, { redirect: "follow", signal: assetSignal() })
  const PImage = await import("pureimage")
  let loaded = 0
  await Promise.all(imgs.map(async (el) => {
    let src = ""
    try {
      src = el.getAttribute("src") || ""
      if (!src) return
      let buf
      if (/^data:image\//i.test(src)) {
        const b64 = src.slice(src.indexOf(",") + 1)
        buf = Buffer.from(b64, "base64")
      } else {
        const abs = new URL(src, currentUrl || "http://localhost/").toString()
        if (!/^https?:/.test(abs)) return
        const res = await fetcher(abs)
        if (!res.ok) { map.failed.push(`${src} (HTTP ${res.status})`); return }
        const ab = await res.arrayBuffer()
        if (ab.byteLength > 3 * 1024 * 1024) { map.failed.push(`${src} (>3MB, dilewati)`); return } // batas aman
        buf = Buffer.from(ab)
      }
      const isPng = buf[0] === 0x89 && buf[1] === 0x50
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8
      if (!isPng && !isJpg) { map.failed.push(`${src} (bukan PNG/JPEG)`); return }
      const stream = Readable.from([buf])
      const bmp = isPng
        ? await PImage.decodePNGFromStream(stream)
        : await PImage.decodeJPEGFromStream(stream)
      map.set(el, bmp)
      loaded++
    } catch (e) {
      // Gagal (timeout 10s/HTTP/decode) → placeholder (alt) + alasan jujur,
      // BUKAN gantung dan BUKAN sukses palsu (filosofi repo: hasil + note).
      if (src) map.failed.push(`${src} (${e?.name || "Error"}: ${e?.message || e})`)
    }
  }))
  map.loaded = loaded
  return map
}

// --- layout approximation ---------------------------------------------------

function inlineText(el) {
  let out = ""
  const walk = (n) => {
    if (n.nodeType === 3 || n.nodeType === 4) { out += n.data; return }
    if (n.nodeType !== 1) return
    const tag = (n.tagName || "").toUpperCase()
    if (tag === "BR") { out += "\n"; return }
    if (tag === "IMG") { out += n.getAttribute?.("alt") || ""; return }
    for (const c of n.childNodes || []) walk(c)
  }
  walk(el)
  return out
}

function inputText(el) {
  const tag = (el.tagName || "").toUpperCase()
  if (tag === "INPUT") return el.getAttribute?.("placeholder") || el.getAttribute?.("value") || ""
  if (tag === "SELECT") {
    const opt = el.querySelector?.("option")
    return opt ? opt.textContent : ""
  }
  if (tag === "TEXTAREA") return el.textContent || el.getAttribute?.("placeholder") || ""
  return el.textContent || ""
}

function attrPx(el, name, def) {
  const a = typeof el.getAttribute === "function" ? el.getAttribute(name) : null
  const n = a != null ? parseFloat(a) : NaN
  return Number.isFinite(n) && n > 0 ? n : def
}

function metaOf(el) {
  const tag = (el.tagName || "").toLowerCase() || "?"
  const id = (typeof el.getAttribute === "function" && el.getAttribute("id")) || ""
  const cls = (typeof el.getAttribute === "function" && el.getAttribute("class")) || ""
  return {
    tag,
    id: id || undefined,
    cls: cls ? cls.trim().split(/\s+/).slice(0, 4).join(".") : undefined,
  }
}

function layoutEl(el, x, y, availW, styleFn, ctx, hasFont, images, depth) {
  if (depth > 80) return null
  if (el.nodeType !== 1) return null
  const style = styleFn(el)
  const display = (sv(style, "display") || "").trim().toLowerCase()
  if (display === "none" || display === "contents") return null

  const parentFont = 16
  const tag = (el.tagName || "").toUpperCase()
  const ml = px(sv(style, "margin-left"), availW, parentFont)
  const mr = px(sv(style, "margin-right"), availW, parentFont)
  const mt = px(sv(style, "margin-top"), 0, parentFont)
  const mb = px(sv(style, "margin-bottom"), 0, parentFont)
  const pl = px(sv(style, "padding-left"), availW, parentFont)
  const pr = px(sv(style, "padding-right"), availW, parentFont)
  const pt = px(sv(style, "padding-top"), 0, parentFont)
  const pb = px(sv(style, "padding-bottom"), 0, parentFont)
  const bt = px(sv(style, "border-top-width"), 0, parentFont)
  const br_ = px(sv(style, "border-right-width"), 0, parentFont)
  const bb = px(sv(style, "border-bottom-width"), 0, parentFont)
  const bl = px(sv(style, "border-left-width"), 0, parentFont)
  const widthDecl = sv(style, "width")
  let w = availW - ml - mr
  if (widthDecl && widthDecl !== "auto") {
    const dw = px(widthDecl, availW, parentFont)
    if (dw > 0) w = Math.min(dw, availW - ml - mr)
  }
  const x0 = x + ml
  const contentW = Math.max(8, w - pl - pr - bl - br_)
  const fontSize = Math.max(8, px(sv(style, "font-size"), 0, parentFont) || 16)
  const color = normColor(sv(style, "color")) || "rgb(0, 0, 0)"
  const bgRaw = sv(style, "background-color") || sv(style, "background")
  const grad = gradStops(bgRaw)
  const bg = grad ? null : normColor(bgRaw)
  const borderColor = normColor(sv(style, "border-top-color"))
    || normColor(sv(style, "border-color")) || "rgb(0, 0, 0)"
  const borderW = Math.max(bt, br_, bb, bl)
  // inline "overflow:hidden" (tanpa -x/-y) juga dihitung — fallback utk
  // dom mode & jsdom computed yang kosong per-axis
  const ovX = sv(style, "overflow-x") || sv(style, "overflow")
  const ovY = sv(style, "overflow-y") || sv(style, "overflow")
  const overflow = /hidden|scroll|auto|overlay/.test(`${ovX} ${ovY}`)
  const radius = px(sv(style, "border-radius"), 0, parentFont)
  const { tag: ltag, id, cls } = metaOf(el)

  const box = {
    ...metaOf(el),
    tag: ltag,
    x: x0, y: y + mt, w, h: 0,
    bg, grad, borderColor, borderW, color, fontSize,
    radius, overflow,
    lines: [], children: [],
    img: tag === "IMG" ? (el.getAttribute?.("src") || "").slice(0, 120) : undefined,
    bitmap: undefined,
  }
  void id
  void cls

  // --- elemen atomik ---
  if (tag === "IMG") {
    const h = px(sv(style, "height"), 0, parentFont) || attrPx(el, "height", 140)
    const wDecl = px(sv(style, "width"), 0, parentFont) || attrPx(el, "width", 0)
    if (wDecl > 0) box.w = wDecl // lebar nyata gambar (attr/style), bukan availW
    box.h = h + pt + pb + bt + bb
    const bmp = images?.get(el)
    if (bmp) box.bitmap = bmp
    else {
      const alt = el.getAttribute?.("alt") || ""
      if (alt) box.lines.push({ text: alt, x: x0 + pl + bl + 4, y: box.y + pt + bt + fontSize, size: fontSize, color })
    }
    return box
  }
  if (tag === "SVG") {
    box.h = attrPx(el, "height", 24)
    box.w = Math.min(w, attrPx(el, "width", box.h))
    return box
  }
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    const th = tag === "TEXTAREA" ? attrPx(el, "rows", 3) * fontSize * 1.4 : Math.max(24, fontSize + 8)
    box.h = th + pt + pb + bt + bb
    const txt = inputText(el)
    if (txt) box.lines.push({ text: txt, x: x0 + pl + bl + 4, y: box.y + pt + bt + fontSize * 0.9, size: fontSize, color })
    return box
  }
  if (tag === "BUTTON") {
    const th = Math.max(24, fontSize + 8)
    box.h = th + pt + pb + bt + bb
    const txt = (el.textContent || "").trim()
    if (txt) {
      const lines = wrapText(ctx, txt, fontSize, contentW, hasFont)
      let ly = pt + bt + fontSize * 0.95
      for (const ln of lines) {
        box.lines.push({ text: ln, x: x0 + pl + bl + 4, y: box.y + ly, size: fontSize, color })
        ly += fontSize * 1.35
      }
      box.h = lines.length * fontSize * 1.35 + pt + pb + bt + bb
    }
    return box
  }

  // --- alur konten ---
  const children = [...(el.childNodes || [])]
  const isFlex = display === "flex" || display === "inline-flex"
  const flexDir = (sv(style, "flex-direction") || "row").includes("column") ? "col" : "row"
  const contentX = x0 + pl + bl
  const contentY = box.y + pt + bt

  let cy = 0
  let inlineBuf = ""
  const flushInline = () => {
    if (!inlineBuf.trim()) { inlineBuf = ""; return }
    const lines = wrapText(ctx, inlineBuf, fontSize, contentW, hasFont)
    let ly = fontSize * 0.95
    for (const ln of lines) {
      box.lines.push({ text: ln, x: contentX, y: contentY + ly, size: fontSize, color })
      ly += fontSize * 1.35
    }
    cy += lines.length * fontSize * 1.35
    inlineBuf = ""
  }

  if (isFlex && flexDir === "row") {
    const blocks = children.filter((c) => c.nodeType === 1)
    const n = Math.max(1, blocks.length)
    const cellW = contentW / n
    let cx = contentX
    let rowH = 0
    for (const kid of blocks) {
      const b = layoutEl(kid, cx, contentY, cellW, styleFn, ctx, hasFont, images, depth + 1)
      if (b) { box.children.push(b); rowH = Math.max(rowH, b.h); cx += cellW }
    }
    cy = rowH
  } else {
    for (const kid of children) {
      if (kid.nodeType === 3 || kid.nodeType === 4) { inlineBuf += kid.data; continue }
      if (kid.nodeType !== 1) continue
      const kd = (sv(styleFn(kid), "display") || "").trim().toLowerCase()
      const kidTag = (kid.tagName || "").toUpperCase()
      const inlineish = kd === "inline" || kd.startsWith("inline")
        || (INLINE_TAGS.has(kidTag) && !kd)
      // IMG/SVG/IFRAME = atomik — jsdom default img{display:inline} tak boleh
      // mengunyahnya jadi teks inline (alt kosong → hilang dari layout)
      const forceAtom = kidTag === "IMG" || kidTag === "SVG" || kidTag === "IFRAME"
      if (inlineish && !forceAtom) { inlineBuf += inlineText(kid); continue }
      flushInline()
      const b = layoutEl(kid, contentX, contentY + cy, contentW, styleFn, ctx, hasFont, images, depth + 1)
      if (b) {
        box.children.push(b)
        cy = b.y + b.h - contentY + px(sv(styleFn(kid), "margin-bottom"), 0, fontSize)
      }
    }
    flushInline()
  }

  box.h = Math.max(0, cy) + pt + pb + bt + bb
  const heightDecl = sv(style, "height")
  if (heightDecl && heightDecl !== "auto") {
    const dh = px(heightDecl, 0, fontSize)
    if (dh > 0) box.h = dh
  }
  if (box.h < fontSize * 0.8 && !box.lines.length && !box.children.length
      && !(heightDecl && heightDecl !== "auto")) {
    box.h = 0
  }
  return box
}

// --- box tree (meta utk AI) -------------------------------------------------

function boxTree(box, depth, acc, maxDepth, maxNodes) {
  if (!box || acc.n >= maxNodes || depth > maxDepth) return null
  acc.n++
  const node = {
    tag: box.tag,
    x: Math.round(box.x), y: Math.round(box.y),
    w: Math.round(box.w), h: Math.round(box.h),
  }
  if (box.id) node.id = box.id
  if (box.cls) node.cls = box.cls
  if (box.bg || box.grad) node.bg = box.grad ? "gradient" : box.bg
  if (box.img) node.img = box.img
  const text = box.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim()
  if (text) node.text = text.slice(0, 100)
  const kids = []
  for (const c of box.children) {
    const k = boxTree(c, depth + 1, acc, maxDepth, maxNodes)
    if (k) kids.push(k)
  }
  if (kids.length) node.children = kids
  return node
}

// --- paint ------------------------------------------------------------------

function paint(ctx, box) {
  if (!box) return
  const X = Math.round(box.x)
  const Y = Math.round(box.y)
  const W = Math.round(box.w)
  const H = Math.round(box.h)
  const r = Math.max(0, Math.min(box.radius || 0, Math.min(W, H) / 2))
  const rounded = r >= 1

  // bg (solid | gradient) — rounded pakai path roundRect
  const paintBg = () => {
    if (box.grad) {
      const g = ctx.createLinearGradient(X, Y, X + W, Y)
      for (const [t, c] of box.grad) g.addColorStop(Math.max(0, Math.min(1, t)), c)
      ctx.fillStyle = g
    } else if (box.bg) {
      ctx.fillStyle = box.bg
    } else return
    if (rounded) {
      ctx.beginPath()
      ctx.roundRect(X, Y, W, H, r)
      ctx.fill()
    } else if (W > 0 && H > 0) {
      ctx.fillRect(X, Y, W, H)
    }
  }
  paintBg()

  // border (rounded → path stroke; square → strokeRect)
  if (box.borderW > 0 && W > 1 && H > 1) {
    ctx.strokeStyle = box.borderColor || "rgb(0, 0, 0)"
    ctx.lineWidth = Math.max(1, Math.round(box.borderW))
    if (rounded) {
      ctx.beginPath()
      ctx.roundRect(X + 0.5, Y + 0.5, Math.max(1, W - 1), Math.max(1, H - 1), r)
      ctx.stroke()
    } else {
      ctx.strokeRect(X + 0.5, Y + 0.5, Math.max(1, W - 1), Math.max(1, H - 1))
    }
  }

  // gambar asli (contain-fit di tengah box)
  if (box.bitmap && box.bitmap.width) {
    const iw = box.bitmap.width
    const ih = box.bitmap.height
    const s = Math.min(W / iw, H / ih)
    const dw = Math.max(1, Math.round(iw * s))
    const dh = Math.max(1, Math.round(ih * s))
    const dx = X + Math.round((W - dw) / 2)
    const dy = Y + Math.round((H - dh) / 2)
    try { ctx.drawImage(box.bitmap, 0, 0, iw, ih, dx, dy, dw, dh) } catch { /* skip */ }
  }

  // teks
  const drawLines = () => {
    for (const ln of box.lines) {
      if (!ln.text) continue
      ctx.fillStyle = ln.color || "rgb(0, 0, 0)"
      ctx.font = `${Math.round(ln.size)} ${FAMILY}`
      try { ctx.fillText(ln.text, Math.round(ln.x), Math.round(ln.y)) } catch { /* clip */ }
    }
  }
  if (box.lines.length) drawLines()

  // anak — overflow clip bila diminta
  const kids = () => {
    if (!box.children.length) return
    if (box.overflow) {
      const cx = X + (box.borderW > 0 ? Math.round(box.borderW) : 0)
      const cy = Y + (box.borderW > 0 ? Math.round(box.borderW) : 0)
      ctx.save()
      ctx.beginPath()
      ctx.rect(cx, cy, Math.max(1, W), Math.max(1, H))
      ctx.clip()
      for (const c of box.children) paint(ctx, c)
      ctx.restore()
    } else {
      for (const c of box.children) paint(ctx, c)
    }
  }
  kids()
}

function countBoxes(box) {
  if (!box) return 0
  return 1 + box.children.reduce((a, c) => a + countBoxes(c), 0)
}

// --- prep bersama (layout tanpa raster) -------------------------------------

async function prepLayout(page, opts, { wantImages }) {
  const doc = page.document
  if (!doc || !doc.body) {
    throw new Error("screenshot: belum ada halaman. Jalankan navigate dulu.")
  }
  const clampN = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt
  }
  const W = clampN(opts.width, 64, 4096, 1024)
  const sel = typeof opts.selector === "string" && opts.selector.trim() ? opts.selector.trim() : null
  const root = sel ? doc.querySelector(sel) : doc.body
  if (!root) throw new Error(`screenshot: selector ${JSON.stringify(sel)} tidak ditemukan`)

  const styleFn = makeStyleFn(page)
  const PImage = await import("pureimage")
  const hasFont = await ensureFont(PImage)
  const images = wantImages ? await loadImages(root, page) : new Map()
  if (!("failed" in images)) images.failed = []

  const probeCtx = PImage.make(8, 8).getContext("2d")
  const lay = layoutEl(root, 0, 0, W, styleFn, probeCtx, hasFont, images, 0)
  const contentH = lay ? Math.ceil(lay.y + lay.h) : 0
  return { W, sel, root, styleFn, PImage, hasFont, images, lay, contentH, clampN, opts }
}

// Layout-only → box tree JSON (format "tree": ringan, tanpa PNG).
export async function layoutTree(page, opts = {}) {
  const p = await prepLayout(page, opts, { wantImages: false })
  const maxDepth = Math.max(1, Math.min(40, Number(opts.maxDepth) || 12))
  const maxNodes = Math.max(1, Math.min(5000, Number(opts.maxNodes) || 800))
  const tree = boxTree(p.lay, 0, { n: 0 }, maxDepth, maxNodes)
  return {
    tree,
    boxes: countBoxes(p.lay),
    css: p.styleFn.mode,
    width: p.W,
    contentHeight: p.contentH,
    truncated: tree && p.contentH && Number(opts.maxDepth) < 12 ? false : undefined,
  }
}

// Full render → PNG buffer (+ tree ringkas utk meta).
export async function renderShot(page, opts = {}) {
  const p = await prepLayout(page, opts, { wantImages: true })
  const { W, styleFn, PImage, hasFont, images, lay, contentH, clampN, opts: o } = p

  const scale = clampN(o.deviceScale, 1, 3, 1)
  const H = o.fullPage
    ? clampN(contentH, 64, 8192, 768)
    : clampN(o.height, 64, 4096, 768)

  // P3-8 R5: tolak SEBELUM alokasi bitmap (error jujur + angka), jangan
  // mengalokasikan 1,15GB lalu OOM membunuh seluruh proses MCP.
  const pixelW = W * scale
  const pixelH = H * scale
  if (pixelW * pixelH > MAX_SHOT_PIXELS) {
    throw new McpError(
      ERR.INVALID_PARAMS,
      `screenshot terlalu besar: ${pixelW}×${pixelH} = ${pixelW * pixelH} piksel > batas ${MAX_SHOT_PIXELS} piksel (RGBA 64MB) — kurangi width/height/deviceScale atau matikan fullPage`,
    )
  }

  const img = PImage.make(pixelW, pixelH)
  const ctx = img.getContext("2d")
  if (scale !== 1) ctx.scale(scale, scale)
  ctx.fillStyle = "rgb(255, 255, 255)"
  ctx.fillRect(0, 0, W, H)
  paint(ctx, lay)

  // outline merah utk selector target (debug)
  if (p.sel && o.outline && lay) {
    ctx.strokeStyle = "rgb(255, 0, 0)"
    ctx.lineWidth = Math.max(1, 3 / scale)
    ctx.strokeRect(1, 1, W - 2, H - 2)
  }

  const chunks = []
  const stream = new PassThrough()
  stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  const ended = new Promise((resolve, reject) => {
    stream.on("end", resolve)
    stream.on("error", reject)
  })
  await PImage.encodePNGToStream(img, stream)
  await ended

  const maxDepth = Math.max(1, Math.min(40, Number(o.maxDepth) || 8))
  const maxNodes = Math.max(1, Math.min(5000, Number(o.maxNodes) || 400))
  const tree = boxTree(lay, 0, { n: 0 }, maxDepth, maxNodes)

  return {
    png: Buffer.concat(chunks),
    width: W,
    height: H,
    pixelWidth: W * scale,
    pixelHeight: H * scale,
    deviceScale: scale,
    boxes: countBoxes(lay),
    images: images.loaded || 0,
    imageFailed: images.failed || [], // <img> gagal dimuat (P1 R4) → notes jujur
    tree,
    css: styleFn.mode,      // "cascade" (engine js) | "inline" (engine dom)
    font: hasFont,          // false = teks tidak digambar (boxes tetap)
    truncated: !!o.fullPage && contentH > H,
  }
}
