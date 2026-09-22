// WebDrive MCP — protokol JSON-RPC 2.0 + konvensi MCP (murni, tanpa dependensi).
// Implementasi sendiri: initialize, notifications/initialized, ping,
// tools/list, tools/call, dll. Transport-agnostik: dipakai stdio & HTTP.

export const PROTOCOL_VERSION = "2025-03-26"
export const SERVER_INFO = { name: "mcp-web", version: "1.1.0" }

export class McpError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

// Kode error JSON-RPC / MCP
export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // MCP application errors
  TOOL_NOT_FOUND: -32002,
  TOOL_EXECUTION_FAILED: -32003,
}

export function ok(id, result) {
  return { jsonrpc: "2.0", id, result }
}

export function fail(id, code, message, data) {
  const e = { jsonrpc: "2.0", id, error: { code, message } }
  if (data !== undefined) e.error.data = data
  return e
}

export function notif(method, params = {}) {
  return { jsonrpc: "2.0", method, params }
}

export function parseMessage(raw) {
  if (typeof raw !== "string") return { error: ERR.INVALID_REQUEST, message: "pesan bukan string" }
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return { error: ERR.PARSE, message: "JSON tidak valid" }
  }
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return { error: ERR.INVALID_REQUEST, message: "bukan JSON-RPC 2.0" }
  }
  if (msg.id !== undefined && typeof msg.id !== "string" && typeof msg.id !== "number" && msg.id !== null) {
    return { error: ERR.INVALID_REQUEST, message: "id tidak valid" }
  }
  return { msg }
}

// Kelas inti: daftar tools + eksekusi. Handler adalah async fn(params) → {content, isError?}.
export class McpServer {
  constructor({ tools = [], name, version } = {}) {
    this.tools = new Map(tools.map(t => [t.name, t]))
    this.name = name
    this.version = version
    this.initialized = false
  }

  handle(msg) {
    if (msg.method === "initialize") {
      this.initialized = true
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: this.name, version: this.version },
      }
    }
    if (msg.method === "notifications/initialized") return null
    if (msg.method === "ping") return {}
    if (msg.method === "tools/list") {
      return { tools: [...this.tools.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }
    }
    if (msg.method === "tools/call") {
      return this.callTool(msg.params)
    }
    throw new McpError(ERR.METHOD_NOT_FOUND, `Metode tidak dikenal: ${msg.method}`)
  }

  async callTool({ name, arguments: args = {} } = {}) {
    const tool = this.tools.get(name)
    if (!tool) throw new McpError(ERR.TOOL_NOT_FOUND, `Tools tidak ditemukan: ${name}`)
    try {
      const out = await tool.handler(args)
      return { content: out.content ?? [{ type: "text", text: String(out) }], isError: !!out.isError }
    } catch (e) {
      if (e instanceof McpError) throw e
      throw new McpError(ERR.TOOL_EXECUTION_FAILED, `Gagal eksekusi ${name}: ${e.message}`, { stack: e.stack })
    }
  }
}

// Pipeline: terima raw string → balas (array pesan keluar, atau null utk notifikasi).
export async function processLine(server, raw) {
  const parsed = parseMessage(raw)
  if (parsed.error !== undefined) {
    return [fail(parsed.error === ERR.PARSE ? null : null, parsed.error, parsed.message)]
  }
  const { msg } = parsed
  if (msg.method === undefined) {
    return [fail(msg.id, ERR.INVALID_REQUEST, "tidak ada method")]
  }
  // Notifikasi tanpa id → tidak dibalas
  const isNotif = msg.id === undefined
  try {
    const result = await server.handle(msg)
    if (result === null || isNotif) return []
    return [ok(msg.id, result)]
  } catch (e) {
    if (isNotif) return []
    const code = e instanceof McpError ? e.code : ERR.INTERNAL
    return [fail(msg.id, code, e.message, e.data)]
  }
}