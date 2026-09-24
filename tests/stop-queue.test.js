// mcp-web — P2-1 critic R2: `stop` TIDAK membatalkan navigate yang SUDAH
// ANTRE (belum mulai). Probe critic: satu tulisan stdin [wait 1500ms,
// navigate /slow 2500ms, stop] → stop balas cepat {stopped:false} (jujur ✓)
// tapi navigate yang dikirim SEBELUM stop tetap jalan & sukses SESUDAH stop.
//
// Fix (src/stdio.js): rec per job tools/call + snapshot kandidat saat baris
// stop diterima → saat stop MULAI, kandidat yang MASIH antre dibatalkan
// (balasan error "dibatalkan oleh stop"), yang sudah jalan biar dihentikan
// stop handler (AbortController), yang datang SESUDAH stop tak ikut kena.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import readline from "node:readline"
import { startFixtureServer } from "./helpers.js"

// Fixture test ada di 127.0.0.1 → izinkan target private (anak proses mewarisi env).
process.env.MCWEB_ALLOW_PRIVATE = "1"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bin = path.join(root, "bin", "mcp-web.js")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fx
let child
let rl
let got
let waiters
let arrivals
let t0
let nextId = 50000

before(async () => {
  fx = await startFixtureServer()
  child = spawn("node", [bin, "stdio"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, MCWEB_ALLOW_PRIVATE: "1" } })
  rl = readline.createInterface({ input: child.stdout })
  got = new Map()
  waiters = new Map()
  arrivals = []
  t0 = Date.now()
  rl.on("line", (l) => {
    let m
    try { m = JSON.parse(l) } catch { return }
    arrivals.push({ id: m.id, t: Date.now() - t0 })
    got.set(m.id, m)
    if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id) }
  })
})

after(async () => {
  child.kill()
  await fx.close()
})

const wait = (id, ms = 15000) => new Promise((res, rej) => {
  if (got.has(id)) return res(got.get(id))
  waiters.set(id, res)
  setTimeout(() => rej(new Error(`timeout tunggu id ${id}`)), ms)
})

function line(id, name, args) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
}

const arrivalOf = (id) => arrivals.find((a) => a.id === id)?.t

test("P2-1: satu tulisan [wait 1500, navigate antri, stop] → navigate ANTRI dibatalkan, stop tetap cepat & jujur", async () => {
  const idPing = nextId++ // ping sync dulu: child boot & siap (anti flaky)
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: idPing, method: "ping" }) + "\n")
  await wait(idPing)
  const idWait = nextId++
  const idNav = nextId++
  const idStop = nextId++
  const t0b = Date.now()
  // SATU chunk — urutan mikrotask transport diuji (pola probe critic S2).
  child.stdin.write(
    [line(idWait, "wait", { ms: 1500 }), line(idNav, "navigate", { url: `${fx.base}/slow?ms=2500` }), line(idStop, "stop", {})].join("\n") + "\n",
  )
  const stopM = await wait(idStop, 8000)
  const stopMs = Date.now() - t0b
  const sp = JSON.parse(stopM.result.content[0].text)
  // stop jujur: tak ada yang inflight (wait bukan navigasi; navigate masih antre)
  assert.equal(sp.stopped, false, `stop wajib {stopped:false} jujur, dapat: ${JSON.stringify(sp)}`)
  assert.match(sp.note, /tidak ada inflight/)
  // stop TIDAK menunggu wait 1500ms — prioritas tetap hidup
  assert.ok(stopMs < 1000, `stop harus cepat (<1000ms), dapat ${stopMs}ms`)
  const waitM = await wait(idWait, 8000)
  assert.ok(waitM.result, `wait yang sudah berjalan TIDAK boleh dibatalkan: ${JSON.stringify(waitM.error)}`)
  const navM = await wait(idNav, 10000)
  // INTI FIX: navigate yang dikirim SEBELUM stop, masih ANTRI → TIDAK jalan.
  assert.ok(navM.error, `navigate antre wajib ERROR, dapat sukses: ${navM.result ? JSON.stringify(navM.result).slice(0, 120) : "?"}`)
  assert.match(navM.error.message, /dibatalkan oleh stop/)
  // urutan: stop (prioritas) → wait selesai → navigate antri (dibatalkan)
  assert.ok(arrivalOf(idStop) < arrivalOf(idWait), `stop (${arrivalOf(idStop)}ms) harus sebelum wait (${arrivalOf(idWait)}ms)`)
  assert.ok(arrivalOf(idStop) < arrivalOf(idNav), `stop (${arrivalOf(idStop)}ms) harus sebelum navigate (${arrivalOf(idNav)}ms)`)
})

test("P2-1 regresi: batch [navigate inflight, stop] → navigate TETAP dibatalkan via AbortController (bukan dilewatkan)", async () => {
  const idNav = nextId++
  const idStop = nextId++
  const t0b = Date.now()
  child.stdin.write([line(idNav, "navigate", { url: `${fx.base}/slow?ms=3000` }), line(idStop, "stop", {})].join("\n") + "\n")
  const stopM = await wait(idStop, 8000)
  const stopMs = Date.now() - t0b
  const sp = JSON.parse(stopM.result.content[0].text)
  // navigate dari baris sebelumnya SELALU mulai duluan (microtask) → inflight nyata
  assert.equal(sp.stopped, true, `stop wajib {stopped:true} utk navigate inflight, dapat: ${JSON.stringify(sp)}`)
  assert.ok(sp.inflight && sp.inflight.url.includes("/slow"), `inflight = navigate lambat, dapat: ${JSON.stringify(sp.inflight)}`)
  assert.ok(stopMs < 1500, `stop harus jauh < 3000ms, dapat ${stopMs}ms`)
  const navM = await wait(idNav, 10000)
  assert.ok(navM.error, "navigate yang di-stop wajib error")
  assert.match(navM.error.message, /dibatalkan oleh stop/)
  assert.ok(!/Timeout setelah/.test(navM.error.message), "bukan pesan timeout saat kena stop")
})

test("P2-1 batas: job yang datang SESUDAH stop TIDAK ikut dibatalkan (snapshot saat stop diterima)", async () => {
  const idStop = nextId++
  const idNav = nextId++
  child.stdin.write([line(idStop, "stop", {}), line(idNav, "navigate", { url: `${fx.base}/` })].join("\n") + "\n")
  const stopM = await wait(idStop, 8000)
  const sp = JSON.parse(stopM.result.content[0].text)
  assert.equal(sp.stopped, false)
  assert.match(sp.note, /tidak ada inflight/)
  const navM = await wait(idNav, 10000)
  // navigate datang SETELAH stop → di luar cakupan pembatalan; tetap jalan normal.
  assert.ok(!navM.error, `navigate sesudah stop tidak boleh kena batal, dapat: ${navM.error ? navM.error.message : "ok"}`)
  assert.equal(JSON.parse(navM.result.content[0].text).title, "Home")
})
