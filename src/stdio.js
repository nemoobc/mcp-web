// WebDrive MCP — transport stdio (untuk opencode lokal di Termux).
import readline from "readline"
import { McpServer, processLine, SERVER_INFO, ERR } from "./protocol.js"
import { createTools } from "./tools.js"

export async function runStdio({ engine = "dom" } = {}) {
  const server = new McpServer({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    tools: await createTools({ engine }),
  })

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  // Antrian serial: tools/call bersifat stateful (navigate → query dst), jadi
  // setiap line WAJIB selesai diproses sebelum line berikutnya — kalau tidak,
  // query bisa jalan sebelum navigate selesai (race).
  let queue = Promise.resolve()
  // Job tools/call yang SUDAH ter-antre tapi BELUM mulai — dibatalkan saat
  // tool `stop` dieksekusi (P2-1 critic: navigate yang dikirim SEBELUM stop
  // tidak boleh jalan & sukses SESUDAH stop). Inklusi di-snapshot saat stop
  // MULAI (bukan saat baris stop datang): navigate dari baris sebelumnya
  // selalu mulai duluan via microtask (set _inflight) → kasus "navigate
  // inflight + stop" tetap membatalkan FETCH, bukan melewatkan job-nya.
  const pending = new Set()

  rl.on("line", (line) => {
    if (!line.trim()) return
    // Parse sekali: deteksi tools/call utk rec antrian + jalur prioritas stop.
    let meta = null
    try { meta = JSON.parse(line) } catch { /* biar processLine yang menolak jujur */ }
    const isStop = meta?.method === "tools/call" && meta?.params?.name === "stop"
    // rec hanya utk tools/call non-stop. Notifikasi (tanpa id) ikut tercatat
    // supaya ikut dibatalkan — tanpa balasan (memang tak ada kanal balasnya).
    const rec = meta?.method === "tools/call" && !isStop
      ? { cancelled: false, id: meta?.id, notif: meta?.id === undefined }
      : null
    if (rec) pending.add(rec)

    const job = async () => {
      if (rec) {
        pending.delete(rec)
        if (rec.cancelled) {
          // stop datang saat job masih ANTRE (belum mulai) → jangan jalankan;
          // balas jujur dengan id request asli. Pesan mengandung
          // "dibatalkan oleh stop" — klien melihat pembatalan, bukan sukses palsu.
          if (!rec.notif) {
            process.stdout.write(
              JSON.stringify({ jsonrpc: "2.0", id: rec.id, error: { code: ERR.TOOL_EXECUTION_FAILED, message: "dibatalkan oleh stop (job batal sebelum mulai — stop diterima saat masih antre)" } }) + "\n",
            )
          }
          return
        }
      }
      try {
        const out = await processLine(server, line)
        for (const m of out) process.stdout.write(JSON.stringify(m) + "\n")
      } catch (e) {
        // Balasan error pakai id request ASLI (0 kalau line tak bisa diparse).
        let id = 0
        try {
          const p = JSON.parse(line)
          if (p && (typeof p.id === "string" || typeof p.id === "number")) id = p.id
        } catch {}
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message).split("\n")[0] } }) + "\n")
      }
    }
    const recover = (e) => {
      // Gagal total (mis. stdout tertutup) → tulis ke STDERR (bukan stdout,
      // supaya tak mencemari stream protokol) dan queue tetap lanjut.
      process.stderr.write(`[mcp-web] queue error: ${e?.stack || e}\n`)
    }
    if (isStop) {
      // Snapshot saat baris stop DITERIMA: hanya job yang sudah terkumpul saat
      // stop dipanggil yang jadi kandidat batal — job yang datang sesudah stop
      // tidak ikut kena.
      const cancelCandidates = [...pending]
      // Jalur prioritas: stop dijalankan SEKARANG (tanpa menunggu antrean).
      // Bungkus Promise.resolve().then → navigate dari line SEBELUMNYA yang
      // sudah ter-antre sebagai microtask SELALU mulai dulu (set _inflight),
      // tapi stop TIDAK menunggu fetch-nya yang lambat.
      const p = Promise.resolve().then(() => {
        // Saat stop MULAI: kandidat yang MASIH antre (belum mulai) → batal
        // sebelum jalan; yang sudah mulai (inflight) biar dihentikan stop
        // handler lewat AbortController (P2-1).
        for (const r of cancelCandidates) if (pending.has(r)) r.cancelled = true
        return job()
      }).catch(recover)
      // Rantai tetap disambung → request BERIKUTNYA baru menunggu stop selesai.
      queue = queue.then(() => p).catch(recover)
      return
    }
    queue = queue.then(job).catch(recover)
  })

  process.stdin.on("end", () => {})
  process.stdout.on("error", () => process.exit(0))
}
