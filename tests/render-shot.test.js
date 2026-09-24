// render-shot.test.js — screenshot wireframe PNG (murni Node, tanpa Chromium
// / tanpa Playwright). Bukti per kasus: magic PNG + piksel hasil DECODE
// (getPixelRGBA → u32 big-endian RGBA: R=palang 24, G=16, B=8, A=0).
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { Readable } from "node:stream"
import { parseHTML } from "linkedom"
import { startFixtureServer } from "./fixtures/live-server.js"
import { renderShot } from "../src/render-shot.js"
import { createTools } from "../src/tools.js"
import { createJsPage } from "../src/engine-js.js"

process.env.MCWEB_ALLOW_PRIVATE = "1" // fixture server = 127.0.0.1 (pola file test lain)

const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex")

async function px(buf, x, y) {
  const PImage = await import("pureimage")
  const img = await PImage.decodePNGFromStream(Readable.from([buf]))
  const n = img.getPixelRGBA(x, y) // u32
  return { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: n & 255 }
}
const isRed = (c) => c.r > 240 && c.g < 30 && c.b < 30
const isBlue = (c) => c.b > 240 && c.r < 30 && c.g < 30
const isWhite = (c) => c.r > 240 && c.g > 240 && c.b > 240

const fx = await startFixtureServer()
test.after(() => fx.server.close())

test("render-shot engine dom: box warna (inline) — magic + pixel merah/biru/putih", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body style="margin:0">
    <div id="red" style="background-color: rgb(255, 0, 0); width: 200px; height: 100px"></div>
    <div id="blue" style="background: #0000ff; height: 50px; margin-top: 10px">Halo</div>
    <button id="btn" style="border:1px solid #333; background:#dddddd">Kirim</button>
  </body></html>`)
  const out = await renderShot({ document, window: null }, { width: 400, height: 300 })
  assert.deepEqual(out.png.subarray(0, 8), PNG_MAGIC, "magic PNG")
  assert.equal(out.css, "inline", "engine dom → mode inline")
  assert.ok(out.boxes >= 4, `boxes >= 4 (dapat ${out.boxes})`)
  assert.ok(isRed(await px(out.png, 50, 50)), "box merah @50,50")
  assert.ok(isBlue(await px(out.png, 50, 135)), "box biru @50,135")
  assert.ok(isWhite(await px(out.png, 390, 290)), "bg putih @390,290")
})

test("render-shot: selector merender subtree saja", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body style="margin:0">
    <div id="red" style="background:#ff0000; width:300px; height:200px"></div>
    <div id="rest" style="background:#00ff00; height:400px"></div>
  </body></html>`)
  const out = await renderShot({ document, window: null }, { width: 300, height: 200, selector: "#red" })
  assert.ok(isRed(await px(out.png, 10, 10)), "subtree #red mulai di 0,0")
  assert.ok(isRed(await px(out.png, 290, 190)), "selector = crop subtree penuh (300x200 merah, #rest tak ikut)")
})

test("render-shot: fullPage = tinggi konten (bukan viewport)", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body style="margin:0">
    <div style="background:#123456; height:2000px"></div>
  </body></html>`)
  const vp = await renderShot({ document, window: null }, { width: 200, height: 300 })
  const full = await renderShot({ document, window: null }, { width: 200, fullPage: true })
  assert.equal(vp.height, 300, "tanpa fullPage → viewport")
  assert.ok(full.height >= 2000, `fullPage → konten (dapat ${full.height})`)
})

test("render-shot tanpa halaman → error jelas", async () => {
  await assert.rejects(
    () => renderShot({ document: null, window: null }, {}),
    /navigate dulu/,
  )
})

test("render-shot engine js: ensureStyles → cascade stylesheet EKSTERNAL ke pixel", async () => {
  const page = createJsPage()
  try {
    await page.navigate(fx.url + "styled/")
    const st = await page.ensureStyles()
    assert.equal(st.mode, "cascade")
    assert.ok(st.injected >= 1, `stylesheet ter-inject (dapat ${st.injected})`)
    const again = await page.ensureStyles()
    assert.equal(again.cached, true, "ensureStyles idempotent per URL")
    const out = await renderShot(page, { width: 400, height: 300 })
    assert.equal(out.css, "cascade", "mode cascade utk engine js")
    assert.ok(isRed(await px(out.png, 50, 50)), "warna dari style.css luar → pixel merah @50,50")
  } finally {
    page.reset()
  }
})

test("tools screenshot format:png (engine dom) → image content + file valid", async () => {
  const tools = await createTools({ engine: "dom" })
  const shot = tools.find((t) => t.name === "screenshot")
  assert.ok(shot, "tool screenshot terdaftar")
  await shot.handler({}).catch(() => {}) // tanpa halaman → error (requirePage)
  const nav = await tools.find((t) => t.name === "navigate").handler({ url: fx.url })
  assert.ok(nav.isError === false, "navigate ok")
  const out = await shot.handler({ format: "png", width: 320, height: 240 })
  assert.equal(out.isError, false)
  assert.equal(out.content[0].type, "image")
  assert.equal(out.content[0].mimeType, "image/png")
  const raw = Buffer.from(out.content[0].data, "base64")
  assert.deepEqual(raw.subarray(0, 8), PNG_MAGIC, "image payload = PNG")
  const meta = JSON.parse(out.content[1].text)
  assert.ok(meta.file && fs.existsSync(meta.file), `file PNG ada (${meta.file})`)
  assert.deepEqual(
    fs.readFileSync(meta.file).subarray(0, 8),
    PNG_MAGIC,
    "file = PNG valid",
  )
  assert.equal(meta.width, 320)
  fs.rmSync(meta.file, { force: true })
})

test("tools screenshot default (text) & html tetap seperti lama (regresi)", async () => {
  const tools = await createTools({ engine: "dom" })
  await tools.find((t) => t.name === "navigate").handler({ url: fx.url })
  const shot = tools.find((t) => t.name === "screenshot")
  const t1 = await shot.handler({})
  assert.equal(t1.content[0].type, "text")
  assert.match(t1.content[0].text, /Buka/, "textContent = isi body fixture (tetap seperti lama)")
  const t2 = await shot.handler({ format: "html" })
  assert.equal(t2.content[0].type, "text")
  assert.match(t2.content[0].text, /<html|<body|<head/i)
})

// ── fitur v2 (combo maksimal MCP + plugin) ─────────────────────────────────

test("render-shot v2: <img> asli — fetch + decode PNG + drawImage contain-fit", async () => {
  const page = createJsPage()
  try {
    await page.navigate(fx.url + "imgtest/")
    const out = await renderShot(page, { width: 300, height: 100 })
    assert.equal(out.images, 1, "satu gambar ter-decode")
    const c1 = await px(out.png, 20, 30)  // dalam box gambar (merah)
    const c2 = await px(out.png, 150, 30) // di luar gambar (putih)
    assert.ok(isRed(c1), `pixel di area <img> = merah (dapat rgb(${c1.r},${c1.g},${c1.b}))`)
    assert.ok(isWhite(c2), "di luar <img> = putih")
  } finally {
    page.reset()
  }
})

test("render-shot v2: overflow hidden → clip anak ke content rect", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body style="margin:0">
    <div style="overflow:hidden;height:30px;background:#eeeeee">
      <div style="background:#00ff00;height:200px"></div>
    </div>
  </body></html>`)
  const out = await renderShot({ document, window: null }, { width: 200, height: 200 })
  const inside = await px(out.png, 10, 15)   // y<30 → anak hijau terlihat
  const outside = await px(out.png, 10, 60)  // y>30 → ke-clip, kebaca bg abu/putih
  assert.ok(inside.g > 200 && inside.r < 60, `dalam clip = hijau (dapat rgb(${inside.r},${inside.g},${inside.b}))`)
  assert.ok(!(outside.g > 200 && outside.r < 60), "di luar clip TIDAK hijau (terpotong)")
})

test("render-shot v2: border-radius → sudut melengkung (bukan kotak penuh)", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body style="margin:0">
    <div style="background:#ff0000;border-radius:16px;width:80px;height:80px"></div>
    <div style="background:#0000ff;margin-left:100px;width:80px;height:80px"></div>
  </body></html>`)
  const out = await renderShot({ document, window: null }, { width: 200, height: 100 })
  const roundCorner = await px(out.png, 2, 2)     // rounded → di luar path → putih
  const squareCorner = await px(out.png, 102, 85) // box kedua block-flow di bawah (y=80) → biru
  assert.ok(isWhite(roundCorner), `sudut rounded kosong (dapat rgb(${roundCorner.r},${roundCorner.g},${roundCorner.b}))`)
  assert.ok(isBlue(squareCorner), "sudut square terisi")
})

test("render-shot v2: background linear-gradient → gradasi merah→biru", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body style="margin:0">
    <div style="width:100px;height:20px;background:linear-gradient(to right, #ff0000, #0000ff)"></div>
  </body></html>`)
  const out = await renderShot({ document, window: null }, { width: 120, height: 40 })
  const left = await px(out.png, 5, 10)
  const right = await px(out.png, 95, 10)
  assert.ok(left.r > 180 && left.b < 80, `kiri = merah (rgb(${left.r},${left.g},${left.b}))`)
  assert.ok(right.b > 180 && right.r < 80, `kanan = biru (rgb(${right.r},${right.g},${right.b}))`)
})

test("render-shot v2: deviceScale 2 → bitmap 2x, koordinat logis tetap", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body style="margin:0">
    <div style="background:#ff0000;width:200px;height:100px"></div>
  </body></html>`)
  const out = await renderShot({ document, window: null }, { width: 400, height: 300, deviceScale: 2 })
  assert.equal(out.width, 400, "lebar logis")
  assert.equal(out.pixelWidth, 800, "piksel = 2x")
  assert.equal(out.deviceScale, 2)
  const c = await px(out.png, 100, 100) // skala: (50,50) logis → (100,100) px
  assert.ok(isRed(c), "posisi box benar di bawah scale")
})

test("render-shot v2: format tree (tools) → box tree JSON tanpa PNG", async () => {
  const tools = await createTools({ engine: "dom" })
  await tools.find((t) => t.name === "navigate").handler({ url: fx.url })
  const shot = tools.find((t) => t.name === "screenshot")
  const out = await shot.handler({ format: "tree" })
  assert.equal(out.content[0].type, "text")
  const meta = JSON.parse(out.content[0].text)
  assert.equal(meta.format, "tree")
  assert.ok(meta.boxes > 0, "ada box")
  assert.equal(meta.css, "inline")
  assert.ok(meta.tree && meta.tree.tag, "tree berakar")
  assert.ok(Array.isArray(meta.tree.children) && meta.tree.children.length > 0, "punya anak")
  const walk = (n) => [n, ...(n.children || []).flatMap(walk)]
  const flat = walk(meta.tree)
  assert.ok(flat.some((n) => n.text && n.text.length > 0), "ada node teks")
})

test("render-shot v2: teks TERGAMBAR (bug kerning pureimage ter-patch)", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body style="margin:0">
    <div style="background:#ffffff;height:60px"><span style="font-size:32px;color:#000000">HELLO WIRE</span></div>
  </body></html>`)
  const out = await renderShot({ document, window: null }, { width: 300, height: 80 })
  assert.equal(out.font, true, "font loaded")
  const PImage = await import("pureimage")
  const img = await PImage.decodePNGFromStream(Readable.from([out.png]))
  let dark = 0
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 300; x++) {
      const n = img.getPixelRGBA(x, y)
      if (((n >>> 24) & 255) < 160 && ((n >>> 16) & 255) < 160 && ((n >>> 8) & 255) < 160) dark++
    }
  }
  assert.ok(dark > 20, `teks hitam tampil (dark px = ${dark}; 0 = fillText tak menggambar)`)

})

test("render-shot v2: outline selector → tepi viewport merah", async () => {
  const tools = await createTools({ engine: "dom" })
  await tools.find((t) => t.name === "navigate").handler({ url: fx.url })
  const shot = tools.find((t) => t.name === "screenshot")
  const out = await shot.handler({ format: "png", width: 300, height: 200, selector: "body", outline: true })
  const meta = JSON.parse(out.content[1].text)
  const raw = Buffer.from(out.content[0].data, "base64")
  const c = await px(raw, 1, 1) // strokeRect(1,1) lw3 → coverage [-0.5, 2.5] → pixel 1 kena
  assert.ok(isRed(c), `outline merah @3,3 (dapat rgb(${c.r},${c.g},${c.b}))`)
  assert.ok(meta.file)
  fs.rmSync(meta.file, { force: true })
})

// P3-8 critic R5: kombinasi parameter yang tercatat SAH (width 4096 +
// fullPage tinggi konten + deviceScale 3 → 12288×24576 = 301.989.888 px)
// minta bitmap RGBA 1,15GB (RSS terukur 1296,5MB) + encode >18s → risiko OOM
// membunuh proses MCP (semua tool ikut mati). Fix = cap luas-piksel gabungan
// MAX_SHOT_PIXELS (16.777.216 = 4096×4096 = RGBA 64MB) di src/render-shot.js.
test("render-shot P3-8: cap luas-piksel gabungan — combo 4096 + fullPage + scale 3 DITOLAK sebelum alokasi", async () => {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>
    <div style="background:#123456;height:8000px">halaman sangat panjang</div>
  </body></html>`)
  const t0 = Date.now()
  await assert.rejects(
    () => renderShot({ document, window: null }, { width: 4096, height: 4096, fullPage: true, deviceScale: 3 }),
    (e) => {
      assert.equal(e.code, -32602, "penolakan argumen = -32602")
      assert.match(e.message, /screenshot terlalu besar/, `pesan jujur dengan angka, dapat: ${e.message}`)
      assert.match(e.message, /batas 16777216 piksel/)
      return true
    },
    "kombinasi 12288×24576 px (bitmap 1,15GB) wajib ditolak",
  )
  assert.ok(Date.now() - t0 < 3000, `tolak SEBELUM alokasi bitmap (dapat ${Date.now() - t0}ms — alokasi 1,15GB = ±9,3s terukur)`)

  // Kombinasi wajar di bawah cap tetap jalan normal (tak ada efek samping).
  const ok = await renderShot({ document, window: null }, { width: 400, height: 300, deviceScale: 3 })
  assert.deepEqual(ok.png.subarray(0, 8), PNG_MAGIC, "PNG valid di bawah cap")
  assert.equal(ok.pixelWidth, 1200, "400×3 = 1200px")
})
