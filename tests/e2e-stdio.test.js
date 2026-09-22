// mcp-web — e2e stdio: spawn bin, JSON-RPC round-trip nyata.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import readline from "node:readline"
import { startFixtureServer } from "./helpers.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bin = path.join(root, "bin", "mcp-web.js")

let fx
let child
let rl
let nextId = 1000

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
      const m = JSON.parse(line)
      if (m.id === id) {
        rl.off("line", onLine)
        resolve(m)
      }
    }
    rl.on("line", onLine)
    child.stdin.write(msg + "\n")
  })
}

async function call(name, args = {}) {
  return rpc("tools/call", { name, arguments: args })
}

test("e2e: initialize + tools/list", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } })
  assert.equal(init.result.serverInfo.name, "mcp-web")
  const list = await rpc("tools/list")
  assert.ok(list.result.tools.length >= 14)
})

test("e2e: navigate → query → click → back → submit", async () => {
  const n = await call("navigate", { url: `${fx.base}/` })
  assert.equal(JSON.parse(n.result.content[0].text).title, "Home")

  const q = await call("query", { selector: "a" })
  assert.ok(JSON.parse(q.result.content[0].text).count >= 1)

  const c = await call("click", { selector: "a" })
  assert.equal(JSON.parse(c.result.content[0].text).title, "Page Two")

  const b = await call("history", { action: "back" })
  assert.equal(JSON.parse(b.result.content[0].text).title, "Home")

  const s = await call("submit", { selector: "#search" })
  const sp = JSON.parse(s.result.content[0].text)
  assert.equal(sp.currentUrl, `${fx.base}/page2?q=hello&ok=on`)
})

test("e2e: tools salah nama → error bersih", async () => {
  const m = await call("tidak_ada")
  assert.equal(m.error.code, -32002)
})