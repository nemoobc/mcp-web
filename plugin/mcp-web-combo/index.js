// mcp-web-combo — plugin OpenCode untuk web automation combo memakai server MCP mcp-web.
// Fitur:
//   1. Auto-daftarkan MCP server "mcp-web" (lokal, stdio) kalau belum ada di config.
//   2. Command /web       — combo eksplorasi: buka → baca → klik/isi → jawab.
//   3. Command /web-debug — combo debug: buka → kumpulkan network/console → laporan.
// Dibuat dari nol, oleh Nemo. Bagian dari repo mcp-web.
import { Plugin } from "@opencode/plugin"

const SERVER = "mcp-web"
const BIN = "/data/data/com.termux/files/home/mcp-web/bin/mcp-web.js"

// Instruksi bersama untuk agent — menjelaskan cara memakai tools mcp-web.
const WEB_GUIDE = `Kamu memakai tools dari MCP server "mcp-web" (web automation, tanpa Chromium — DOM-level).
Cara pakai tools (nama bisa tools.mcp-web.<nama> atau mcp-web_<nama>):
- navigate(url)          — buka halaman (WAJIB pertama).
- get_content({format})  — baca isi: "text" (default), "html", atau "summary".
- query({selector})      — daftar elemen (tag/id/klass/teks singkat).
- click({selector})      — klik link (ikuti navigasi) / tombol / checkbox.
- fill({selector,value}) — isi input/textarea/select.
- submit({selector})     — submit form (GET diikuti).
- js_eval({code})        — eksekusi ekspresi JS di konteks halaman (debug, sandbox).
- console_get()          — log console sesi (debug).
- network_logs()         — riwayat request/response (debug).
- cookies({action})      — list/clear cookie.
- history({action})      — list/back/forward.
- screenshot({format})   — snapshot struktural (text/html).
- reset()                — bersihkan sesi.

Alur kerja: navigate → get_content → (query/click/fill/submit sesuai kebutuhan) →
(debug bila perlu: network_logs/console_get) → laporan ringkas ke user.
Utamakan get_content "text" untuk membaca; gunakan "summary" untuk gambaran cepat.
JIKA tools mcp-web tidak tersedia: beri tahu user bahwa MCP server belum terhubung
dan sarankan /mcps atau \`opencode mcp list\` (tanpa backtick).`

export default Plugin.define({
  id: "mcp-web-combo",
  async setup(ctx) {
    // 1. Pastikan MCP server mcp-web terdaftar (tidak menimpa config user).
    await ctx.mcp.transform((editor) => {
      if (!editor.get(SERVER)) {
        editor.set(SERVER, { type: "local", command: ["node", BIN, "stdio"] })
      }
    })

    // 2. Command /web — combo eksplorasi.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "web",
        description: "Combo web automation: buka halaman, baca isi, klik/form sesuai permintaan (via mcp-web)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const target = prompt.text.trim()
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${WEB_GUIDE}\n\nTugas: buka dan jelajahi web.\n${target ? `Target/instruksi user: ${target}` : "Buka URL yang diminta user."}\nLakukan alur combo, lalu lapor ringkas: URL final, judul, isi penting, dan hasil sesuai permintaan.`,
            delivery,
          })
        },
      })
    })

    // 3. Command /web-debug — combo debugging.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "web-debug",
        description: "Combo debugging web: buka halaman + kumpulkan network/console/DOM (via mcp-web)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const target = prompt.text.trim()
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text: `${WEB_GUIDE}\n\nTugas: DEBUG halaman web.\n${target ? `URL/peserta: ${target}` : "Buka URL yang diminta user, lalu debug."}\nLangkah wajib: navigate → get_content(summary) → network_logs → console_get.\nPeriksa: status HTTP, redirect, elemen penting, error console, request gagal. Kalau perlu dalami dengan query/js_eval. Lapor: temuan, penyebab, dan saran perbaikan.`,
            delivery,
          })
        },
      })
    })

    console.log(`[${ctx.location.directory}] plugin mcp-web-combo aktif`)
  },
})