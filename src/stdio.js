// WebDrive MCP — transport stdio (untuk opencode lokal di Termux).
import readline from "readline"
import { McpServer, processLine } from "./protocol.js"
import { createTools } from "./tools.js"

export function runStdio() {
  const server = new McpServer({
    name: "mcp-web",
    version: "1.1.0",
    tools: createTools(),
  })

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  // Antrian serial: tools/call bersifat stateful (navigate → query dst), jadi
  // setiap line WAJIB selesai diproses sebelum line berikutnya — kalau tidak,
  // query bisa jalan sebelum navigate selesai (race).
  let queue = Promise.resolve()
  rl.on("line", (line) => {
    if (!line.trim()) return
    queue = queue.then(async () => {
      try {
        const out = await processLine(server, line)
        for (const m of out) process.stdout.write(JSON.stringify(m) + "\n")
      } catch (e) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e.message } }) + "\n")
      }
    })
  })

  process.stdin.on("end", () => {})
  process.stdout.on("error", () => process.exit(0))
}