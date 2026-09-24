// WebDrive MCP — transport HTTP + SSE (mode remote — bisa dipakai dari
// perangkat lain, murni Node http, tanpa dependensi eksternal).
// KEAMANAN: default hanya bind 127.0.0.1; SEMUA request wajib token
// (Authorization: Bearer / ?token=); CORS hanya echo origin localhost/whitelist.
import http from "http"
import crypto from "crypto"
import { McpServer, processLine, ERR, SERVER_INFO } from "./protocol.js"
import { createTools } from "./tools.js"

const MAX_BODY = 1024 * 1024 // 1 MB — batas body POST /message → 413
const SESSION_TTL_MS = 30 * 60 * 1000 // idle > 30 menit → session dibuang
const SESSION_SWEEP_MS = 60_000 // interval sapu TTL (unref — tak menahan proses)

// Origin yang diizinkan CORS: hanya localhost/loopback (default).
const LOCAL_ORIGINS_HOST = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"])

function isAllowedOrigin(origin) {
  if (typeof origin !== "string" || !origin) return false
  let u
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false
  if (LOCAL_ORIGINS_HOST.has(u.hostname)) return true
  const extra = process.env.MCWEB_ALLOWED_ORIGINS // whitelist tambahan, comma-separated, exact match
  if (extra) {
    for (const o of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (origin === o) return true
    }
  }
  return false
}

// CORS per-request: ACAO hanya muncul kalau origin SAH (di-echo persis) — tanpa "*".
function corsHeaders(req) {
  const origin = req?.headers?.origin
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, MCP-Session-Id",
    Vary: "Origin",
  }
  if (isAllowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin
  return h
}

// Banding token tanpa timing leak (hash dulu → panjang tetap).
function tokenMatches(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest()
  const hb = crypto.createHash("sha256").update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function isAuthorized(req, url, token) {
  const auth = req.headers["authorization"]
  if (typeof auth === "string" && auth.startsWith("Bearer ") && tokenMatches(auth.slice(7).trim(), token)) return true
  const q = url.searchParams.get("token")
  if (q && tokenMatches(q, token)) return true
  return false
}

export async function runHttp({ port = 3827, host = "127.0.0.1", engine = "dom" } = {}) {
  const token = process.env.MCWEB_TOKEN || crypto.randomBytes(24).toString("hex")
  // INVARIANT (dokumen repo docs/AUDIT-2026-09-23.md:70 + plugin browser-mcp):
  // "satu page singleton → satu queue". Antrean di bawah DIANTRIKAN PER SESSION
  // (serial per klien) → SETIAP session WAJIB punya McpServer + page SENDIRI.
  // Satu createTools() global untuk semua session (fix R5): state bleed senyap
  // (klien B membaca halaman klien A) + `stop` klien B membatalkan navigasi
  // klien A. Server per session dibuat LAZY (dipakai saat pesan pertama) dan
  // ikut dibuang oleh sweeper TTL → page/cookies/log antar klien terisolasi.
  const makeServer = async () =>
    new McpServer({ name: SERVER_INFO.name, version: SERVER_INFO.version, tools: await createTools({ engine }) })
  const sessions = new Map() // sessionId -> { res (SSE|null), queue, pending, lastSeen, serverPromise }
  // queue per session: tools/call stateful (navigate → query dst) — wajib serial.

  const sendEvent = (session, event) => {
    const res = session.res
    if (!res || res.destroyed || res.writableEnded) return // stream mati → buang, jangan lempar
    try {
      res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`)
    } catch {}
  }

  const handleJsonRpc = async (sessionId, body) => {
    const session = sessions.get(sessionId)
    if (!session) throw Object.assign(new Error("Session tidak dikenal"), { code: -32001 })
    // McpServer + page PER SESSION (queue juga per session → invariant 1 page : 1 queue).
    // Dibuat sekali per session; kalau pembuatan gagal, lempar dulu baru buka
    // peluang retry berikutnya (jangan mengunci session pada promise yang reject).
    let server
    if (!session.serverPromise) session.serverPromise = makeServer()
    try {
      server = await session.serverPromise
    } catch (e) {
      session.serverPromise = null
      throw e
    }
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
      // Preflight tetap dijawab — TANPA ACAO "*" (hanya origin sah yang di-echo).
      res.writeHead(204, corsHeaders(req))
      res.end()
      return
    }

    // --- SEMUA endpoint wajib token (SSE, POST, health) ---
    if (!isAuthorized(req, url, token)) {
      res.writeHead(401, { ...corsHeaders(req), "Content-Type": "application/json", "WWW-Authenticate": "Bearer" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }

    // --- GET /sse — buka stream SSE; session id dari header WAJIB dikenal
    if (req.method === "GET" && url.pathname === "/sse") {
      const requested = req.headers["mcp-session-id"]
      let sessionId
      let session
      if (requested) {
        session = sessions.get(requested)
        if (!session) {
          // Jangan pernah bikin/kembali pakai id asli klien → anti session hijack.
          res.writeHead(400, { ...corsHeaders(req), "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "session tidak dikenal" }))
          return
        }
        if (session.res && !session.res.destroyed && !session.res.writableEnded) {
          // Stream lama masih hidup → JANGAN ditimpa (hijack korban).
          res.writeHead(409, { ...corsHeaders(req), "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "session sudah punya stream aktif" }))
          return
        }
        if (session.res) {
          // Stream lama sudah mati → tutup dulu sebelum mengganti.
          try {
            session.res.destroy()
          } catch {}
          session.res = null
        }
        sessionId = requested
      } else {
        sessionId = crypto.randomUUID() // id kuat, bukan Math.random
        session = { res: null, queue: Promise.resolve(), pending: new Set(), lastSeen: Date.now() }
        sessions.set(sessionId, session)
      }
      session.res = res
      session.lastSeen = Date.now()
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "MCP-Protocol-Version": "2025-03-26",
        "MCP-Session-Id": sessionId,
        ...corsHeaders(req),
      })
      res.write(`event: endpoint\ndata: ${JSON.stringify({ uri: `/message?sessionId=${encodeURIComponent(sessionId)}` })}\n\n`)
      res.on("close", () => {
        // Stream putus → tandai; session bertahan dulu untuk reconnect (sampai TTL).
        if (session.res === res) session.res = null
      })
      return
    }

    // --- POST /message — JSON-RPC dari client
    if (req.method === "POST" && url.pathname.startsWith("/message")) {
      const sessionId = url.searchParams.get("sessionId") || req.headers["mcp-session-id"]

      // Batas body 1 MB — dari Content-Length MAUPUN akumulasi byte (chunked).
      const declared = Number(req.headers["content-length"] || 0)
      let body = ""
      let overflow = false
      const rejectTooLarge = () => {
        if (overflow) return
        overflow = true
        body = ""
        res.writeHead(413, { ...corsHeaders(req), "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: `body terlalu besar (maks ${MAX_BODY} byte)` }))
        req.resume() // buang sisa upload, jangan menumpuk di memori
      }
      if (Number.isFinite(declared) && declared > MAX_BODY) rejectTooLarge()

      req.on("data", (c) => {
        if (overflow) return
        body += c
        if (Buffer.byteLength(body) > MAX_BODY) rejectTooLarge()
      })
      req.on("end", () => {
        if (overflow) return
        const session = sessions.get(sessionId)
        if (!session) {
          res.writeHead(400, { ...corsHeaders(req), "Content-Type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session tidak dikenal" } }))
          return
        }
        session.lastSeen = Date.now()
        // Serial per session — antri di belakang pekerjaan sebelumnya.
        // Guard: kalau queue bukan Promise (sesi lama dari versi lama), buat ulang.
        let q = session.queue
        if (!q || typeof q.then !== "function") q = Promise.resolve()
        if (!session.pending || typeof session.pending.add !== "function") session.pending = new Set()

        // Parse sekali → deteksi jalur prioritas `stop` + rec antrian (P2-1).
        let meta = null
        try { meta = JSON.parse(body) } catch {}
        // Jalur prioritas `stop` (tool name PERSIS): stop hanya baca/clear
        // state + AbortController → dieksekusi LANGSUNG tanpa menunggu
        // antrean. Tanpa ini, navigate lambat mematikan stop (selalu
        // {stopped:false}) — stop jadi tak pernah bisa membatalkan apa pun.
        const isStop = meta?.method === "tools/call" && meta?.params?.name === "stop"
        // rec utk tools/call non-stop: job yang masih antre saat stop datang
        // dibatalkan sebelum jalan (P2-1), dibalas via SSE dgn id asli.
        const rec = meta?.method === "tools/call" && !isStop
          ? { cancelled: false, id: meta?.id }
          : null
        if (rec) session.pending.add(rec)
        // Snapshot saat stop DITERIMA — hanya antrian terkumpul saat itu yang
        // jadi kandidat; request yang masuk sesudah stop tak ikut kena.
        const cancelCandidates = isStop ? [...session.pending] : null

        const run = async () => {
          if (rec) {
            session.pending.delete(rec)
            if (rec.cancelled) {
              // stop datang saat job masih ANTRE (belum mulai) → jangan
              // jalankan; balas jujur lewat SSE (id request asli) + POST tetap 202.
              if (rec.id !== undefined) {
                sendEvent(session, {
                  jsonrpc: "2.0",
                  id: rec.id,
                  error: { code: ERR.TOOL_EXECUTION_FAILED, message: "dibatalkan oleh stop (job batal sebelum mulai — stop diterima saat masih antre)" },
                })
              }
              if (!res.headersSent) {
                res.writeHead(202, { ...corsHeaders(req), "MCP-Protocol-Version": "2025-03-26" })
                res.end()
              }
              return
            }
          }
          try {
            await handleJsonRpc(sessionId, body)
            if (!res.headersSent) {
              res.writeHead(202, { ...corsHeaders(req), "MCP-Protocol-Version": "2025-03-26" })
              res.end()
            }
          } catch (e) {
            const code = typeof e.code === "number" ? e.code : ERR.INTERNAL
            // Stack → log server; klien hanya dapat pesan singkat.
            console.error(`[mcp-web] /message error: ${e.stack || e.message}`)
            if (!res.headersSent) {
              res.writeHead(400, { ...corsHeaders(req), "Content-Type": "application/json" })
              res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message: String(e.message).split("\n")[0] } }))
            } else if (!res.writableEnded) {
              res.end()
            }
          }
        }

        // .catch → request ITU yang dapat 500, tapi chain queue tetap resolved
        // (tanpa ini, satu rejection permanen mematikan seluruh session).
        const recover = (e) => {
          console.error(`[mcp-web] queue error: ${e?.stack || e}`)
          try {
            if (!res.headersSent) {
              res.writeHead(500, { ...corsHeaders(req), "Content-Type": "application/json" })
              res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: ERR.INTERNAL, message: "internal error" } }))
            } else if (!res.writableEnded) {
              res.end()
            }
          } catch {}
        }

        if (isStop) {
          // stop berjalan SEKARANG (microtask berikutnya — navigate dari
          // request sebelumnya SELALU mulai dulu utk set _inflight, tapi stop
          // tak menunggu fetch-nya); rantai disambung → request berikutnya
          // menunggu stop selesai (state tetap serial untuk sisanya).
          const p = Promise.resolve().then(() => {
            // Kandidat yang MASIH antre saat stop mulai → batal sebelum jalan;
            // yang sudah mulai (inflight) biar dihentikan stop handler (P2-1).
            for (const r of cancelCandidates) if (session.pending.has(r)) r.cancelled = true
            return run()
          }).catch(recover)
          session.queue = q.then(() => p).catch(recover)
        } else {
          session.queue = q.then(run).catch(recover)
        }
      })
      return
    }

    // --- GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { ...corsHeaders(req), "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, sessions: sessions.size, pid: process.pid }))
      return
    }

    res.writeHead(404, corsHeaders(req))
    res.end("not found")
  })

  // TTL: buang session idle > 30 menit + tutup stream lamanya.
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - (s.lastSeen || 0) > SESSION_TTL_MS) {
        if (s.res && !s.res.destroyed) {
          try {
            s.res.destroy()
          } catch {}
        }
        sessions.delete(id)
      }
    }
  }, SESSION_SWEEP_MS)
  sweeper.unref() // tak menahan proses tetap hidup

  await new Promise((resolve, reject) => {
    srv.once("error", reject)
    srv.listen(port, host, resolve)
  })
  // git-guard-ok: banner startup server remote (URL/token/SSE/health) untuk pengguna — bukan debug
  console.log(`[mcp-web] remote siap → http://${host}:${port}`)
  console.log(`[mcp-web] token: ${token}  (Authorization: Bearer ${token} — atau ?token=)`)
  console.log(`[mcp-web] SSE:  http://localhost:${port}/sse`)
  console.log(`[mcp-web] health: http://localhost:${port}/health`)

  // Guard: satu request error tidak boleh mematikan server diam-diam.
  process.on("uncaughtException", (e) => {
    console.error(`[mcp-web] uncaughtException (server tetap hidup): ${e.stack || e.message}`)
  })
  process.on("unhandledRejection", (e) => {
    console.error(`[mcp-web] unhandledRejection (server tetap hidup): ${e?.stack || e?.message || e}`)
  })
}
