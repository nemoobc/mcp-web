// mcp-web — P1 critic R4: fetch aset screenshot (stylesheet <link> & <img>)
// TANPA signal/timeout → aset yang tak PERNAH merespons menggantungkan
// screenshot ±301 detik (batas alam undici) dan menyumbat antrian serial
// stdio — SEMUA tool terblokir.
//
// Fix diuji di sini: ASSET_TIMEOUT_MS (10s, src/assets.js) dibawa oleh fetch
// stylesheet (engine-js ensureStyles) dan fetch gambar (render-shot
// loadImages) → gagal = render LANJUT tanpa aset itu + `notes` jujur di
// hasil screenshot, BUKAN gantung dan BUKAN sukses palsu.
//
// Test DETERMINISTIK — TANPA timing tebakan:
//  * gate fixture HTTP tak pernah dilepas selama assertion → tanpa fix
//    screenshot menggantung → watchdog 20s yang menagih;
//  * timeout aset 10s = gate waktu NYATA → selesai < 20s (gerbang ms<20000;
//    10s timeout + margin timer-starvation Termux; data: 10,4s solo, 13,3s
//    paralel, 15,4s pernah tercatat) membuktikan timeout bekerja — tanpa fix
//    gantung ±301s kena watchdog 25s.
//
// R5 critic (test regresi ditambahkan):
//  * P2-3: 3 stylesheet menggantung wajib di-fetch PARALEL (bukti: `startedAt`
//    serentak di network log) — dulu sekuensial 3×10s = 30247ms;
//  * P2-4: `stop` SAAT screenshot → screenshot batal cepat (dulu stop jawab
//    "tidak ada inflight" dan screenshot lanjut 32176ms);
//  * P2-6: gerbang diubah dari wall-clock total (FLAKY: 15132/15361ms gagal
//    2/3 run padahal fix bekerja) → MEKANISME: `timing` fetch aset ±10s dari
//    network log + plafon longgar 20s + watchdog 25s tetap jadi detektor
//    gantung.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { createTools } from "../src/tools.js"
import { ASSET_TIMEOUT_MS } from "../src/assets.js"

// Fixture test ada di 127.0.0.1 → izinkan target private.
process.env.MCWEB_ALLOW_PRIVATE = "1"

assert.equal(ASSET_TIMEOUT_MS, 10000, "timeout aset = 10s (satu sumber angka, src/assets.js)")

const outcome = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

// Race terhadap watchdog: tanpa fix, screenshot menggantung tanpa batas →
// watchdog yang menagih (bukan tidur lalu berharap).
async function raced(p, ms) {
  let t
  const wd = new Promise((r) => { t = setTimeout(() => r({ watchdog: true }), ms) })
  const out = await Promise.race([p, wd])
  clearTimeout(t)
  return out
}

// 1x1 PNG valid — aset kontrol yang merespons normal.
const OK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex")

let srv
let base
let tools
let navigate
let shot
let stop
let network
const pages = new Map() // pathname -> html
const gates = new Map() // pathname -> {hit, release, released}
const assets = new Map() // pathname -> {type, body} | "gated"

function installGate(pathname) {
  let release
  const park = new Promise((r) => { release = r })
  const g = { hit: false, released: false, release: () => { g.released = true; release() } }
  g.park = park
  gates.set(pathname, g)
  return g
}

before(async () => {
  // Gate aset: TAK PERNAH merespons selama assertion (dilepas di after() saja).
  installGate("/hang.css")
  installGate("/hang.png")
  installGate("/hang2.css")
  installGate("/hang3.css")
  installGate("/hang-stop.css")

  pages.set("/css-hang/", `<!doctype html><html><head><title>CssHang</title>
  <link rel="stylesheet" href="/hang.css">
</head><body><p>Buka css hang</p></body></html>`)
  // P2-3 R5: 3 stylesheet menggantung → dulu SEKUENSIAL (3×10s = 30247ms).
  pages.set("/css3-hang/", `<!doctype html><html><head><title>Css3Hang</title>
  <link rel="stylesheet" href="/hang.css">
  <link rel="stylesheet" href="/hang2.css">
  <link rel="stylesheet" href="/hang3.css">
</head><body><p>Tiga css gantung</p></body></html>`)
  // P2-4 R5: khusus test `stop` — halaman ini belum pernah di-screenshot →
  // ensureStyles TAK cached → fetch aset benar-benar berjalan saat stop datang.
  pages.set("/css-stop/", `<!doctype html><html><head><title>CssStop</title>
  <link rel="stylesheet" href="/hang-stop.css">
</head><body><p>Stop saat screenshot</p></body></html>`)
  pages.set("/img-hang/", `<!doctype html><html><head><title>ImgHang</title></head>
<body style="margin:0"><p>Buka img hang</p>
  <img src="/hang.png" width="40" height="40" alt="altgantung">
</body></html>`)
  pages.set("/ok/", `<!doctype html><html><head><title>Ok</title>
  <link rel="stylesheet" href="/ok.css">
</head><body style="margin:0"><div class="okbox">Kontrol aset</div>
  <img src="/ok.png" width="40" height="40" alt="">
</body></html>`)
  assets.set("/ok.css", { type: "text/css", body: ".okbox { background-color: #00ff00; height: 40px; }" })
  assets.set("/ok.png", { type: "image/png", body: OK_PNG })

  srv = http.createServer((req, res) => {
    const u = req.url.split("?")[0]
    const gate = gates.get(u)
    if (gate) {
      gate.hit = true
      gate.park.then(() => {
        if (res.destroyed || res.writableEnded) return
        try {
          res.writeHead(200, { "Content-Type": u.endsWith(".css") ? "text/css" : "image/png" })
          res.end(u.endsWith(".css") ? ".late{}" : OK_PNG)
        } catch { /* socket sudah ditutup klien (di-abort) — abaikan */ }
      })
      return
    }
    const html = pages.get(u)
    if (html !== undefined) {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(html)
      return
    }
    const a = assets.get(u)
    if (a) {
      res.writeHead(200, { "Content-Type": a.type, "Content-Length": a.body.length })
      res.end(a.body)
      return
    }
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("not found: " + u)
  })
  await new Promise((r) => srv.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${srv.address().port}`
  // Hangatkan font render (sekali per proses) SEBELUM test — supaya durasi
  // assertion <12s murni mengukur timeout aset, bukan pemuatan font pertama.
  const { renderShot } = await import("../src/render-shot.js")
  const { parseHTML } = await import("linkedom")
  const warmDoc = parseHTML("<!doctype html><html><body><p>warm font</p></body></html>")
  await renderShot({ document: warmDoc.document, window: null }, { width: 80, height: 40 })
  tools = await createTools({ engine: "js" })
  navigate = tools.find((t) => t.name === "navigate")
  shot = tools.find((t) => t.name === "screenshot")
  stop = tools.find((t) => t.name === "stop")
  network = tools.find((t) => t.name === "network_logs")
})

after(async () => {
  for (const g of gates.values()) g.release() // jangan gantung handler gate
  srv.closeAllConnections?.()
  await new Promise((r) => srv.close(r))
})

// Ambil entri network log FLEKSIBEL (array log tool network_logs).
// CATATAN: wrapper handler (src/tools.js) kini async → WAJIB await (dulu sync,
// tanpa await → .content undefined → TypeError di 3 test P1/P2-3).
async function netLogs() {
  const out = await network.handler()
  return JSON.parse(out.content[0].text).logs
}

test("P1-a: stylesheet tak PERNAH merespons → screenshot format:tree selesai <20s + notes stylesheet gagal", async () => {
  const gate = gates.get("/hang.css")
  const nav = await raced(outcome(navigate.handler({ url: `${base}/css-hang/`, timeoutMs: 30000 })), 45000)
  assert.ok(!nav.watchdog, "navigate fixture HTML lokal menggantung ≥45s (server fixture rusak?)")
  assert.equal(nav.ok, true, nav.ok ? "" : `navigate fixture gagal: ${nav.e.message}`)
  const t0 = Date.now()
  const r = await raced(outcome(shot.handler({ format: "tree" })), 25000)
  const ms = Date.now() - t0
  // P2-6 R5 (gerbang lama FLAKY: `ms < 15000` gagal 2/3 run dgn angka 15132ms
  // & 15361ms padahal fix timeout-nya BEKERJA): gerbang kini MENGGUKUR
  // MEKANISME dari network log — durasi fetch aset-nya SENDIRI (timing entri
  // error hang.css) wajib ±10s. Render/encode di luar kendali (kekurangan CPU
  // saat suite paralel) tak lagi memutus hasil.
  const hang = (await netLogs()).filter((l) => String(l.url).includes("hang.css") && l.startedAt >= t0).pop()
  assert.ok(hang, `network log wajib punya entri fetch hang.css gagal, dapat: ${JSON.stringify((await netLogs()).slice(-3))}`)
  assert.equal(hang.status, 0, "fetch hang.css = error (timeout), bukan sukses")
  assert.ok(hang.timing >= 9900 && hang.timing <= 14000,
    `timeout aset wajib mematikan fetch hang.css ±10000ms, dapat ${hang.timing}ms`)
  // Plafon wall-clock TOTAL yang LONGGAR (detektor utama = watchdog 25s di
  // bawah + timing di atas): angka nyata — 12075ms solo, 13858ms suite paralel,
  // 15361ms saat kontensi CPU eksternal. Tanpa fix: ±301000ms.
  assert.ok(ms < 20000, `respons ${ms}ms — wajib < 20000ms (timeout aset 10000ms + margin; terukur maks 15361ms)`)
  assert.ok(!r.watchdog, "screenshot MASIH MENGANTUNG ≥25s — stylesheet tanpa timeout (P1 reproduksi)")
  assert.equal(r.ok, true, r.ok ? "" : `screenshot seharusnya SUKSES lanjut tanpa stylesheet, dapat: ${r.e.message}`)
  const meta = JSON.parse(r.v.content[0].text)
  assert.equal(meta.format, "tree")
  assert.ok(Array.isArray(meta.notes) && meta.notes.length > 0, `wajib ada notes kegagalan aset, dapat: ${JSON.stringify(meta.notes)}`)
  assert.ok(meta.notes.some((n) => /stylesheet gagal dimuat/.test(n) && /hang\.css/.test(n)),
    `notes wajib menyebut stylesheet gagal + hang.css, dapat: ${JSON.stringify(meta.notes)}`)
  assert.ok(meta.notes.some((n) => /TimeoutError|Timeout|aborted|Abort/i.test(n)),
    `notes wajib menyebut alasan timeout, dapat: ${JSON.stringify(meta.notes)}`)
  assert.equal(gate.released, false, "gate TIDAK pernah dilepas selama assertion — bukti tak menunggu server")
})

test("P1-b: gambar TAK PERNAH merespons → screenshot format:png selesai <20s + notes gambar gagal", async () => {
  const gate = gates.get("/hang.png")
  const nav = await raced(outcome(navigate.handler({ url: `${base}/img-hang/`, timeoutMs: 30000 })), 45000)
  assert.ok(!nav.watchdog, "navigate fixture HTML lokal menggantung ≥45s (server fixture rusak?)")
  assert.equal(nav.ok, true, nav.ok ? "" : `navigate fixture gagal: ${nav.e.message}`)
  const t0 = Date.now()
  // Viewport kecil: raster PNG jadi murah → durasi jatuh ke timeout aset 10s,
  // bukan encode besar.
  const r = await raced(outcome(shot.handler({ format: "png", width: 120, height: 80 })), 25000)
  const ms = Date.now() - t0
  // P2-6 R5: gerbang MEKANISME (timing fetch hang.png di network log ±10s) +
  // plafon wall-clock longgar 20s; watchdog 25s = detektor mutasi (tanpa fix
  // fetch gantung ±301s). Lihat komentar P1-a di atas utk rincian angka.
  const hang = (await netLogs()).filter((l) => String(l.url).includes("hang.png") && l.startedAt >= t0).pop()
  assert.ok(hang, `network log wajib punya entri fetch hang.png gagal, dapat: ${JSON.stringify((await netLogs()).slice(-3))}`)
  assert.equal(hang.status, 0, "fetch hang.png = error (timeout), bukan sukses")
  assert.ok(hang.timing >= 9900 && hang.timing <= 14000,
    `timeout aset wajib mematikan fetch hang.png ±10000ms, dapat ${hang.timing}ms`)
  assert.ok(ms < 20000, `respons ${ms}ms — wajib < 20000ms (timeout aset 10000ms + margin; terukur maks 15361ms)`)
  assert.ok(!r.watchdog, "screenshot MASIH MENGANTUNG ≥25s — fetch gambar tanpa timeout (P1 reproduksi)")
  assert.equal(r.ok, true, r.ok ? "" : `screenshot seharusnya SUKSES lanjut tanpa gambar, dapat: ${r.e.message}`)
  const raw = Buffer.from(r.v.content[0].data, "base64")
  assert.deepEqual(raw.subarray(0, 8), PNG_MAGIC, "PNG tetap valid walau gambar gagal")
  const meta = JSON.parse(r.v.content[1].text)
  assert.equal(meta.images, 0, "tidak ada gambar ter-decode (semua gagal)")
  assert.ok(Array.isArray(meta.notes) && meta.notes.length > 0, `wajib ada notes kegagalan aset, dapat: ${JSON.stringify(meta.notes)}`)
  assert.ok(meta.notes.some((n) => /gambar gagal dimuat/.test(n) && /hang\.png/.test(n)),
    `notes wajib menyebut gambar gagal + hang.png, dapat: ${JSON.stringify(meta.notes)}`)
  assert.equal(gate.released, false, "gate TIDAK pernah dilepas selama assertion")
})

test("P1-kontrol: aset merespons normal → sukses TANPA note gagal (css cascade + gambar ter-decode)", async () => {
  const nav = await raced(outcome(navigate.handler({ url: `${base}/ok/`, timeoutMs: 30000 })), 45000)
  assert.ok(!nav.watchdog, "navigate fixture HTML lokal menggantung ≥45s (server fixture rusak?)")
  assert.equal(nav.ok, true, nav.ok ? "" : `navigate fixture gagal: ${nav.e.message}`)
  const tTree = await raced(outcome(shot.handler({ format: "tree" })), 30000)
  assert.ok(!tTree.watchdog, "screenshot tree menggantung walau aset normal")
  assert.equal(tTree.ok, true, tTree.ok ? "" : tTree.e.message)
  const metaTree = JSON.parse(tTree.v.content[0].text)
  assert.ok(!metaTree.notes || metaTree.notes.length === 0,
    `aset normal TIDAK boleh menghasilkan note gagal, dapat: ${JSON.stringify(metaTree.notes)}`)
  assert.equal(metaTree.css, "cascade", "stylesheet ter-inject → mode cascade")

  const tPng = await raced(outcome(shot.handler({ format: "png", width: 320, height: 240 })), 30000)
  assert.ok(!tPng.watchdog, "screenshot png menggantung walau aset normal")
  assert.equal(tPng.ok, true, tPng.ok ? "" : tPng.e.message)
  const raw = Buffer.from(tPng.v.content[0].data, "base64")
  assert.deepEqual(raw.subarray(0, 8), PNG_MAGIC, "PNG valid")
  const metaPng = JSON.parse(tPng.v.content[1].text)
  assert.ok(!metaPng.notes || metaPng.notes.length === 0,
    `aset normal TIDAK boleh menghasilkan note gagal, dapat: ${JSON.stringify(metaPng.notes)}`)
  assert.equal(metaPng.images, 1, "gambar normal ter-decode (1)")
  assert.ok(metaPng.file && fs.existsSync(metaPng.file), "file PNG ada")
  fs.rmSync(metaPng.file, { force: true })
})

// P2-3 critic R5: stylesheet di-fetch SEKUENSIAL → batas 10s berlaku PER LINK
// (3 link = 30247ms terukur, tanpa batas N). Fix = Promise.all di
// ensureStyles (src/engine-js.js) — injeksi <style> tetap urut dokumen.
test("P2-3: 3 stylesheet menggantung → di-fetch PARALEL (start serentak), total ±1x timeout aset", async () => {
  const nav = await raced(outcome(navigate.handler({ url: `${base}/css3-hang/`, timeoutMs: 30000 })), 45000)
  assert.ok(!nav.watchdog, "navigate fixture HTML lokal menggantung ≥45s (server fixture rusak?)")
  assert.equal(nav.ok, true, nav.ok ? "" : `navigate fixture gagal: ${nav.e.message}`)
  const t1 = Date.now()
  const r = await raced(outcome(shot.handler({ format: "tree" })), 25000)
  const ms = Date.now() - t1
  assert.ok(!r.watchdog, `screenshot 3-css gantung ≥25s (sekuensial/regresi? dapat ${ms}ms)`)
  assert.equal(r.ok, true, r.ok ? "" : `screenshot seharusnya sukses tanpa css, dapat: ${r.e.message}`)
  const meta = JSON.parse(r.v.content[0].text)
  assert.ok(Array.isArray(meta.notes) && meta.notes.length >= 3,
    `wajib 3 notes kegagalan (satu per link), dapat: ${JSON.stringify(meta.notes)}`)

  const logs = await netLogs()
  const hang = logs.filter((l) => /hang\d*\.css/.test(String(l.url)) && l.startedAt >= t1)
  assert.equal(hang.length, 3,
    `wajib 3 entri fetch stylesheet gagal, dapat ${hang.length}: ${JSON.stringify(logs.slice(-5))}`)
  // BUKTI PARALEL (kebal kontensi CPU): ketiga fetch MULAI SERENTAK.
  // Sekuensial (regresi) = spread ±20.000ms + total ±30.000ms → watchdog 25s menagih.
  const starts = hang.map((l) => l.startedAt)
  const spread = Math.max(...starts) - Math.min(...starts)
  assert.ok(spread < 1500, `fetch 3 stylesheet wajib SERENTAK (spread <1500ms), dapat ${spread}ms → sekuensial`)
  for (const l of hang) {
    assert.ok(l.timing >= 9900 && l.timing <= 14000,
      `tiap link punya timeout ±10s sendiri, dapat ${l.timing}ms untuk ${l.url}`)
  }
})

// P2-4 critic R5: `stop` HANYA membaca page._inflight navigate → mustahil
// membatalkan screenshot (stop → {"stopped":false,"note":"tidak ada inflight"},
// screenshot lanjut 32176ms menahan antrean serial). Fix = screenshot punya
// AbortController sendiri (page._shotCtl + _inflight kind:'shot').
test("P2-4: stop SAAT screenshot menggantung stylesheet → screenshot BATAL cepat + jujur", async () => {
  const nav = await raced(outcome(navigate.handler({ url: `${base}/css-stop/`, timeoutMs: 30000 })), 45000)
  assert.ok(!nav.watchdog, "navigate fixture HTML lokal menggantung ≥45s")
  assert.equal(nav.ok, true, nav.ok ? "" : nav.e.message)

  // Belum ada apa-apa berjalan → stop jujur (regresi jangan sampai berubah).
  const before = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(before.stopped, false)
  assert.match(before.note, /tidak ada inflight/)

  const t0 = Date.now()
  const shotP = raced(outcome(shot.handler({ format: "tree" })), 25000)
  await new Promise((r) => setTimeout(r, 800)) // screenshot PASTI di tengah fetch aset (gate tak pernah merespons)
  const s = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(s.stopped, true, `stop wajib membatalkan screenshot, dapat: ${JSON.stringify(s)}`)
  assert.equal(s.kind, "shot", "stop melapor jenis inflight = shot")

  const r = await shotP
  const total = Date.now() - t0
  assert.ok(!r.watchdog, "screenshot tetap jalan ≥25s walau stop (P2-4 reproduksi)")
  assert.equal(r.ok, false, `screenshot wajib DIBATALKAN, bukan sukses lanjut (dapat ok=${r.ok} setelah ${total}ms)`)
  assert.match(r.e.message, /dibatalkan oleh stop/, `pesan batal harus jujur, dapat: ${r.e.message}`)
  assert.ok(total < 8000, `batal jauh < timeout aset ${ASSET_TIMEOUT_MS}ms, dapat ${total}ms`)

  // State inflight bersih sesudah screenshot batal → stop berikutnya jujur lagi.
  const again = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(again.stopped, false)
  assert.match(again.note, /tidak ada inflight/)
})
