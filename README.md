# mcp-web

**MCP server web automation untuk Termux** — buka web, klik, isi formulir, telusuri DOM, dan debug langsung dari AI. Murni Node.js, dibangun dari nol, tanpa Chromium, tanpa root, tanpa proot, tanpa aplikasi desktop.

[![Versi](https://img.shields.io/badge/versi-1.1.0-blue)](package.json) [![Test](https://img.shields.io/badge/test-30%20pass-green)]() [![Lisensi](https://img.shields.io/badge/lisensi-MIT-brightgreen)](LICENSE)

---

## Apa ini?

`mcp-web` adalah server [Model Context Protocol](https://modelcontextprotocol.io) yang memberikan kemampuan *web automation* kepada AI (misal. opencode). Server ini dibuat **murni dari nol**: protokol JSON-RPC/MCP, transport stdio dan HTTP/SSE, hingga engine halaman — semuanya kode sendiri, dengan satu-satunya dependensi runtime `linkedom` (parser DOM ringan, murni JavaScript).

Semua berjalan di terminal Termux biasa. Tidak ada browser engine yang berat, tidak perlu akses root, tidak perlu proot/container, tidak perlu X11/desktop.

## Fitur

- **Dua mode transport**:
  - `stdio` — untuk opencode lokal di Termux (default).
  - `serve` — mode remote HTTP + SSE; bisa dipakai dari perangkat lain di jaringan.
- **14 tools MCP** untuk web automation & debugging:

| Tool | Fungsi |
|---|---|
| `navigate` | Buka halaman web (fetch + parse DOM) |
| `get_content` | Lihat isi halaman: teks, HTML, atau ringkasan |
| `query` | Cari elemen dengan CSS selector |
| `click` | Klik link (ikuti navigasi) / tombol / checkbox |
| `fill` | Isi input, textarea, select |
| `submit` | Submit form (GET diikuti, POST dicatat) |
| `wait` | Jeda antar langkah |
| `js_eval` | Eksekusi ekspresi JavaScript di konteks halaman (sandbox `vm`) |
| `console_get` | Log console yang terekam selama sesi |
| `network_logs` | Riwayat request/response (URL, status, timing) |
| `cookies` | Lihat / bersihkan cookie sesi |
| `history` | Riwayat navigasi + back/forward |
| `screenshot` | Snapshot struktural halaman (teks / HTML) |
| `reset` | Bersihkan seluruh sesi |

- **State per sesi**: cookie store, history, network log, console log — konsisten antar panggilan tool.
- **Aman**: `navigate` hanya http/https, `js_eval` berjalan di `vm` terisolasi dengan timeout, ukuran halaman dibatasi (5 MB) anti boros memori.
- **Offline testable**: seluruh test memakai server HTTP lokal, tanpa jaringan eksternal.

## Instalasi

Persyaratan: **Node.js ≥ 20** di Termux (`pkg install nodejs`) dan npm.

```bash
cd ~
git clone https://github.com/nemoobc/mcp-web.git
cd mcp-web
npm install
```

> Tanpa root, tanpa proot, tanpa Chromium — cukup Node.js standar.

## Cara pakai

### 1. Mode lokal (stdio) untuk opencode

Tambahkan MCP server di `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "mcp-web": {
      "type": "stdio",
      "command": "node",
      "args": ["/data/data/com.termux/files/home/mcp-web/bin/mcp-web.js", "stdio"]
    }
  }
}
```

### 2. Mode remote (HTTP + SSE) dari perangkat lain

Di Termux:

```bash
node bin/mcp-web.js serve --port 3827
```

Di perangkat lain (mis. PC/laptop), daftarkan URL remote di opencode:

```json
{
  "mcp": {
    "mcp-web": {
      "type": "remote",
      "url": "http://IP_TERMUX:3827/sse"
    }
  }
}
```

Cek kesehatan server: `curl http://localhost:3827/health` → `{"ok":true,...}`.

## Contoh alur

```
navigate  → https://example.com
query     → a, button, input
click     → a                       (ikuti link)
get_content → text                  (baca isi halaman target)
history   → back
submit    → #search                 (form GET diikuti)
network_logs →                      (debug request/response)
```

## Plugin OpenCode (combo maksimal)

Supaya tools-nya bisa **di-combo** dengan agent OpenCode, repo ini menyertakan plugin:

- **`plugin/mcp-web-combo/`** — plugin OpenCode yang:
  1. **Auto-daftarkan** MCP server `mcp-web` (lokal, stdio) kalau belum ada di config.
  2. Menambah command **`/web`** — combo eksplorasi: buka → baca → klik/form → jawab.
  3. Menambah command **`/web-debug`** — combo debugging: buka → ambil network/console → laporan temuan.

### Cara pasang plugin

```bash
cd ~/mcp-web/plugin/mcp-web-combo
npm install        # pasang SDK @opencode/plugin (lokal di folder plugin, tak mengotori root)
```

Lalu daftarkan plugin di `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": ["/data/data/com.termux/files/home/mcp-web/plugin/mcp-web-combo"]
}
```

Restart OpenCode (`opencode service restart`) — plugin langsung aktif. Setelah itu di TUI ketik `/` untuk melihat command `/web` dan `/web-debug`. MCP server `mcp-web` otomatis terhubung dan tools-nya (navigate, click, fill, get_content, network_logs, console_get, dan lain-lain) tersedia untuk agent.

> Plugin ini dibuat dari nol oleh Nemo. Versi SDK plugin mengikuti `@opencode/plugin` 2.x — pastikan versi OpenCode kamu kompatibel.

## Batasan (dijelaskan dengan jujur)

Karena berjalan **tanpa Chromium**, `mcp-web` tidak melakukan rendering visual piksel, eksekusi JavaScript halaman penuh, atau layout CSS. Yang disediakan adalah:

- DOM asli hasil parsing HTML (parsing cepat & ringan).
- Navigasi, klik, isi form, dan traversal DOM.
- Eksekusi JavaScript melalui `sandbox vm` yang aman (ekspresi, bukan renderer).
- Snapshot **struktural** (teks / HTML / metadata) — bukan gambar bitmap.

Untuk halaman yang sangat bergantung pada rendering penuh (SPA kompleks, canvas, WebGL), gunakan solusi browser sungguhan bila tersedia. `mcp-web` unggul untuk: riset isi web, pengujian struktur halaman, scraping, dan debugging HTTP/DOM dari terminal.

## Struktur proyek

```
mcp-web/
├── bin/mcp-web.js        # entry CLI (stdio / serve)
├── src/
│   ├── protocol.js       # protokol JSON-RPC 2.0 + MCP (murni)
│   ├── stdio.js          # transport stdio
│   ├── http.js           # transport HTTP + SSE (remote)
│   ├── browser.js        # engine halaman (fetch + DOM model)
│   └── tools.js          # registrasi 14 tool MCP
├── plugin/
│   └── mcp-web-combo/    # plugin OpenCode: /web & /web-debug (combo)
└── tests/                # test otomatis (node --test, offline)
```

## Pengembangan

```bash
npm test        # jalankan seluruh test (30 test, offline)
npm start       # jalankan server remote di port 3827
```

## Lisensi

[MIT](LICENSE) © 2026 Nemo.

---

Dibuat dengan karya sendiri, dari nol. Created by **Nemo**.