#!/usr/bin/env node
// WebDrive MCP — bin entry.
import { runStdio } from "../src/stdio.js"
import { runHttp } from "../src/http.js"

const [,, cmd, ...rest] = process.argv
const engine = rest.includes("--js") || rest.includes("--jsdom") || process.env.MCPWEB_JS === "1" ? "js" : "dom"
const help = `mcp-web — MCP server web automation untuk Termux
pakai:
  mcp-web stdio              mode lokal (default MCP stdio, buat opencode)
  mcp-web stdio --js         mode lokal + engine JS hidup (jsdom: SPA/JS penuh,
                             tanpa Chromium/adb; butuh situs tepercaya)
  mcp-web serve --port 3827  mode remote (HTTP + SSE — default bind 127.0.0.1;
                             semua request wajib token, dicetak di log saat start;
                             token bisa di-set via env MCWEB_TOKEN)
  mcp-web serve --port 3827 --host 0.0.0.0   bind ke semua interface (hati-hati:
                             hanya untuk jaringan tepercaya, token tetap wajib)
  mcp-web serve --port 3827 --js   remote + engine JS hidup
  mcp-web --help             bantuan ini
`

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(help)
  process.exit(0)
}

if (cmd === "serve") {
  const portIdx = rest.indexOf("--port")
  const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : 3827
  const hostIdx = rest.indexOf("--host")
  const host = hostIdx >= 0 ? rest[hostIdx + 1] : undefined // undefined → default 127.0.0.1
  await runHttp({ port, host, engine })
} else {
  await runStdio({ engine })
}
