// mcp-web — P1-1 critic: tool `stop` MATI di transport (queue serial mematikan
// stop → selalu {stopped:false}). Test lewat impl queue YANG SAMA PERSIS:
// stdio e2e (spawn bin, JSON-RPC nyata) + jalur handler langsung utk pesan error.
// (a) stop SELESAI sebelum navigate lambat berakhir → {stopped:true}
// (b) navigate yang di-stop → pesan "dibatalkan oleh stop" (bukan "Timeout")
// (c) stop tanpa inflight → {stopped:false, "tidak ada inflight"}
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import readline from "node:readline"
import { startFixtureServer } from "./helpers.js"
import { createTools } from "../src/tools.js"

// Fixture test ada di 127.0.0.1 → izinkan target private (anak proses mewarisi env).
process.env.MCWEB_ALLOW_PRIVATE = "1"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bin = path.join(root, "bin", "mcp-web.js")

const SLOW_MS = 3000 // fixture /slow menahan response selama ini
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fx
let child
let rl
let nextId = 40000

before(async () => {
  fx = await startFixtureServer()
  child = spawn("node", [bin, "stdio"], { stdio: ["pipe", "pipe", "inherit"] })
  rl = readline.createInterface({ input: child.stdout })
})

after(async () => {
  child.kill()
  await fx.close()
})

function rpc(method, params) {
  const id = nextId++
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })
  return new Promise((resolve) => {
    const onLine = (line) => {
      let m
      try { m = JSON.parse(line) } catch { return }
      if (m.id === id) {
        rl.off("line", onLine)
        resolve(m)
      }
    }
    rl.on("line", onLine)
    child.stdin.write(msg + "\n")
  })
}

const call = (name, args = {}) => rpc("tools/call", { name, arguments: args })

test("P1-1a: stdio — navigate lambat lalu stop → stop SELESAI duluan, {stopped:true}", async () => {
  await rpc("ping") // sinkron dulu: child sudah boot & siap proses line (anti flaky)
  const t0 = Date.now()
  const navP = call("navigate", { url: `${fx.base}/slow?ms=${SLOW_MS}` })
  await sleep(200) // beri waktu navigate inflight (fetch jalan)
  const stopMsg = await call("stop") // HARUS tak menunggu navigate (jalur prioritas)
  const stopMs = Date.now() - t0
  const sp = JSON.parse(stopMsg.result.content[0].text)
  assert.equal(sp.stopped, true, `stop wajib {stopped:true}, dapat: ${JSON.stringify(sp)}`)
  assert.ok(sp.inflight && sp.inflight.url.includes("/slow"), "inflight = navigate lambat")
  // Dengan queue lama stop baru jalan SETELAH navigate (~3000ms) → gagal di sini.
  assert.ok(stopMs < SLOW_MS / 2, `stop harus jauh < ${SLOW_MS}ms (dapat ${stopMs}ms)`)
  const navMsg = await navP
  assert.ok(navMsg.error, "navigate yang di-stop wajib error")
  assert.match(navMsg.error.message, /dibatalkan oleh stop/)
  assert.ok(!/Timeout setelah/.test(navMsg.error.message), "bukan pesan timeout saat kena stop")
})

test("P1-1b: navigate yang di-stop melempar 'dibatalkan oleh stop'; timeout asli tetap 'Timeout'", async () => {
  const tools = await createTools()
  const navigate = tools.find((t) => t.name === "navigate")
  const stop = tools.find((t) => t.name === "stop")
  // pasang handler AWAL → rejection tak berakhir sebagai unhandled
  const navOutcome = navigate.handler({ url: `${fx.base}/slow?ms=${SLOW_MS}` }).then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e }),
  )
  await sleep(200)
  const st = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(st.stopped, true)
  const out = await navOutcome
  assert.equal(out.ok, false, "navigate harus gagal setelah stop")
  assert.match(out.e.message, /dibatalkan oleh stop/)
  // regresi: abort karena TIMEOUT tetap memakai pesan Timeout lama
  await assert.rejects(
    navigate.handler({ url: `${fx.base}/slow?ms=2000`, timeoutMs: 50 }),
    /Timeout setelah 50ms/,
  )
})

test("P1-1c: stop tanpa inflight → {stopped:false, 'tidak ada inflight'} (tetap jujur)", async () => {
  const tools = await createTools()
  const stop = tools.find((t) => t.name === "stop")
  const p = JSON.parse((await stop.handler({})).content[0].text)
  assert.equal(p.stopped, false)
  assert.equal(p.note, "tidak ada inflight")
  // jalur stdio e2e pun sama
  const m = await call("stop")
  const sp = JSON.parse(m.result.content[0].text)
  assert.equal(sp.stopped, false)
  assert.equal(sp.note, "tidak ada inflight")
})
