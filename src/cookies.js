// WebDrive MCP — cookie jar minimal per sesi.
// Hormati Domain/Path/Secure/Expires saat MENYIMPAN dan MENGIRIM.
// Listing difilter per-host halaman current — bukan semua domain (privasi sesi).

function parseSetCookie(raw) {
  if (typeof raw !== "string") return null
  const parts = raw.split(";")
  const eq = parts[0].indexOf("=")
  if (eq < 0) return null
  const name = parts[0].slice(0, eq).trim()
  if (!name) return null
  const rec = {
    value: parts[0].slice(eq + 1).trim(),
    path: "/",
    domain: null, // null → host-only (persis host respons)
    hostOnly: true,
    secure: false,
    expires: null, // epoch ms | null (session cookie)
  }
  let maxAge = null
  for (const a of parts.slice(1)) {
    const s = a.trim()
    const i = s.indexOf("=")
    const k = (i < 0 ? s : s.slice(0, i)).trim().toLowerCase()
    const v = i < 0 ? "" : s.slice(i + 1).trim()
    if (k === "path" && v.startsWith("/")) rec.path = v
    else if (k === "domain" && v) {
      rec.domain = v.replace(/^\./, "").toLowerCase()
      rec.hostOnly = false
    } else if (k === "secure") rec.secure = true
    else if (k === "expires") {
      const t = Date.parse(v)
      if (!Number.isNaN(t)) rec.expires = t
    } else if (k === "max-age") {
      const n = Number(v)
      if (Number.isFinite(n)) maxAge = n
    }
  }
  if (maxAge !== null) rec.expires = Date.now() + maxAge * 1000 // Max-Age menang atas Expires
  return { name, rec }
}

// Cocokkan cookie ke URL: domain (host-only vs Domain attr), path prefix, Secure.
function matches(storedHost, rec, u) {
  const host = u.hostname.toLowerCase()
  if (rec.hostOnly) {
    if (host !== storedHost) return false
  } else if (host !== rec.domain && !host.endsWith("." + rec.domain)) {
    return false
  }
  if (rec.secure && u.protocol !== "https:") return false
  const path = u.pathname || "/"
  return path.startsWith(rec.path) // prefix path (cukup untuk kebutuhan sesi ini)
}

export class CookieJar {
  constructor() {
    this.domains = new Map() // host respons -> Map(name -> rec)
  }

  get size() {
    let n = 0
    for (const store of this.domains.values()) n += store.size
    return n
  }

  // Simpan Set-Cookie (array/string) untuk `url`. Domain attr yang tidak
  // cocok dengan host respons dibuang (anti cookie injection lintas domain).
  add(url, setCookieHeaders) {
    const raws = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : []
    if (raws.length === 0) return
    let u
    try {
      u = new URL(url)
    } catch {
      return
    }
    const host = u.hostname.toLowerCase()
    for (const raw of raws) {
      const parsed = parseSetCookie(raw)
      if (!parsed) continue
      const { name, rec } = parsed
      if (rec.domain && !(host === rec.domain || host.endsWith("." + rec.domain))) continue
      if (rec.expires !== null && rec.expires <= Date.now()) continue // sudah kedaluwarsa saat disimpan
      let store = this.domains.get(host)
      if (!store) {
        store = new Map()
        this.domains.set(host, store)
      }
      store.set(name, rec)
    }
  }

  // Header Cookie untuk `url`: hanya cookie yang lulus domain/path/secure +
  // belum kedaluwarsa (yang kedaluwarsa ikut dibersihkan).
  header(url) {
    let u
    try {
      u = new URL(url)
    } catch {
      return undefined
    }
    const out = []
    for (const [host, store] of this.domains) {
      for (const [name, rec] of [...store]) {
        if (rec.expires !== null && rec.expires <= Date.now()) {
          store.delete(name)
          continue
        }
        if (matches(host, rec, u)) out.push(`${name}=${rec.value}`)
      }
      if (store.size === 0) this.domains.delete(host)
    }
    return out.length ? out.join("; ") : undefined
  }

  // Listing untuk halaman saat ini saja: host yang sama atau induk domainnya.
  listFor(url) {
    let u
    try {
      u = new URL(url)
    } catch {
      return []
    }
    const out = []
    for (const [host, store] of this.domains) {
      for (const [name, rec] of [...store]) {
        if (rec.expires !== null && rec.expires <= Date.now()) {
          store.delete(name)
          continue
        }
        if (matches(host, rec, u)) out.push({ domain: host, name, value: rec.value })
      }
      if (store.size === 0) this.domains.delete(host)
    }
    return out
  }

  clear() {
    this.domains.clear()
  }
}
