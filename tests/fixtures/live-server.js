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

export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url.split("?")[0]
      const map = {
        "/": [200, "text/html", INDEX],
        "/index.html": [200, "text/html", INDEX],
        "/classic.js": [200, "application/javascript", CLASSIC],
        "/app.js": [200, "application/javascript", APP],
        "/ui.js": [200, "application/javascript", UI],
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