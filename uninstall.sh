#!/usr/bin/env bash
# uninstall.sh — cabut MCP `web` + plugin `browser` dari config OpenCode (IDEMPOTEN).
#
# Pakai:
#   curl -fsSL https://raw.githubusercontent.com/nemoobc/mcp-web/main/uninstall.sh | bash
#   bash uninstall.sh
#   bash uninstall.sh --config <path>
#
# Env:  OPENCODE_CONFIG=<path>   KEEP_DISABLE=1 (biarkan "-opencode.browser" dimatikan)
#
# Exit: 0 ok (termasuk tidak ada yang perlu dicabut) | 1 argumen
#       | 4 config tak valid (bukan JSON / bukan object)
#       | 5 config tak bisa dibaca/ditulis (pesan [uninstall] GAGAL, tanpa stack Node)
set -euo pipefail

say() { printf '[uninstall] %s\n' "$*"; }
die() { printf '[uninstall] GAGAL: %s\n' "$*" >&2; exit "${2:-1}"; }

# --- 1) path config --------------------------------------------------------
CFG="${OPENCODE_CONFIG:-$HOME/.config/opencode/opencode.json}"
case "${1:-}" in
  "") ;;
  --config|-c)
    [ -n "${2:-}" ] || die "--config butuh <path>" 1
    CFG="$2" ;;
  -h|--help)
    printf '%s\n' \
      "uninstall.sh — cabut MCP server 'web' + plugin 'browser' dari opencode.json" \
      "  bash uninstall.sh [--config <path>]   (KEEP_DISABLE=1: biarkan -opencode.browser)" \
      "  exit: 0 ok / tidak ada yang dicabut | 1 argumen | 4 config tak valid | 5 baca/tulis config"
    exit 0 ;;
  *) CFG="$1" ;;
esac

PLUG="$HOME/mcp-web/plugin/browser-mcp"
[ -f "${MCP_WEB_DIR:-$HOME/mcp-web}/plugin/browser-mcp/package.json" ] \
  && PLUG="$(CDPATH= cd -- "${MCP_WEB_DIR:-$HOME/mcp-web}/plugin/browser-mcp" && pwd)"
self_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$self_dir" ] && [ -f "$self_dir/plugin/browser-mcp/package.json" ]; then
  PLUG="$self_dir/plugin/browser-mcp"
fi

# --- 2) tidak ada config → tidak ada yang dicabut (tetap exit 0) ------------
if [ ! -f "$CFG" ]; then
  say "config tidak ada: $CFG — tidak ada yang perlu dicabut."
  exit 0
fi
say "config : $CFG"
say "plugin : $PLUG"

# --- 3) identifikasi pola → ubah (backup HANYA bila berubah) ----------------
# Catatan (P2/P3 R6): entri mcp-web dikenali dari POLA "mcp-web" + ujung
# "/plugin/browser-mcp" — BUKAN string path persis. Mode piped / repo non-
# $HOME/mcp-web menghitung $PLUG beda dari yang terpasang → pencocokan persis
# meninggalkan entri plugin + verifikasi melapor palsu "sudah hilang".
# Server `web` dihapus HANYA bila command/path-nya mengandung "mcp-web"
# (server web milik orang lain dibiarkan + peringatan). Backup: unik & HANYA
# saat config benar-benar berubah (tak menumpuk tiap run).
export MW_CFG="$CFG" MW_PLUG="$PLUG" MW_KEEP_DISABLE="${KEEP_DISABLE:-0}"
node -e '
const fs = require("fs");
try {
const cfg = process.env.MW_CFG, plug = process.env.MW_PLUG;
const keep = process.env.MW_KEEP_DISABLE === "1";

// Entri plugin milik mcp-web — identitas SEJATI = path repo yang tercatat di
// mcp.servers.web.command config ini. Pola path saja TIDAK bisa membedakan
// `alt-mcp-web` milik kita vs `proyek-lain-mcp-web` milik orang lain —
// stringnya identik (B3 VERDICT r7). Fallback = boundary ketat "/mcp-web/".
const repoPlugin = (cfg) => {
  const w = cfg && cfg.mcp && cfg.mcp.servers && typeof cfg.mcp.servers === "object"
    && !Array.isArray(cfg.mcp.servers) ? cfg.mcp.servers.web : undefined;
  const SUFFIX = "/bin/mcp-web.js";
  const arr = Array.isArray(w && w.command) ? w.command : [];
  for (const a of arr) if (typeof a === "string" && a.endsWith(SUFFIX))
    return a.slice(0, -SUFFIX.length) + "/plugin/browser-mcp";
  const p = w && typeof w.path === "string" ? w.path : "";
  return p.endsWith(SUFFIX) ? p.slice(0, -SUFFIX.length) + "/plugin/browser-mcp" : "";
};
let OUR_PLUGIN = "";
const isOurPlugin = (p) => typeof p === "string"
  && (p === plug
      || (p.endsWith("/plugin/browser-mcp")
          && (p === OUR_PLUGIN || /(^|\/)mcp-web\/plugin\/browser-mcp$/.test(p))));
// Server `web` milik mcp-web = command/path mengandung "mcp-web"; nama key
// "web" SAJA tidak cukup (server web milik orang lain ikut terhapus, P3 R6).
const isOurWeb = (w) => {
  const cmd = Array.isArray(w && w.command) ? w.command.join(" ")
    : (w && typeof w.path === "string" ? w.path : "");
  return cmd.includes("mcp-web");
};
// Nama backup UNIK (existsSync loop) — dua run pada milidetik yang sama tak
// boleh saling menimpa (P3 R6).
const uniqueBak = () => {
  let n = 0;
  let b = cfg + ".bak." + Date.now();
  while (fs.existsSync(b)) { n += 1; b = cfg + ".bak." + Date.now() + "." + n; }
  return b;
};

let d;
const raw = fs.readFileSync(cfg, "utf8").trim();
try { d = raw ? JSON.parse(raw) : {}; }
catch (e) { console.error("[uninstall] config bukan JSON valid: " + cfg + " — " + e.message); process.exit(4); }
if (typeof d !== "object" || d === null || Array.isArray(d)) {
  console.error("[uninstall] config harus object JSON: " + cfg); process.exit(4);
}

let changed = false;
// Identitas plugin milik kita DIHITUNG SEBELUM web dihapus — kalau dihitung
// sesudahnya repo sudah hilang dari config dan entri non-default (alt-mcp-web)
// bakal tertinggal lagi (regresi P2 R6-3).
OUR_PLUGIN = repoPlugin(d);

if (d.mcp && typeof d.mcp === "object" && !Array.isArray(d.mcp)
  && d.mcp.servers && typeof d.mcp.servers === "object" && !Array.isArray(d.mcp.servers)
  && Object.prototype.hasOwnProperty.call(d.mcp.servers, "web")) {
  if (isOurWeb(d.mcp.servers.web)) {
    delete d.mcp.servers.web; changed = true;
    if (Object.keys(d.mcp.servers).length === 0) { delete d.mcp.servers; changed = true; }
    if (Object.keys(d.mcp).length === 0) { delete d.mcp; changed = true; }
  } else {
    // bukan milik kita → JANGAN hapus senyap; peringatkan apa adanya
    // git-guard-ok: peringatan ke pengguna bahwa entri bukan milik mcp-web (bukan debug)
    console.log("[uninstall] PERINGATAN: mcp.servers.web bukan milik mcp-web (command/path tanpa \"mcp-web\") — dibiarkan");
  }
}

if (Array.isArray(d.plugins)) {
  const before = d.plugins.length;
  d.plugins = d.plugins.filter((p) => !isOurPlugin(p));
  if (!keep) d.plugins = d.plugins.filter((p) => p !== "-opencode.browser");
  if (d.plugins.length !== before) changed = true;
  if (d.plugins.length === 0) { delete d.plugins; changed = true; }
}

if (changed) {
  const bk = uniqueBak();
  fs.copyFileSync(cfg, bk);
  // git-guard-ok: output progres uninstall untuk pengguna (bukan debug)
  console.log("[uninstall] backup : " + bk);
  fs.writeFileSync(cfg, JSON.stringify(d, null, 2) + "\n");
}
// git-guard-ok: ringkasan hasil uninstall + status builtin untuk pengguna (bukan debug)
console.log(changed
  ? "[uninstall] dicabut : mcp.servers.web (milik mcp-web) + plugin"
  : "[uninstall] bersih  : tidak ada entri yang perlu dihapus");
if (!keep) console.log("[uninstall] builtin  : \"-opencode.browser\" diaktifkan kembali");
} catch (e) {
  // gagal baca/tulis config → 5 (bukan 1=argumen, bukan stack Node mentah)
  console.error("[uninstall] GAGAL: " + (e && e.message ? e.message : String(e)));
  process.exit(5);
}
' || exit $?

# --- 4) verifikasi ----------------------------------------------------------
export MW_CFG="$CFG" MW_PLUG="$PLUG"
node -e '
const fs = require("fs");
try {
const c = JSON.parse(fs.readFileSync(process.env.MW_CFG, "utf8"));
const plug = process.env.MW_PLUG;
const w = c.mcp && c.mcp.servers && typeof c.mcp.servers === "object" && !Array.isArray(c.mcp.servers)
  ? c.mcp.servers.web : undefined;
const wCmd = Array.isArray(w && w.command) ? w.command.join(" ")
  : (w && typeof w.path === "string" ? w.path : "");
// Identitas repo dari web command config yang sama — sejajar dengan blok utama
// (pola ketat "/mcp-web/" saja akan melewatkan alt-mcp-web; pola longgar
// "mcp-web" akan ikut menghapus proyek-lain-mcp-web — B3 VERDICT r7).
const SFX = "/bin/mcp-web.js";
const cmdArr = Array.isArray(w && w.command) ? w.command : [];
let OUR_PLUGIN = "";
for (const a of cmdArr) if (typeof a === "string" && a.endsWith(SFX)) {
  OUR_PLUGIN = a.slice(0, -SFX.length) + "/plugin/browser-mcp"; break;
}
if (!OUR_PLUGIN && typeof wCmd === "string" && wCmd.endsWith(SFX))
  OUR_PLUGIN = wCmd.slice(0, -SFX.length) + "/plugin/browser-mcp";
const isOurPlugin = (p) => typeof p === "string"
  && (p === plug
      || (p.endsWith("/plugin/browser-mcp")
          && (p === OUR_PLUGIN || /(^|\/)mcp-web\/plugin\/browser-mcp$/.test(p))));
const errs = [];
// Verifikasi MENGIHITUNG entri yang mengandung pola mcp-web (bukan path persis
// hasil hitung script ini — pencocokan persis = sukses palsu, P2 R6).
if (w && wCmd.includes("mcp-web")) errs.push("mcp.servers.web (milik mcp-web) masih ada");
if (Array.isArray(c.plugins)) {
  const sisa = c.plugins.filter((p) => isOurPlugin(p));
  if (sisa.length) errs.push("entri plugin mcp-web masih ada: " + sisa.length + " → " + sisa.join(", "));
}
if (process.env.MW_KEEP_DISABLE !== "1" && Array.isArray(c.plugins) && c.plugins.includes("-opencode.browser")) errs.push("-opencode.browser masih mematikan builtin");
if (errs.length) { console.error("[uninstall] VERIFIKASI GAGAL: " + errs.join("; ")); process.exit(4); }
// git-guard-ok: hasil verifikasi akhir uninstall untuk pengguna (bukan debug)
console.log("[uninstall] OK     : config valid, entri MCP + plugin sudah hilang");
console.log("[uninstall] selesai — restart opencode, lalu (opsional) hapus folder repo");
} catch (e) {
  console.error("[uninstall] GAGAL: " + (e && e.message ? e.message : String(e)));
  process.exit(5);
}
'
