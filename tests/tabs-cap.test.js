// mcp-web — P2-4 critic: tabs tanpa batas (60× tabs_open → count 61).
// Cap MAX_TABS=16 → error jujur "tab penuh (maks 16) — tutup dulu"; tutup satu
// tab → bisa buka lagi (cap bukan permanen).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { McpServer, processLine } from "../src/protocol.js"
import { createTools } from "../src/tools.js"
import { startFixtureServer, resultText, parseJson } from "./helpers.js"

// Fixture test ada di 127.0.0.1 → izinkan target private HANYA di proses test ini.
process.env.MCWEB_ALLOW_PRIVATE = "1"

let fx
let server
let nextId = 30000

before(async () => {
  fx = await startFixtureServer()
  server = new McpServer({ name: "mcp-web", version: "test", tools: await createTools() })
})

after(async () => { await fx.close() })

async function call(name, args = {}) {
  const out = await processLine(server, JSON.stringify({
    jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args },
  }))
  return out[0]
}

test("P2-4: tabs_open dibatasi MAX_TABS=16 → error 'tab penuh (maks 16) — tutup dulu'", async () => {
  await call("reset")
  await call("navigate", { url: `${fx.base}/` }) // tab pertama (tab-1)
  let opened = 0
  let capped = null
  for (let i = 0; i < 25; i++) {
    const m = await call("tabs_open", { url: `${fx.base}/page2` })
    if (m.error) { capped = m; break }
    opened++
  }
  assert.ok(capped, "harus mentok di cap (25 percobaan tak muat semua)")
  assert.match(capped.error.message, /tab penuh \(maks 16\) — tutup dulu/)
  assert.equal(opened, 15, "15 buka sukses + tab awal = 16 tab penuh")
  const l = await call("tabs_list")
  const lp = parseJson(resultText(l.result))
  assert.equal(lp.count, 16, "count mentok di 16, bukan 61")
  // cap bukan permanen: tutup satu → bisa buka lagi
  const c = await call("tabs_close", { id: "tab-1" })
  assert.ok(!c.error, `tabs_close gagal: ${c.error?.message}`)
  const again = await call("tabs_open", { url: `${fx.base}/page3` })
  assert.ok(!again.error, `setelah tutup, tabs_open harus bisa lagi: ${again.error?.message}`)
  const l2 = await call("tabs_list")
  assert.equal(parseJson(resultText(l2.result)).count, 16)
})
