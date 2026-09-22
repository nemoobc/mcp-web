#!/usr/bin/env node
// WebDrive MCP — bin entry.
import { runStdio } from "../src/stdio.js"
import { runHttp } from "../src/http.js"

const [,, cmd, ...rest] = process.argv
const help = `mcp-web — MCP server web automation untuk Termux
pakai:
  mcp-web stdio              mode lokal (default MCP stdio, buat opencode)
  mcp-web serve --port 3827  mode remote (HTTP + SSE — dari perangkat lain)
  mcp-web --help             bantuan ini
`

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(help)
  process.exit(0)
}

if (cmd === "serve") {
  const portIdx = rest.indexOf("--port")
  const port = portIdx >= 0 ? Number(rest[portIdx + 1]) : 3827
  runHttp({ port })
} else {
  runStdio()
}