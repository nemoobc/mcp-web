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
}

export function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://localhost")
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