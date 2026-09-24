// browser-mcp — plugin OpenCode v2: mendaftarkan 54 tool mcp-web
// ke namespace `browser` (builtin opencode.browser dimatikan via config).
// Surface identik builtin: nama dotted per-tool via options.namespace —
// tabs_list → {name:"list", namespace:"browser.tabs"}, single-word → namespace "browser".
//
// State halaman mcp-web sengaja SINGLETON: createTools() dipanggil sekali
// di setup — page stateful, membuat instance per-execute = sesi hilang tiap tool call.
import { Plugin } from "@opencode/plugin"

const PLUGIN_ID = "mcpweb.browser"
const TOOL_NAMESPACE = "browser"
const TOOL_PERMISSION = "browser"
const DEFAULT_ENGINE = "dom"
// Pembatas defensif: engine=js TIDAK terbukti di runtime Bun opencode → tolak
// dengan pesan jelas, jangan diam-diam jalankan lalu gagal aneh di runtime.
const ALLOWED_ENGINES = ["dom"]

// 21 nama flat yang punya padanan dotted builtin (prefix {tabs, files, network,
// trace, cpu, heap}). Sisanya (single-word, fill_form, dan 9 tool eksisting
// termasuk network_logs) didaftarkan nama apa adanya di namespace "browser" —
// mapping prefix DIPAKAI eksplisit di sini (bukan tebak prefix), supaya
// network_logs eksisting TIDAK ikut-ikutan jadi "network.logs".
const DOTTED_FLAT = new Set([
  "tabs_list", "tabs_open", "tabs_focus", "tabs_close",
  "files_upload", "files_drop", "files_list", "files_get",
  "network_list", "network_get",
  "trace_start", "trace_stop", "trace_analyze",
  "cpu_start", "cpu_stop", "cpu_analyze",
  "heap_snapshot", "heap_summary", "heap_query", "heap_object", "heap_compare",
])

// flat → registrasi plugin: {name, namespace} menampilkan dotted identik builtin.
function pluginRegistration(flatName) {
  if (DOTTED_FLAT.has(flatName)) {
    const i = flatName.indexOf("_")
    const prefix = flatName.slice(0, i)
    const rest = flatName.slice(i + 1)
    return { name: rest, namespace: `${TOOL_NAMESPACE}.${prefix}` }
  }
  return { name: flatName, namespace: TOOL_NAMESPACE }
}

// Singleton tools per process. Disimpan di closure module agar setup() boleh
// dipanggil ulang (mis. test) tanpa menggandakan state page.
let sharedTools = null

// Antrian serial PER-INSTANCE: satu page singleton → SATU queue di closure
// module ini. Semua execute menari di rantai ini supaya tak pernah parallel
// di atas state bersama (Promise.all(navigate, get_content) = baca halaman
// setengah-jadi senyap). Pola sama dengan src/http.js:222-234 (queue per session).
let queue = Promise.resolve()

// Job tools yang sudah ter-antre tapi BELUM mulai dieksekusi — dibatalkan
// saat tool `stop` dieksekusi (P2-1 critic: navigate antri TIDAK boleh jalan
// sesudah stop). Snapshot dibuat saat stop MULAI → job sesudah stop tak ikut
// kena (pola sama src/stdio.js & src/http.js).
const pending = new Set()

async function loadTools(engine) {
  if (sharedTools) return sharedTools
  // Path relatif module ini: plugin/browser-mcp/ → mcp-web/src/tools.js
  const { createTools } = await import("../../src/tools.js")
  // createTools ASYNC (fixer: jsdom dynamic import) → await WAJIB, kalau tidak
  // tools = Promise → for...of di setup melempar "Promise is not iterable".
  sharedTools = await createTools({ engine })
  return sharedTools
}

function resolveEngine(raw) {
  const engine = raw ?? DEFAULT_ENGINE
  if (!ALLOWED_ENGINES.includes(engine)) {
    throw new Error(
      `engine ${JSON.stringify(String(engine))} belum didukung plugin browser-mcp (hanya "${ALLOWED_ENGINES.join(", ")}")`,
    )
  }
  return engine
}

// Bungkus handler mcp-web: McpError → error bersih, pesan saja tanpa stack lokal penuh.
// Return DIKURANGI ke Tool.Result SDK: {content?: string | Content[]} — tanpa isError
// (lihat @opencode/schema/tool: Result; isError MCP bukan bagian dari Result OpenCode).
function wrapExecute(tool) {
  return (args) => {
    const rec = tool.name === "stop" ? null : { cancelled: false }
    if (rec) pending.add(rec)
    const run = async () => {
      if (rec) {
        pending.delete(rec)
        if (rec.cancelled) {
          // stop datang saat job masih ANTRE (belum mulai) → jangan jalankan;
          // tolak dengan pesan jujur (di luar try → TANPA prefix tool.name).
          throw new Error("dibatalkan oleh stop (job batal sebelum mulai — stop diterima saat masih antre)")
        }
      }
      try {
        // Argumen ke-2 = nama tool dipanggil → pesan error argumen asing
        // memakai nama ASLI (alias evaluate/console/network_list), bukan nama
        // tool pertama pemilik handler. (pola sama src/protocol.js callTool)
        const out = await tool.handler(args ?? {}, tool.name)
        return { content: out.content ?? [{ type: "text", text: String(out) }] }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = typeof err?.code === "number" ? ` [code ${err.code}]` : ""
        throw new Error(`${tool.name}: ${message}${code}`, { cause: err })
      }
    }
    // Jalur prioritas `stop` (nama persis): stop hanya baca/clear state +
    // AbortController → dieksekusi LANGSUNG tanpa menunggu antrean. Tanpa ini,
    // navigate lambat mengantre di depan stop → stop selalu {stopped:false}
    // dan tak pernah bisa membatalkan navigate (pola sama src/stdio.js & src/http.js).
    if (tool.name === "stop") {
      // Snapshot saat stop DIPANGGIL: hanya job yang sudah terkumpul saat itu
      // yang jadi kandidat batal — execute sesudah stop tak ikut kena (P2-1).
      const cancelCandidates = [...pending]
      // Microtask berikutnya: navigate dari execute SEBELUMNYA (sudah ter-antre)
      // mulai dulu → _inflight terisi, tapi stop TIDAK menunggu fetch lambatnya.
      const p = Promise.resolve().then(() => {
        // Kandidat yang MASIH antre (belum `run`) → batal sebelum jalan; yang
        // sudah mulai (inflight) biar dihentikan stop handler (AbortController).
        for (const r of cancelCandidates) if (pending.has(r)) r.cancelled = true
        return run()
      })
      // Rantai tetap disambung → execute BERIKUTNYA menunggu stop selesai.
      queue = queue.then(() => p).catch(() => {})
      return p
    }
    // Serial: job berikut menunggu job selesai (rantai queue = queue.then(job)).
    const job = queue.then(run)
    // Catch PEMULIH: rantai queue tetap resolved walau job ini gagal —
    // tanpa ini, satu rejection permanen memacet seluruh antrian.
    queue = job.catch(() => {})
    return job
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    if (typeof ctx?.tool?.transform !== "function") {
      throw new Error("ctx.tool.transform tidak tersedia — runtime OpenCode v2 tidak sesuai")
    }
    const engine = resolveEngine(ctx.options?.engine)
    const tools = await loadTools(engine)
    // Transform mengembalikan Promise<Registration> (dist/promise/registration.d.ts) → await.
    await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        // Nama dotted identik builtin: tabs_list → name "list" di namespace
        // "browser.tabs" (options.namespace per-tool, pola yang didukung
        // ToolEditor). Sisanya name apa adanya di namespace "browser".
        const reg = pluginRegistration(tool.name)
        editor.add({
          name: reg.name,
          description: tool.description,
          input: tool.inputSchema,
          options: {
            namespace: reg.namespace,
            permission: TOOL_PERMISSION,
            // codemode: false = daftar sebagai tool NATIF (direct call bersih
            // ala builtin browser), BUKAN cuma catalog Code Mode (execute+console.log).
            codemode: false,
          },
          execute: wrapExecute(tool),
        })
      }
    })
  },
})
