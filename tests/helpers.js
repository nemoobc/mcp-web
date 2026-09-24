// mcp-web test helpers — fixture HTTP server lokal (offline, deterministik).
import http from "http"

export const PAGES = {
  "/": `<!doctype html><html><head><title>Home</title></head><body>
<a href="/page2">Go to page 2</a>
<form id="search" method="GET" action="/page2"><input name="q" value="hello"><input type="checkbox" name="ok" checked><button type="submit">Send</button></form>
<input id="email" name="email"><button id="b">Noop</button>
</body></html>`,
  "/page2": `<!doctype html><html><head><title>Page Two</title></head><body>
<p>Result page</p><a href="/page3">next</a>
</body></html>`,
  "/page3": `<!doctype html><html><head><title>Page Three</title></head><body><h1>Final</h1></body></html>`,
  "/api/hello": `{"hello":"world"}`,
  "/with-script": `<!doctype html><html><head><title>Script Page</title><script src="/classic.js"></script></head><body><p>ok</p></body></html>`,
  "/classic.js": `window.__classicLoaded = 1;`,
  // Halaman kaya utk tool baru: select, checkbox/radio, form multi-field,
  // area drag & drop, list panjang, input file, iframe.
  "/rich": `<!doctype html><html><head><title>Rich</title></head><body>
<div id="box">
<h1>Judul Rich</h1>
<p class="lead">paragraf teks unik richpage di sini</p>
<select id="kop"><option value="a">Alpha</option><option value="b">Beta</option></select>
<input type="checkbox" id="cb" name="cb">
<input type="radio" name="r" id="r1" value="1"><input type="radio" name="r" id="r2" value="2">
<form id="multi" action="/page2" method="GET"><input id="f1" name="f1"><input id="f2" name="f2"><textarea id="f3" name="f3"></textarea><button type="submit">Go</button></form>
<div id="src">drag-source</div><div id="dropzone">drop-area</div>
<ul id="scroller"><li>item satu</li><li>item dua</li></ul>
<input type="file" id="up" name="up">
<iframe id="fr" src="/page3" title="frame-3"></iframe>
</div></body></html>`,
}

export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://localhost")
      if (u.pathname === "/slow") {
        // Halaman LAMBAT (ms=...) utk test prioritas `stop`: navigate menggantung,
        // stop wajib tetap bisa membatalkan. unref → timer tak menahan proses test.
        const delay = Math.min(Math.max(Number(u.searchParams.get("ms") || 1500), 1), 10000)
        const t = setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/html" })
          res.end(PAGES["/"])
        }, delay)
        if (typeof t.unref === "function") t.unref()
        return
      }
      if (u.pathname === "/redir") {
        res.writeHead(302, { Location: "/page2" })
        res.end()
        return
      }
      if (u.pathname === "/cookie") {
        res.writeHead(200, { "Set-Cookie": "session=abc123; Path=/", "Content-Type": "text/html" })
        res.end(PAGES["/"])
        return
      }
      const body = PAGES[u.pathname]
      if (body !== undefined) {
        res.writeHead(200, { "Content-Type": u.pathname.startsWith("/api") ? "application/json" : "text/html" })
        res.end(body)
      } else {
        res.writeHead(404, { "Content-Type": "text/html" })
        res.end("<h1>Not Found</h1>")
      }
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({ port, base: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

// Ambil teks dari MCP result content.
export function resultText(result) {
  const c = result?.content || []
  return c[0]?.text ?? ""
}

export function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}