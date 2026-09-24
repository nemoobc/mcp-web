// Fixture: server HTTP lokal untuk test engine JS (jsdom + module import).
// Halaman simulasi SPA: classic script + ES module + tombol buka modal.
import http from "http"

const INDEX = `<!DOCTYPE html><html><head><title>Seed</title></head><body>
  <script src="/classic.js"></script>
  <script type="module" src="/app.js"></script>
  <button id="btn">Buka</button>
  <div id="modal" class="modal" style="display:none"></div>
  <input id="name" name="name" />
</body></html>`

const CLASSIC = `document.title = "Classic OK"; window.__classicRan = (window.__classicRan||0)+1; document.getElementById("modal").dataset.classic = "yes";`

const APP = `import { openModal } from './ui.js';
window.__moduleRan = (window.__moduleRan||0)+1;
document.getElementById('btn').addEventListener('click', openModal);
window.__appReady = true;`

const UI = `export function openModal() {
  const m = document.getElementById('modal');
  m.style.display = 'block';
  m.classList.add('open');
  m.textContent = 'MODAL TERBUKA';
}
export function helper() { return 42; }`

// Subdir module (reproduksi kasus situs dgn struktur /js/... — prefix mirror)
const DEEP_INDEX = `<!DOCTYPE html><html><head><title>Deep</title></head><body>
  <script type="module" src="/deep/app.js"></script>
</body></html>`
const DEEP_APP = `import { childReady } from './child.js';
window.__deepReady = childReady();`
const DEEP_CHILD = `export function childReady() { return 'DEEP_OK'; }`

// Halaman ber-CSS eksternal (stylesheet terpisah) — uji cascade screenshot:
// warna box HARUS datang dari file .css luar (bukan inline).
const STYLED = `<!DOCTYPE html><html><head><title>Styled</title>
  <link rel="stylesheet" href="/style.css">
</head><body><div class="redbox">Merah dari stylesheet</div></body></html>`
const STYLED_CSS = `.redbox { background-color: #ff0000; height: 80px; color: #ffffff; }`

// Halaman dgn <img> nyata (fetch → decode → drawImage) — 4x4 PNG merah.
const IMG_PAGE = `<!DOCTYPE html><html><head><title>Img</title></head><body style="margin:0">
  <div style="height:10px;background:#eeeeee"></div>
  <img id="shot" src="/tiny.png" width="40" height="40" alt="">
</body></html>`

let tinyPngCache = null
async function getTinyPng() {
  if (tinyPngCache) return tinyPngCache
  const PImage = await import("pureimage")
  const { PassThrough } = await import("node:stream")
  const img = PImage.make(4, 4)
  const c = img.getContext("2d")
  c.fillStyle = "rgb(255, 0, 0)"
  c.fillRect(0, 0, 4, 4)
  const chunks = []
  const stream = new PassThrough()
  stream.on("data", (d) => chunks.push(d))
  const ended = new Promise((res, rej) => { stream.on("end", res); stream.on("error", rej) })
  await PImage.encodePNGToStream(img, stream)
  await ended
  tinyPngCache = Buffer.concat(chunks)
  return tinyPngCache
}

export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url.split("?")[0]
      if (u === "/tiny.png") {
        getTinyPng().then((buf) => {
          res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buf.length })
          res.end(buf)
        }).catch(() => { res.writeHead(500); res.end() })
        return
      }
      const map = {
        "/": [200, "text/html", INDEX],
        "/index.html": [200, "text/html", INDEX],
        "/classic.js": [200, "application/javascript", CLASSIC],
        "/app.js": [200, "application/javascript", APP],
        "/ui.js": [200, "application/javascript", UI],
        "/deep/": [200, "text/html", DEEP_INDEX],
        "/deep/app.js": [200, "application/javascript", DEEP_APP],
        "/deep/child.js": [200, "application/javascript", DEEP_CHILD],
        "/styled/": [200, "text/html", STYLED],
        "/style.css": [200, "text/css", STYLED_CSS],
        "/imgtest/": [200, "text/html", IMG_PAGE],
      }
      const hit = map[u]
      if (hit) {
        res.writeHead(hit[0], { "Content-Type": hit[1] })
        res.end(hit[2])
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("not found: " + u)
      }
    })
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })
    })
  })
}