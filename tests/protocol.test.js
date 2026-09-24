// mcp-web — unit test protokol JSON-RPC/MCP.
import { test } from "node:test"
import assert from "node:assert/strict"
import { McpServer, processLine, parseMessage, ERR, McpError } from "../src/protocol.js"

const tools = [
  { name: "hello", description: "test", inputSchema: { type: "object" }, async handler({ name = "dunia" }) { return { content: [{ type: "text", text: `halo ${name}` }] } } },
  { name: "boom", description: "error test", inputSchema: { type: "object" }, async handler() { throw new Error("meledak") } },
]
const server = new McpServer({ name: "t", version: "0.0.0", tools })

test("parseMessage: JSON valid", () => {
  const { msg } = parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}')
  assert.equal(msg.method, "ping")
})

test("parseMessage: JSON invalid", () => {
  const r = parseMessage("{not json")
  assert.equal(r.error, ERR.PARSE)
})

test("parseMessage: bukan jsonrpc 2.0", () => {
  assert.equal(parseMessage('{"id":1}').error, ERR.INVALID_REQUEST)
})

test("initialize → serverInfo + capabilities", async () => {
  const out = await processLine(server, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
  assert.equal(out.length, 1)
  assert.equal(out[0].result.serverInfo.name, "t")
  assert.equal(typeof out[0].result.capabilities.tools, "object")
})

test("tools/list → daftar tools", async () => {
  const out = await processLine(server, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
  assert.equal(out[0].result.tools.length, 2)
  assert.equal(out[0].result.tools[0].name, "hello")
})

test("tools/call → hasil handler", async () => {
  const out = await processLine(server, '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hello","arguments":{"name":"Nemo"}}}')
  assert.equal(out[0].result.content[0].text, "halo Nemo")
  assert.equal(out[0].result.isError, false)
})

test("tools/call error → isError + pesan, bukan throw", async () => {
  const out = await processLine(server, '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"boom","arguments":{}}}')
  assert.equal(out[0].error.code, ERR.TOOL_EXECUTION_FAILED)
  assert.match(out[0].error.message, /meledak/)
})

test("method tidak dikenal → -32601", async () => {
  const out = await processLine(server, '{"jsonrpc":"2.0","id":5,"method":"halo/dunia"}')
  assert.equal(out[0].error.code, ERR.METHOD_NOT_FOUND)
})

test("panggilan tanpa id (notifikasi) → tidak dibalas", async () => {
  const out = await processLine(server, '{"jsonrpc":"2.0","method":"notifications/initialized"}')
  assert.equal(out.length, 0)
})

test("McpError memegang code", () => {
  const e = new McpError(-32002, "x")
  assert.equal(e.code, -32002)
  assert.equal(e.message, "x")
})

test("SERVER_INFO.version === package.json version (satu sumber kebenaran)", async () => {
  const { readFileSync } = await import("node:fs")
  const { SERVER_INFO } = await import("../src/protocol.js")
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(SERVER_INFO.version, pkg.version)
})