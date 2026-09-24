// mcp-web — test guard SSRF (assertSafeTarget) + aturan env bypass.
// Test file INI berproses TERPISAH (node --test per file) → env test lain
// tak mengganggu: MCWEB_ALLOW_PRIVATE dipastikan MATI di sini.
import { test } from "node:test"
import assert from "node:assert/strict"

delete process.env.MCWEB_ALLOW_PRIVATE
const { assertSafeTarget } = await import("../src/security.js")

test("assertSafeTarget: tolak 127.0.0.1 (loopback)", () => {
  assert.throws(() => assertSafeTarget("http://127.0.0.1/"), /SSRF/)
})

test("assertSafeTarget: tolak 169.254.169.254 (metadata cloud)", () => {
  assert.throws(() => assertSafeTarget("http://169.254.169.254/latest/meta-data/"), /SSRF/)
})

test("assertSafeTarget: terima example.com", () => {
  const u = assertSafeTarget("https://example.com/path?q=1")
  assert.equal(u.hostname, "example.com")
})

test("assertSafeTarget: tolak localhost & IP desimal loopback", () => {
  assert.throws(() => assertSafeTarget("http://localhost:8080/"), /SSRF/)
  assert.throws(() => assertSafeTarget("http://2130706433/"), /SSRF/) // 127.0.0.1 dalam IP desimal
})

test("assertSafeTarget: tolak RFC1918 (10/8, 172.16/12, 192.168/16)", () => {
  assert.throws(() => assertSafeTarget("http://10.0.0.1/"), /SSRF/)
  assert.throws(() => assertSafeTarget("http://172.16.0.1/"), /SSRF/)
  assert.throws(() => assertSafeTarget("http://192.168.1.1/"), /SSRF/)
  assert.throws(() => assertSafeTarget("http://[::1]/"), /SSRF/)
})

test("assertSafeTarget: tolak non-http(s)", () => {
  assert.throws(() => assertSafeTarget("file:///etc/passwd"), /Hanya http\/https/)
  assert.throws(() => assertSafeTarget("ftp://example.com/"), /Hanya http\/https/)
})

test("assertSafeTarget: URL rusak → pesan URL tidak valid", () => {
  assert.throws(() => assertSafeTarget("bukan-url"), /URL tidak valid/)
})

test("MCWEB_ALLOW_PRIVATE=1 → loopback diizinkan (khusus fixture lokal)", () => {
  process.env.MCWEB_ALLOW_PRIVATE = "1"
  try {
    const u = assertSafeTarget("http://127.0.0.1:9999/")
    assert.equal(u.hostname, "127.0.0.1")
  } finally {
    delete process.env.MCWEB_ALLOW_PRIVATE
  }
})
