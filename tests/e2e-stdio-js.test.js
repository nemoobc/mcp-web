// mcp-web — e2e stdio --js: handshake MCP nyata dengan engine JS penuh.
// Ini jalur config opencode "mcp.web" (command: [... mcp-web.js, stdio, --js]).
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

let fx
let child
let rl
let nextId = 9000

before(async () => {
  fx = await startFixtureServer()
  child = spawn("node", [bin, "stdio", "--js"], { stdio: ["pipe", "pipe", "inherit"] })
  rl = readline.createInterface({ input: child.stdout })
})

after(() => {
  child.kill()
  return fx.close?.()
})

function rpc(method, params) {
  const id = nextId++
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      let m
      try { m = JSON.parse(line) } catch { return }
      if (m.id === id) {
        rl.off("line", onLine)
        resolve(m)
      }
    }
    const onExit = (code) => { rl.off("line", onLine); reject(new Error(`child exit ${code}`)) }
    rl.on("line", onLine)
    child.once("exit", onExit)
    child.stdin.write(msg + "\n")
    child.once("drain", () => child.off("exit", onExit))
  })
}

async function call(name, args = {}) {
  return rpc("tools/call", { name, arguments: args })
}

test("e2e stdio --js: initialize + tools/list (js_eval + 14 tool)", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } })
  assert.equal(init.result.serverInfo.name, "mcp-web")
  const list = await rpc("tools/list")
  const names = list.result.tools.map((t) => t.name)
  assert.ok(names.length >= 14)
  assert.ok(names.includes("js_eval"))
})

test("e2e stdio --js: js_eval penuh lewat stdio (sessionStorage live)", async () => {
  const n = await call("navigate", { url: `${fx.base}/` })
  assert.equal(JSON.parse(n.result.content[0].text).title, "Home")
  const m = await call("js_eval", {
    code: `sessionStorage.setItem("stdio", "1"); return JSON.stringify({ ss: sessionStorage.getItem("stdio"), gcs: typeof getComputedStyle })`,
  })
  const p = JSON.parse(m.result.content[0].text)
  assert.equal(p.engine, "js")
  const t = JSON.parse(p.result)
  assert.equal(t.ss, "1")
  assert.equal(t.gcs, "function")
})
