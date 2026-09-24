// mcp-web — P3-7 critic R5: PNG screenshot MENUMPUK di tmpdir tanpa
// pembersihan — probe kritikus: 30 file baru untuk 30 screenshot (run kedua
// 54 → 84 kumulatif) + RSS 136,1MB → 212,1MB.
// Fix diuji di sini: rotasi SHOT_KEEP (8) file terbaru PER PROSES (file tertua
// dihapus saat menulis berikutnya) + sapu sekali file `mcpweb-shot-*` sisa run
// lama (umur > 1 jam) di tmpdir.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createTools } from "../src/tools.js"
import { startFixtureServer, parseJson } from "./helpers.js"

process.env.MCWEB_ALLOW_PRIVATE = "1" // fixture = 127.0.0.1 (pola file test lain)

let fx
let tools

before(async () => {
  fx = await startFixtureServer()
  tools = await createTools({ engine: "dom" })
  const nav = await tools.find((t) => t.name === "navigate").handler({ url: fx.base + "/" })
  assert.ok(nav.content, `navigate fixture gagal: ${JSON.stringify(nav)}`)
})

after(async () => { await fx.close() })

test("P3-7: PNG screenshot dirotasi (maks 8 file/proses) + file sisa run lama tersapu", async () => {
  const dir = os.tmpdir()
  const prefix = `mcpweb-shot-${process.pid}-`

  // File sisa run LAMA (pid lain, umur 2 jam) → wajib disapu saat shot pertama.
  const stale = path.join(dir, `mcpweb-shot-999999-stale-${process.pid}.png`)
  fs.writeFileSync(stale, Buffer.from("stale"))
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000)
  fs.utimesSync(stale, twoHoursAgo, twoHoursAgo)

  const shot = tools.find((t) => t.name === "screenshot")
  const files = []
  for (let i = 0; i < 12; i++) {
    const r = await shot.handler({ format: "png", width: 64, height: 64 })
    assert.equal(r.isError, false, `shot ke-${i + 1} gagal: ${JSON.stringify(r.content ?? r.error ?? null).slice(0, 200)}`)
    files.push(parseJson(r.content[1].text).file)
  }

  const mine = fs.readdirSync(dir).filter((f) => f.startsWith(prefix))
  assert.ok(mine.length <= 8, `file PNG per proses wajib ≤8 (SHOT_KEEP), dapat ${mine.length}: ${mine.join(", ")}`)
  assert.ok(mine.length >= 1, "file TERBARU tetap ada untuk dibuka user")
  assert.ok(fs.existsSync(files[files.length - 1]), "file terakhir yang dilaporkan ke klien masih ada")
  assert.ok(!fs.existsSync(files[0]), "file paling awal sudah dirotasi (dihapus) — tanpa ini 12 file menumpuk")
  assert.ok(!fs.existsSync(stale), "file sisa run lama (>1 jam) ikut tersapu")

  // Bersihkan file test ini (rotasi sudah terbukti di atas).
  for (const f of files) fs.rmSync(f, { force: true })
  fs.rmSync(stale, { force: true })
})
