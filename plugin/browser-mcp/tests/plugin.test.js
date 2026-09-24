// plugin/browser-mcp — test registrasi & eksekusi 54 tool namespace `browser`
// (45 surface dotted identik builtin + 9 tool eksisting).
// Pola repo: node --test tests/*.test.js (dari dir plugin/browser-mcp).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

// Navigasi fixture 127.0.0.1 → izinkan target private HANYA di proses test ini.
process.env.MCWEB_ALLOW_PRIVATE = "1"

// 45 nama builtin opencode.browser (urut spesifikasi) — sumber kebenaran test.
const BUILTIN_45 = [
  "tabs.list", "tabs.open", "tabs.focus", "tabs.close", "preview", "navigate",
  "back", "forward", "reload", "stop", "frames", "snapshot", "find", "evaluate",
  "click", "hover", "drag", "fill", "fill_form", "select", "check", "press",
  "scroll", "wait", "screenshot", "dialog", "files.upload", "files.drop",
  "files.list", "files.get", "console", "network.list", "network.get",
  "trace.start", "trace.stop", "trace.analyze", "cpu.start", "cpu.stop",
  "cpu.analyze", "heap.snapshot", "heap.summary", "heap.query", "heap.object",
  "heap.compare", "lighthouse",
]
// 9 tool eksisting — didaftarkan nama apa adanya di namespace "browser".
const LEGACY_9 = [
  "submit", "get_content", "query", "js_eval", "console_get", "network_logs",
  "cookies", "history", "reset",
]
// Ekspektasi registrasi HARUS literal (bukan hasil fungsi mapping yang sama
// dengan plugin — itu tautologi, test-nya jadi tidak menguji apa pun).
const EXPECTED = [
  ["browser.tabs", "list"], ["browser.tabs", "open"], ["browser.tabs", "focus"], ["browser.tabs", "close"],
  ["browser", "preview"], ["browser", "navigate"], ["browser", "back"], ["browser", "forward"],
  ["browser", "reload"], ["browser", "stop"], ["browser", "frames"], ["browser", "snapshot"],
  ["browser", "find"], ["browser", "evaluate"], ["browser", "click"], ["browser", "hover"],
  ["browser", "drag"], ["browser", "fill"], ["browser", "fill_form"], ["browser", "select"],
  ["browser", "check"], ["browser", "press"], ["browser", "scroll"], ["browser", "wait"],
  ["browser", "screenshot"], ["browser", "dialog"],
  ["browser.files", "upload"], ["browser.files", "drop"], ["browser.files", "list"], ["browser.files", "get"],
  ["browser", "console"],
  ["browser.network", "list"], ["browser.network", "get"],
  ["browser.trace", "start"], ["browser.trace", "stop"], ["browser.trace", "analyze"],
  ["browser.cpu", "start"], ["browser.cpu", "stop"], ["browser.cpu", "analyze"],
  ["browser.heap", "snapshot"], ["browser.heap", "summary"], ["browser.heap", "query"],
  ["browser.heap", "object"], ["browser.heap", "compare"],
  ["browser", "lighthouse"],
  // 9 eksisting (flat, namespace browser)
  ["browser", "submit"], ["browser", "get_content"], ["browser", "query"], ["browser", "js_eval"],
  ["browser", "console_get"], ["browser", "network_logs"], ["browser", "cookies"],
  ["browser", "history"], ["browser", "reset"],
]
const EXPECTED_DOTTED_45 = EXPECTED.slice(0, 45).map(([ns, name]) => (ns === "browser" ? name : `${ns.slice("browser.".length)}.${name}`))

const FIXTURE_TITLE = "Fixture Home"
const FIXTURE_TEXT = "TEKS_FIXTURE_UNIK"

let plugin
let fx
let captured = []

// Mock ctx minimal: cukup untuk setup() → tool.transform → editor.add.
const mockCtx = {
  options: {},
  tool: {
    transform(fn) {
      fn({ add(def) { captured.push(def) } })
    },
  },
}

function startFixture() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const html =
        `<!doctype html><html><head><title>${FIXTURE_TITLE}</title></head>` +
        `<body><h1>${FIXTURE_TITLE}</h1><p>${FIXTURE_TEXT}</p></body></html>`
      const u = new URL(req.url, "http://localhost")
      if (u.pathname === "/slow") {
        // Route LAMBAT (ms=...) utk test prioritas `stop` — unref: timer tak
        // menahan proses test selesai.
        const delay = Math.min(Math.max(Number(u.searchParams.get("ms") || 1500), 1), 10000)
        const t = setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          res.end(html)
        }, delay)
        if (typeof t.unref === "function") t.unref()
        return
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

function toolDef(name) {
  const def = captured.find((t) => t.name === name)
  assert.ok(def, `tool ${name} tidak terdaftar`)
  return def
}

// Definisi by registrasi penuh (nama unik hanya gabungan namespace+name —
// "list"/"get" muncul di beberapa namespace).
function regDef(namespace, name) {
  const def = captured.find((t) => t.name === name && t.options?.namespace === namespace)
  assert.ok(def, `tool ${namespace}.${name} tidak terdaftar`)
  return def
}

before(async () => {
  const mod = await import("../index.js")
  plugin = mod.default
  fx = await startFixture()
})

after(async () => { await fx.close() })

test("import index.js sukses — id & setup Plugin.define", () => {
  assert.equal(plugin.id, "mcpweb.browser")
  assert.equal(typeof plugin.setup, "function")
})

test("setup → editor.add menangkap 54 tool, semuanya di bawah namespace browser", async () => {
  await plugin.setup(mockCtx)
  assert.equal(captured.length, 54)
  const got = captured.map((t) => [t.options?.namespace, t.name])
  assert.deepEqual(got.slice().sort(), EXPECTED.slice().sort(), "daftar (namespace,name) tidak sesuai spesifikasi")
  for (const t of captured) {
    assert.ok(String(t.options?.namespace).startsWith("browser"), `${t.name}: namespace di luar browser`)
    assert.equal(t.options?.permission, "browser", `${t.name}: permission bukan browser`)
    assert.equal(t.options?.codemode, false, `${t.name}: codemode harus false (tool NATIF)`)
    assert.equal(typeof t.execute, "function", `${t.name}: execute bukan function`)
    assert.ok(t.description, `${t.name}: description kosong`)
    assert.equal(t.input?.type, "object", `${t.name}: input bukan JSON Schema object`)
  }
})

test("45 tool dotted → identik daftar builtin opencode.browser (urut pun sama)", () => {
  assert.equal(EXPECTED_DOTTED_45.length, 45)
  assert.deepEqual(EXPECTED_DOTTED_45, BUILTIN_45)
  // 9 eksisting tetap tampil flat apa adanya
  for (const legacy of LEGACY_9) {
    assert.ok(captured.some((t) => t.options?.namespace === "browser" && t.name === legacy), `tool eksisting ${legacy} hilang`)
  }
})

test("execute navigate → buka fixture lokal, hasil berisi judul", async () => {
  const out = await toolDef("navigate").execute({ url: `${fx.base}/` })
  assert.ok(Array.isArray(out.content), "content bukan array")
  assert.equal(out.content[0].type, "text")
  const text = out.content.map((c) => c.text).join("\n")
  assert.match(text, new RegExp(FIXTURE_TITLE))
  assert.match(text, /"status": ?200/)
  assert.ok(!("isError" in out), "Tool.Result OpenCode tidak punya isError")
})

test("execute get_content → berisi teks fixture", async () => {
  const out = await toolDef("get_content").execute({ format: "text" })
  assert.ok(Array.isArray(out.content))
  assert.match(out.content[0].text, new RegExp(FIXTURE_TEXT))
})

test("reset → tool butuh halaman melempar error jelas (tidak crash)", async () => {
  const resetOut = await toolDef("reset").execute({})
  assert.ok(Array.isArray(resetOut.content))
  await assert.rejects(
    () => toolDef("get_content").execute({}),
    (err) => {
      assert.ok(err instanceof Error, "error bukan instance Error")
      assert.match(err.message, /Belum ada halaman/)
      assert.ok(!/\n\s+at /.test(err.message), "pesan error membawa stack penuh")
      return true
    },
  )
})

test("anti-race: Promise.all(navigate, get_content) → hasil konsisten dengan halaman fixture", async () => {
  // State KOSONG (test reset sebelumnya). Tanpa antrian serial, get_content
  // jalan saat navigate masih fetch → "Belum ada halaman"/kosong SENYAP.
  // Dengan queue: navigate selesai dulu → get_content baca halaman fixture utuh.
  const [nav, content] = await Promise.all([
    toolDef("navigate").execute({ url: `${fx.base}/` }),
    toolDef("get_content").execute({ format: "text" }),
  ])
  assert.ok(Array.isArray(nav.content) && nav.content.length > 0, "navigate gagal")
  assert.ok(Array.isArray(content.content), "get_content bukan array (race: error/kosong)")
  const text = content.content.map((c) => c.text).join("\n")
  assert.ok(!/Belum ada halaman/.test(text), "get_content membaca sebelum navigate selesai = RACE")
  assert.match(text, new RegExp(FIXTURE_TEXT), "isi get_content tidak konsisten dengan halaman fixture")
})

test("tool dotted (browser.tabs.list) execute → menampilkan tab aktif hasil navigate", async () => {
  const out = await regDef("browser.tabs", "list").execute({})
  const text = out.content.map((c) => c.text).join("\n")
  assert.match(text, /"count": ?1/)
  assert.match(text, /"active": ?"tab-1/)
})

test("tool engine-impossible (browser.heap.snapshot) → reject dengan pesan Chromium, bukan hasil palsu", async () => {
  await assert.rejects(
    () => regDef("browser.heap", "snapshot").execute({}),
    (err) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /butuh desktop browser\/Chromium — engine js\/dom tidak mendukung/)
      assert.ok(!/\n\s+at /.test(err.message), "pesan error membawa stack penuh")
      return true
    },
  )
})

test("ALLOWED_ENGINES tetap [dom] — engine js ditolak dengan pesan jelas", async () => {
  const badCtx = { options: { engine: "js" }, tool: { transform(fn) { fn({ add() {} }) } } }
  await assert.rejects(() => plugin.setup(badCtx), (err) => {
    assert.match(err.message, /belum didukung plugin browser-mcp/)
    assert.match(err.message, /"dom"/)
    return true
  })
})

// P1-1 (critic): queue module-global MEMATIKAN `stop` — stop antre di belakang
// navigate → selalu {stopped:false}. Fix: tool `stop` jalan LANGSUNG (prioritas).
test("P1-1 plugin: stop prioritas — SELESAI sebelum navigate lambat, {stopped:true}", async () => {
  const SLOW_MS = 3000
  const navOutcome = toolDef("navigate")
    .execute({ url: `${fx.base}/slow?ms=${SLOW_MS}` })
    .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
  await new Promise((r) => setTimeout(r, 200)) // navigate sudah inflight
  const t0 = Date.now()
  const stopOut = await toolDef("stop").execute({}) // tak boleh menunggu antrean
  const stopMs = Date.now() - t0
  const sp = JSON.parse(stopOut.content[0].text)
  assert.equal(sp.stopped, true, `stop wajib {stopped:true}, dapat: ${JSON.stringify(sp)}`)
  assert.ok(stopMs < SLOW_MS / 2, `stop harus jauh < ${SLOW_MS}ms (dapat ${stopMs}ms) — queue mematikan stop`)
  const out = await navOutcome
  assert.equal(out.ok, false, "navigate yang di-stop wajib error")
  assert.match(out.e.message, /dibatalkan oleh stop/)
})

// P2-1 (critic R2): stop TIDAK membatalkan navigate yang SUDAH ANTRE — job yang
// dikirim SEBELUM stop tapi belum mulai tetap jalan & sukses sesudah stop.
// Fix plugin/index.js: rec per execute + snapshot saat stop dipanggil → job
// antrean yang belum mulai di-reject "dibatalkan oleh stop"; yang sudah jalan
// (wait) tidak ikut kena; yang datang sesudah stop di luar cakupan.
test("P2-1 plugin: batch wait + navigate antri + stop → navigate antri DIBATALKAN, wait berjalan tetap jalan", async () => {
  const waitP = toolDef("wait").execute({ ms: 1500 }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
  await new Promise((r) => setTimeout(r, 100)) // wait SUDAH mulai (job berjalan)
  const navP = toolDef("navigate").execute({ url: `${fx.base}/slow?ms=2500` }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
  await new Promise((r) => setTimeout(r, 50)) // navigate sudah ter-antre (belum mulai)
  const t0 = Date.now()
  const stopOut = await toolDef("stop").execute({}) // prioritas: tak menunggu antrean
  const stopMs = Date.now() - t0
  const sp = JSON.parse(stopOut.content[0].text)
  assert.equal(sp.stopped, false, `stop jujur {stopped:false} (tak ada inflight — navigate masih antre): ${JSON.stringify(sp)}`)
  assert.match(sp.note, /tidak ada inflight/)
  assert.ok(stopMs < 500, `stop harus cepat (<500ms), dapat ${stopMs}ms`)
  const w = await waitP
  assert.equal(w.ok, true, `wait yang SUDAH berjalan tidak boleh dibatalkan: ${w.e?.message}`)
  const nav = await navP
  assert.equal(nav.ok, false, `navigate antre wajib ditolak, dapat sukses: ${nav.ok ? "SUKSES" : ""}`)
  assert.match(nav.e.message, /dibatalkan oleh stop/)
})

// P2-2 (critic R2): pesan error argumen asing pada ALIAS harus menyebut nama
// tool yang DIPANGGIL ('evaluate'), bukan nama asli handler ('js_eval').
test("P2-2 plugin: evaluate({bogus:1}) → pesan menyebut 'evaluate' (bukan 'js_eval')", async () => {
  await assert.rejects(
    () => toolDef("evaluate").execute({ bogus: 1 }),
    (err) => {
      assert.match(err.message, /argumen 'bogus'/)
      assert.match(err.message, /tool 'evaluate'/)
      assert.ok(!/tool 'js_eval'/.test(err.message), `pesan jangan menyebut tool 'js_eval': ${err.message}`)
      return true
    },
  )
})
