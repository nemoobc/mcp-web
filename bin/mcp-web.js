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
  mcp-web serve --port 3827  mode remote (HTTP + SSE — dari perangkat lain)
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
  runHttp({ port, engine })
} else {
  runStdio({ engine })
}