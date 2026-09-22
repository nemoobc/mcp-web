// WebDrive MCP — transport HTTP + SSE (mode remote — bisa dipakai dari
// perangkat lain, murni Node http, tanpa dependensi eksternal).
import http from "http"
import { McpServer, processLine, notif, ERR } from "./protocol.js"
import { createTools } from "./tools.js"

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, MCP-Session-Id",
  }
}

export function runHttp({ port = 3827, host = "0.0.0.0" } = {}) {
  const server = new McpServer({ name: "mcp-web", version: "1.1.0", tools: createTools() })
  const sessions = new Map() // sessionId -> { res (SSE), queue }
  // queue per session: tools/call stateful (navigate → query dst) — wajib serial.

  const sendEvent = (session, event) => {
    const data = JSON.stringify(event)
    session.res.write(`event: message\ndata: ${data}\n\n`)
  }

  const handleJsonRpc = async (sessionId, body) => {
    const session = sessions.get(sessionId)
    if (!session) throw Object.assign(new Error("Session tidak dikenal"), { code: -32001 })
    const parsed = JSON.parse(body)
    // Balas lewat SSE stream session
    if (parsed.id !== undefined) {
      const out = await processLineWrapper(server, parsed)
      for (const m of out) sendEvent(session, m)
    } else {
      // Notifikasi: proses, tak perlu balas
      await processLineWrapper(server, parsed)
    }
  }

  const processLineWrapper = async (server, parsed) => {
    const raw = JSON.stringify(parsed)
    const out = await processLine(server, raw)
    return out
  }

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }

    // --- GET /sse — buka stream SSE; dapatkan session id dari header atau buat baru
    if (req.method === "GET" && url.pathname === "/sse") {
      const sessionId = req.headers["mcp-session-id"] || `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "MCP-Protocol-Version": "2025-03-26",
        "MCP-Session-Id": sessionId,
        ...corsHeaders(),
      })
      res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: `/message?sessionId=${encodeURIComponent(sessionId)}` })}\n\n`)
      const session = sessions.get(sessionId) || { res, queue: Promise.resolve() }
      session.res = res
      sessions.set(sessionId, session)
      req.on("close", () => {
        // Jangan langsung hapus — biarkan session bertahan untuk client reconnect (sementara)
        // sessions.delete(sessionId)
      })
      return
    }

    // --- POST /message — JSON-RPC dari client
    if (req.method === "POST" && url.pathname.startsWith("/message")) {
      const sessionId = url.searchParams.get("sessionId") || req.headers["mcp-session-id"]
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        const session = sessions.get(sessionId)
        if (!session) {
          res.writeHead(400, { ...corsHeaders(), "Content-Type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session tidak dikenal" } }))
          return
        }
        // Serial per session — antri di belakang pekerjaan sebelumnya.
        // Guard: kalau queue bukan Promise (sesi lama dari versi lama), buat ulang.
        let q = session.queue
        if (!q || typeof q.then !== "function") q = Promise.resolve()
        session.queue = q.then(async () => {
          try {
            await handleJsonRpc(sessionId, body)
            res.writeHead(202, { ...corsHeaders(), "MCP-Protocol-Version": "2025-03-26" })
            res.end()
          } catch (e) {
            const code = e.code || ERR.INTERNAL
            res.writeHead(400, { ...corsHeaders(), "Content-Type": "application/json" })
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message: e.message } }))
          }
        })
      })
      return
    }

    // --- GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { ...corsHeaders(), "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, sessions: sessions.size, pid: process.pid }))
      return
    }

    res.writeHead(404, corsHeaders())
    res.end("not found")
  })

  srv.listen(port, host, () => {
    console.log(`[mcp-web] remote siap → http://${host}:${port}`)
    console.log(`[mcp-web] SSE:  http://localhost:${port}/sse`)
    console.log(`[mcp-web] health: http://localhost:${port}/health`)
  })

  // Guard: satu request error tidak boleh mematikan server diam-diam.
  process.on("uncaughtException", (e) => {
    console.error(`[mcp-web] uncaughtException (server tetap hidup): ${e.message}`)
  })
  process.on("unhandledRejection", (e) => {
    console.error(`[mcp-web] unhandledRejection (server tetap hidup): ${e?.message || e}`)
  })
}