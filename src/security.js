// WebDrive MCP — guard URL tujuan (SSRF).
// SATU tempat validasi target: dipakai tools (navigate/click/submit) dan
// engine (navigasi awal + tiap hop redirect). Tanpa ini, klien bisa menyuruh
// server mem-fetch target internal (loopback/RFC1918/link-local/metadata).
import { McpError, ERR } from "./protocol.js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// true → target private/lokal diblokir. Bypass: env (fixture test) ATAU
// flag file (opsional lokal — hilangkan file = kembali ketat, tanpa restart).
function privateAllowed() {
  if (process.env.MCWEB_ALLOW_PRIVATE === "1") return true
  try {
    return fs.existsSync(path.join(os.homedir(), ".mcp-web-allow-private"))
  } catch {
    return false
  }
}

function isBlockedIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const octets = m.slice(1, 5).map(Number)
  if (octets.some((n) => n > 255)) return false // bukan IPv4 valid — biarkan fetch yang menolak
  const [a, b, c, d] = octets
  if (a === 127) return true // loopback 127.0.0.0/8
  if (a === 10) return true // RFC1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true // RFC1918 192.168.0.0/16
  if (a === 169 && b === 254) return true // link-local 169.254.0.0/16 (termasuk metadata cloud)
  if (a === 0 && b === 0 && c === 0 && d === 0) return true // 0.0.0.0
  return false
}

function isBlockedIpv6(ip) {
  const v = ip.toLowerCase()
  if (v === "::1" || v === "::") return true // loopback / unspecified
  if (v.startsWith("fc") || v.startsWith("fd")) return true // ULA fc00::/7
  if (/^fe[89ab]/.test(v)) return true // link-local fe80::/10
  return false
}

function isBlockedHost(hostname) {
  let h = String(hostname || "").toLowerCase().replace(/\.$/, "") // buang trailing dot
  if (!h) return true
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (/^\d+$/.test(h)) return true // IP desimal (mis. 2130706433 → 127.0.0.1)
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1) // [::1] dari URL.hostname
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/) // IPv4-mapped IPv6
  if (mapped) return isBlockedIpv4(mapped[1])
  if (h.includes(":")) return isBlockedIpv6(h)
  return isBlockedIpv4(h)
}

/**
 * Validasi URL tujuan. Lembarkan McpError (INVALID_PARAMS) kalau berbahaya.
 * @returns {URL} URL terparse — valid dipakai lagi oleh caller.
 */
export function assertSafeTarget(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw new McpError(ERR.INVALID_PARAMS, `URL tidak valid: ${url}`)
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new McpError(ERR.INVALID_PARAMS, "Hanya http/https yang didukung")
  }
  if (!privateAllowed() && isBlockedHost(u.hostname)) {
    throw new McpError(ERR.INVALID_PARAMS, `URL private/lokal diblokir (SSRF): ${u.hostname}`)
  }
  return u
}
