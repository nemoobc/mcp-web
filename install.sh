#!/usr/bin/env bash
# install.sh — pasang MCP `web` + plugin `browser` ke config OpenCode (IDEMPOTEN).
#
# Pakai:
#   curl -fsSL https://raw.githubusercontent.com/nemoobc/mcp-web/main/install.sh | bash
#   bash install.sh                        # dari dalam repo / setelah clone
#   bash install.sh --config <path>        # config lain (untuk test)
#   bash install.sh <path>                 # sama dengan --config
#
# Env:  OPENCODE_CONFIG=<path>   MCP_WEB_DIR=<repo>   MCP_WEB_SKIP_DEPS=1
#       MCP_WEB_REPO=<git url>   MCP_WEB_RAW=<raw url install.sh>
#
# Exit: 0 ok | 1 argumen | 2 repo/bin hilang | 3 npm install gagal
#       | 4 config tak valid (bukan JSON / bukan object — file tak disentuh)
#       | 5 config tak bisa dibaca/ditulis (pesan [install] GAGAL di stderr, tanpa stack Node)
set -euo pipefail

REPO_URL="${MCP_WEB_REPO:-https://github.com/nemoobc/mcp-web.git}"

say() { printf '[install] %s\n' "$*"; }
die() { printf '[install] GAGAL: %s\n' "$*" >&2; exit "${2:-1}"; }

# --- 1) path config --------------------------------------------------------
CFG="${OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"
case "${1:-}" in
  "") ;;
  --config|-c)
    [ -n "${2:-}" ] || die "--config butuh <path>" 1
    CFG="$2" ;;
  -h|--help)
    printf '%s\n' \
      "install.sh — pasang MCP server 'web' + plugin 'browser' ke opencode.json" \
      "  bash install.sh [--config <path>]" \
      "  exit: 0 ok | 1 argumen | 2 repo/bin | 3 npm | 4 config | 5 baca/tulis config" \
      "  env : OPENCODE_CONFIG, MCP_WEB_DIR, MCP_WEB_SKIP_DEPS"
    exit 0 ;;
  *) CFG="$1" ;;
esac

# --- 2) lokasi repo --------------------------------------------------------
self_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
is_repo() { [ -f "$1/package.json" ] && grep -q '"name": *"mcp-web"' "$1/package.json" 2>/dev/null; }

REPO="${MCP_WEB_DIR:-}"
if [ -z "$REPO" ]; then
  if [ -n "$self_dir" ] && is_repo "$self_dir"; then REPO="$self_dir"; else REPO="$HOME/mcp-web"; fi
fi
if ! is_repo "$REPO"; then
  say "repo belum ada di $REPO — clone $REPO_URL"
  command -v git >/dev/null 2>&1 || die "git tidak ada. Clone manual lalu jalankan: bash $REPO/install.sh" 2
  git clone --depth 1 "$REPO_URL" "$REPO" >/dev/null 2>&1 \
    || die "clone gagal (jaringan/offline?). Alternatif: git clone $REPO_URL $REPO" 2
fi

BIN="$REPO/bin/mcp-web.js"
PLUG="$REPO/plugin/browser-mcp"
[ -f "$BIN" ]    || die "bin tidak ada: $BIN" 2
[ -f "$PLUG/package.json" ] || die "plugin tidak ada: $PLUG" 2
say "repo   : $REPO"

# --- 3) dependensi (sekali saja; idempoten) --------------------------------
if [ ! -d "$REPO/node_modules" ] && [ "${MCP_WEB_SKIP_DEPS:-0}" != "1" ]; then
  say "npm install (sekali) ..."
  ( cd "$REPO" && npm install --no-audit --no-fund ) || die "npm install gagal (exit $?)" 3
else
  say "deps   : node_modules sudah ada — dilewati"
fi

# --- 4) merge config (validasi JSON dulu, baru backup, baru tulis) ---------
# Seluruh blok node dibungkus try/catch → kegagalan baca/tulis (EISDIR/EACCES/
# dst) cetak `[install] GAGAL: <pesan>` ke stderr + exit 5 (KELIRU BERBEDA dari
# 1=argumen), TANPA stack trace Node mentah ke user (P3 R6 temuan 8).
mkdir -p "$(dirname -- "$CFG")"
export MW_CFG="$CFG" MW_PLUG="$PLUG" MW_BIN="$BIN"
node -e '
const fs = require("fs");
try {
const cfg = process.env.MW_CFG, plug = process.env.MW_PLUG, bin = process.env.MW_BIN;
// git-guard-ok: helper peringatan instalasi yang ditujukan ke pengguna (bukan debug)
const warn = (m) => console.log("[install] PERINGATAN: " + m);

// Backup dengan nama UNIK: dua run pada milidetik yang sama tidak boleh
// saling menimpa (existsSync loop — P3 R6 temuan 6; diuji dgn jam beku).
const uniqueBak = () => {
  let n = 0;
  let b = cfg + ".bak." + Date.now();
  while (fs.existsSync(b)) { n += 1; b = cfg + ".bak." + Date.now() + "." + n; }
  return b;
};

// baca + validasi DULU: config rusak → keluar tanpa menyentuh file
let raw = "{}";
if (fs.existsSync(cfg)) {
  raw = fs.readFileSync(cfg, "utf8").trim();
  let probe;
  try { probe = raw ? JSON.parse(raw) : {}; }
  catch (e) { console.error("[install] config bukan JSON valid: " + cfg + " — " + e.message); process.exit(4); }
  if (typeof probe !== "object" || probe === null || Array.isArray(probe)) {
    console.error("[install] config harus object JSON: " + cfg); process.exit(4);
  }
}
const d = raw ? JSON.parse(raw) : {};

// backup SEBELUM ubah apa pun (nama unik — tak pernah menimpa backup lain)
let bk = null;
if (fs.existsSync(cfg)) {
  bk = uniqueBak();
  fs.copyFileSync(cfg, bk);
  // git-guard-ok: output progres instalasi untuk pengguna (bukan debug)
  console.log("[install] backup : " + bk);
}

// --- TAK ADA perubahan struktural SENYAP (P3 R6 temuan 4) ---
// Semua struktur yang bukan milik mcp-web diperingatkan apa adanya; backup
// di atas selalu memegang isi lama utuh untuk pemulihan.
const prevServers = (d.mcp && typeof d.mcp === "object" && !Array.isArray(d.mcp)) ? d.mcp.servers : undefined;
const prevWeb = (prevServers && typeof prevServers === "object" && !Array.isArray(prevServers)) ? prevServers.web : undefined;
if (prevWeb && typeof prevWeb === "object") {
  const prevCmd = Array.isArray(prevWeb.command) ? prevWeb.command.join(" ") : "";
  if (!prevCmd.includes("mcp-web")) {
    warn("menimpa mcp.servers.web yang sudah ada (backup: " + (bk || cfg) + ")"
      + " — server lama " + (prevWeb.type === "remote" ? ("remote " + (prevWeb.url || "?")) : "non-mcp-web")
      + " hilang dari config aktif (pulihkan dari backup bila bukan milik mcp-web)");
  }
}
if (Array.isArray(d.mcp)) {
  warn("mcp berbentuk array (isi lama hanya tersimpan di backup) — di-set ulang jadi object {mcp:{servers:{...}}}");
} else if (d.mcp && typeof d.mcp === "object" && Array.isArray(d.mcp.servers)) {
  warn("mcp.servers berbentuk array (isi lama hanya tersimpan di backup) — di-set ulang jadi object");
}
if (d.plugins != null && !Array.isArray(d.plugins)) {
  warn("plugins berbentuk " + (typeof d.plugins) + " — di-set ulang jadi array; nilai lama dipertahankan di dalamnya");
}

// mcp.servers.web — V2: codemode:false + timeout startup/catalog 60s
d.mcp = (d.mcp && typeof d.mcp === "object" && !Array.isArray(d.mcp)) ? d.mcp : {};
d.mcp.servers = (d.mcp.servers && typeof d.mcp.servers === "object" && !Array.isArray(d.mcp.servers)) ? d.mcp.servers : {};
d.mcp.servers.web = {
  type: "local",
  command: ["node", bin, "stdio", "--js"],
  codemode: false,
  timeout: { startup: 60000, catalog: 60000 }
};

// plugins: pastikan builtin browser dimatikan agar tidak tabrakan, lalu daftarkan ours
if (!Array.isArray(d.plugins)) d.plugins = (d.plugins == null) ? ["*"] : [d.plugins];
if (!d.plugins.includes("-opencode.browser")) d.plugins.splice(d.plugins.indexOf("*") + 1, 0, "-opencode.browser");
if (!d.plugins.includes(plug)) d.plugins.push(plug);

fs.writeFileSync(cfg, JSON.stringify(d, null, 2) + "\n");
// git-guard-ok: ringkasan hasil instalasi untuk pengguna (bukan debug)
console.log("[install] config : " + cfg);
} catch (e) {
  // Kode KELIRU BERBEDA dari 1 (argumen) & 4 (JSON tak valid) → 5 = baca/tulis
  console.error("[install] GAGAL: " + (e && e.message ? e.message : String(e)));
  process.exit(5);
}
' || exit $?

# --- 5) verifikasi (angka di laporan = kenyataan) ---------------------------
export MW_CFG="$CFG" MW_PLUG="$PLUG"
node -e '
const fs = require("fs");
try {
const c = JSON.parse(fs.readFileSync(process.env.MW_CFG, "utf8"));
const w = c.mcp && c.mcp.servers && c.mcp.servers.web;
const errs = [];
if (!w) errs.push("mcp.servers.web hilang");
else {
  if (w.codemode !== false) errs.push("codemode != false");
  if (!w.timeout || w.timeout.startup !== 60000 || w.timeout.catalog !== 60000) errs.push("timeout != 60s");
  if (!Array.isArray(w.command) || w.command[0] !== "node") errs.push("command bukan node ...");
}
if (!Array.isArray(c.plugins) || !c.plugins.includes(process.env.MW_PLUG)) errs.push("plugin tak terdaftar");
if (!Array.isArray(c.plugins) || !c.plugins.includes("-opencode.browser")) errs.push("-opencode.browser hilang");
if (errs.length) { console.error("[install] VERIFIKASI GAGAL: " + errs.join("; ")); process.exit(4); }
// git-guard-ok: hasil verifikasi akhir untuk pengguna (bukan debug)
console.log("[install] OK     : mcp.servers.web (codemode:false, timeout 60s) + plugin terdaftar");
console.log("[install] selesai — restart opencode agar MCP + plugin termuat");
} catch (e) {
  // gagal BACA hasil tulis (bukan hasil verifikasi) → 5, bukan 1 (argumen)
  console.error("[install] GAGAL: " + (e && e.message ? e.message : String(e)));
  process.exit(5);
}
'
