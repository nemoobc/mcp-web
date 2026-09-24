// tests/installer.test.js — instal & uninstall instan (install.sh / uninstall.sh).
// Semua jalan di HOME sandbox: config asli ~/.config/opencode/opencode.json TIDAK PERNAH disentuh —
// termasuk env `OPENCODE_CONFIG` dari lingkungan developer yang DIHAPUS dari env child (P1 R6 temuan 1):
// install.sh:22 membacanya → tanpa penghapusan, test MENULIS ke config OpenCode asli di luar sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "install.sh");
const UNINSTALL = path.join(ROOT, "uninstall.sh");
const PLUG = path.join(ROOT, "plugin", "browser-mcp");
const TMPBASE = fs.realpathSync(process.env.TMPDIR || os.tmpdir());

function box() {
  const dir = fs.mkdtempSync(path.join(TMPBASE, "mw-inst-"));
  const cfg = path.join(dir, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  return { dir, cfg, home: dir };
}
// Env untuk SEMUA child script: sandbox HOME + WAJIB tanpa OPENCODE_CONFIG.
// P1 R6 temuan 1: OPENCODE_CONFIG (env yang didokumentasikan install.sh:10)
// ikut terbawa dari `process.env` → install.sh:22 jatuh ke path LUAR sandbox dan
// test MENULIS ke config OpenCode sungguhan (bukti critic: loot.json tercipta).
// CFG test HARUS selalu jatuh ke argumen / $HOME sandbox — tak pernah ke env luar.
function childEnv(env = {}) {
  const e = { ...process.env, HOME: env.__home, MCP_WEB_SKIP_DEPS: "1", ...env };
  delete e.OPENCODE_CONFIG; // hapus warisan lingkungan luar
  return e;
}
function run(script, args, env = {}, input) {
  return spawnSync("bash", [script, ...args], {
    input,
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv(env),
  });
}
// Mode piped (curl | bash): script lewat stdin, cwd bebas (bukan harus repo).
function runPiped(scriptPath, env = {}, cwd = ROOT) {
  return spawnSync("bash", [], {
    input: fs.readFileSync(scriptPath, "utf8"),
    cwd,
    encoding: "utf8",
    env: childEnv(env),
  });
}
// Repo MINIMAL lokal → is_repo() lolos: install fallback/clone TANPA jaringan.
function seedRepo(dir) {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "plugin", "browser-mcp"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  fs.copyFileSync(path.join(ROOT, "bin", "mcp-web.js"), path.join(dir, "bin", "mcp-web.js"));
  fs.copyFileSync(path.join(ROOT, "plugin", "browser-mcp", "package.json"), path.join(dir, "plugin", "browser-mcp", "package.json"));
  return dir;
}
function read(f) { return JSON.parse(fs.readFileSync(f, "utf8")); }
function backups(cfg) {
  const dir = path.dirname(cfg), base = path.basename(cfg);
  return fs.readdirSync(dir).filter((n) => n.startsWith(base + ".bak."));
}
function fail(r) { return `status=${r.status} out=${r.stdout} err=${r.stderr}`; }

test("install: config baru → mcp.servers.web + plugin terdaftar, exit 0", () => {
  const b = box();
  const r = run(INSTALL, [b.cfg], { __home: b.home });
  assert.equal(r.status, 0, fail(r));
  const c = read(b.cfg);
  assert.ok(c.mcp?.servers?.web, "mcp.servers.web wajib ada");
  assert.equal(c.mcp.servers.web.type, "local");
  assert.deepEqual(c.mcp.servers.web.command, ["node", path.join(ROOT, "bin", "mcp-web.js"), "stdio", "--js"]);
  assert.equal(c.mcp.servers.web.codemode, false, "codemode wajib false");
  assert.deepEqual(c.mcp.servers.web.timeout, { startup: 60000, catalog: 60000 });
  assert.ok(c.plugins.includes(PLUG), "path plugin wajib terdaftar");
  assert.ok(c.plugins.includes("-opencode.browser"), "builtin browser dimatikan agar tak tabrakan");
  assert.ok(c.plugins.includes("*"), "wildcard plugin asli wajib dipertahankan");
  assert.match(r.stdout, /VERIFIKASI|OK/);
});

test("install: idempoten — dijalankan 2× tetap 1 entry, config identik", () => {
  const b = box();
  assert.equal(run(INSTALL, [b.cfg], { __home: b.home }).status, 0);
  const first = fs.readFileSync(b.cfg, "utf8");
  const r2 = run(INSTALL, [b.cfg], { __home: b.home });
  assert.equal(r2.status, 0, fail(r2));
  const second = fs.readFileSync(b.cfg, "utf8");
  assert.equal(second, first, "run kedua tidak boleh mengubah config");
  const c = read(b.cfg);
  assert.equal(c.plugins.filter((p) => p === PLUG).length, 1, "plugin tak boleh dobel");
  assert.equal(c.plugins.filter((p) => p === "-opencode.browser").length, 1, "-opencode.browser tak boleh dobel");
});

test("install: backup config LAMA terbentuk sebelum diubah", () => {
  const b = box();
  const original = JSON.stringify({ model: "lama", plugins: ["*"] }, null, 2) + "\n";
  fs.writeFileSync(b.cfg, original);
  const r = run(INSTALL, [b.cfg], { __home: b.home });
  assert.equal(r.status, 0, fail(r));
  const bk = backups(b.cfg);
  assert.equal(bk.length, 1, "tepat 1 file backup");
  assert.equal(fs.readFileSync(path.join(path.dirname(b.cfg), bk[0]), "utf8"), original, "isi backup = isi lama persis");
  assert.match(r.stdout, new RegExp("backup : " + b.cfg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("install: key config lain tidak hilang (merge, bukan timpa)", () => {
  const b = box();
  fs.writeFileSync(b.cfg, JSON.stringify({ model: "x", permissions: [{ action: "*" }], devbrain: { a: 1 } }, null, 2));
  assert.equal(run(INSTALL, [b.cfg], { __home: b.home }).status, 0);
  const c = read(b.cfg);
  assert.equal(c.model, "x");
  assert.deepEqual(c.permissions, [{ action: "*" }]);
  assert.deepEqual(c.devbrain, { a: 1 });
  assert.ok(c.mcp.servers.web);
});

test("install: config JSON rusak → exit 4, file TIDAK diubah", () => {
  const b = box();
  const broken = '{"mcp": {"servers": {';
  fs.writeFileSync(b.cfg, broken);
  const r = run(INSTALL, [b.cfg], { __home: b.home });
  assert.equal(r.status, 4, fail(r));
  assert.equal(fs.readFileSync(b.cfg, "utf8"), broken, "file rusak wajib utuh");
  assert.equal(backups(b.cfg).length, 0, "tanpa backup — memang tak disentuh");
  assert.match(r.stderr, /JSON valid/);
});

test("install: --config <path> diterima (alias argumen)", () => {
  const b = box();
  const r = run(INSTALL, ["--config", b.cfg], { __home: b.home });
  assert.equal(r.status, 0, fail(r));
  assert.ok(read(b.cfg).mcp.servers.web);
});

test("uninstall: cabut bersih — web + plugin hilang, JSON valid, exit 0", () => {
  const b = box();
  assert.equal(run(INSTALL, [b.cfg], { __home: b.home }).status, 0);
  const before = backups(b.cfg).length;
  const r = run(UNINSTALL, [b.cfg], { __home: b.home });
  assert.equal(r.status, 0, fail(r));
  const c = read(b.cfg);
  assert.ok(!(c.mcp && c.mcp.servers && c.mcp.servers.web), "mcp.servers.web wajib hilang");
  assert.ok(!c.plugins.includes(PLUG), "path plugin wajib hilang");
  assert.ok(!c.plugins.includes("-opencode.browser"), "builtin browser diaktifkan kembali");
  assert.ok(c.plugins.includes("*"), "wildcard asli tetap ada");
  assert.equal(backups(b.cfg).length, before + 1, "uninstall menambah tepat 1 backup");
});

test("uninstall: idempoten — 2× exit 0, run kedua config tak berubah", () => {
  const b = box();
  assert.equal(run(INSTALL, [b.cfg], { __home: b.home }).status, 0);
  assert.equal(run(UNINSTALL, [b.cfg], { __home: b.home }).status, 0);
  const after1 = fs.readFileSync(b.cfg, "utf8");
  const r2 = run(UNINSTALL, [b.cfg], { __home: b.home });
  assert.equal(r2.status, 0, fail(r2));
  assert.equal(fs.readFileSync(b.cfg, "utf8"), after1, "run kedua tak mengubah apa pun");
  assert.match(r2.stdout, /tidak ada entri|bersih/);
});

test("uninstall: config tanpa entri / file hilang → tetap exit 0", () => {
  const b = box();
  const plain = JSON.stringify({ model: "x" }, null, 2) + "\n";
  fs.writeFileSync(b.cfg, plain);
  const r = run(UNINSTALL, [b.cfg], { __home: b.home });
  assert.equal(r.status, 0, fail(r));
  assert.equal(read(b.cfg).model, "x", "config tanpa entri tetap utuh");
  const missing = run(UNINSTALL, [path.join(b.home, "tidak-ada.json")], { __home: b.home });
  assert.equal(missing.status, 0, fail(missing));
});

test("uninstall: KEEP_DISABLE=1 mempertahankan -opencode.browser", () => {
  const b = box();
  assert.equal(run(INSTALL, [b.cfg], { __home: b.home }).status, 0);
  const r = run(UNINSTALL, [b.cfg], { __home: b.home, KEEP_DISABLE: "1" });
  assert.equal(r.status, 0, fail(r));
  const c = read(b.cfg);
  assert.ok(!c.plugins.includes(PLUG), "plugin tetap dicabut");
  assert.ok(c.plugins.includes("-opencode.browser"), "KEEP_DISABLE=1 → builtin tetap dimatikan");
});

test("mode piped (curl | bash): pakai default $HOME/.config/opencode/opencode.json", () => {
  const b = box();
  const r = runPiped(INSTALL, { __home: b.home }, ROOT);
  assert.equal(r.status, 0, fail(r));
  const c = read(b.cfg);
  assert.ok(c.mcp.servers.web, "config default ikut terisi");
  assert.ok(c.plugins.includes(PLUG));
});

// ===================== RONDE-6: 8 temuan VERDICT critic =====================

test("R6-1 (P1): OPENCODE_CONFIG dari lingkungan TIDAK merembet — config luar tak tersentuh, test tetap hijau", () => {
  const b = box();
  const loot = path.join(TMPBASE, "mw-loot-" + process.pid + "-" + Date.now() + ".json");
  const prev = process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG = loot; // repro persis verdict: env developer terbawa
  try {
    // (a) jalur piped TANPA argumen config — CFG jatuh ke env bila tak dihapus
    const r1 = runPiped(INSTALL, { __home: b.home });
    assert.equal(r1.status, 0, fail(r1));
    assert.ok(!fs.existsSync(loot), `path OPENCODE_CONFIG luar TIDAK BOLEH tercipta (test MENULIS ke config asli): ${loot}`);
    // (b) jalur run() juga — helper yang sama menghapus env warisan
    const r2 = run(INSTALL, [], { __home: b.home });
    assert.equal(r2.status, 0, fail(r2));
    assert.ok(!fs.existsSync(loot), "run() juga wajib menghapus OPENCODE_CONFIG lingkungan");
    const c = read(b.cfg); // $HOME sandbox — bukan env
    assert.ok(c.mcp.servers.web, "config jatuh ke $HOME/.config/opencode/opencode.json SANDBOX");
    assert.ok(c.plugins.includes(PLUG));
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = prev;
    try { fs.rmSync(loot, { force: true }); } catch {}
  }
});

test("R6-3 (P2): uninstall PIPED (cwd ≠ repo) setelah install MCP_WEB_DIR non-default → entri plugin HILANG; entri asing dipertahankan", () => {
  const b = box();
  const alt = seedRepo(path.join(b.home, "alt-mcp-web")); // beda dari $HOME/mcp-web
  const altPlug = path.join(alt, "plugin", "browser-mcp");
  const r1 = run(INSTALL, [b.cfg], { __home: b.home, MCP_WEB_DIR: alt });
  assert.equal(r1.status, 0, fail(r1));
  let c = read(b.cfg);
  assert.ok(c.plugins.includes(altPlug), "entri plugin terpasang di path alternatif");

  // entri plugin PIHAK KETIGA (bukan mcp-web) wajib selamat — pengenalan pola,
  // bukan string path persis (jangan over-delete)
  const foreign = "/lain/proyek/plugin/browser-mcp";
  c.plugins.push(foreign);
  fs.writeFileSync(b.cfg, JSON.stringify(c, null, 2) + "\n");

  // mode piped, cwd = direktori kosong BUKAN repo, TANPA MCP_WEB_DIR →
  // hitungan $PLUG script salah (=$HOME/mcp-web/...) beda dari yang terpasang
  const cwdOther = fs.mkdtempSync(path.join(TMPBASE, "mw-piped-cwd-"));
  const r2 = runPiped(UNINSTALL, { __home: b.home }, cwdOther);
  assert.equal(r2.status, 0, fail(r2));
  assert.match(r2.stdout, /OK/, "verifikasi harus jujur (bukan OK palsu)");
  c = read(b.cfg);
  assert.ok(!c.plugins.includes(altPlug), "entri plugin alt HARUS hilang — dulu: tertinggal walau dilapor hilang");
  assert.ok(c.plugins.includes(foreign), "entri plugin pihak ketiga tetap ada (pola, bukan match persis)");
  assert.ok(c.plugins.includes("*"), "wildcard asli tetap ada");
  fs.rmSync(cwdOther, { recursive: true, force: true });
});

test("R6-4a (P3): timpa mcp.servers.web milik user + retype plugins string → PERINGATAN (bukan senyap), backup berisi isi lama", () => {
  const b = box();
  const orig = { mcp: { servers: { web: { type: "remote", url: "https://milik-saya" } } }, plugins: "opencode.milik-saya" };
  fs.writeFileSync(b.cfg, JSON.stringify(orig, null, 2) + "\n");
  const r = run(INSTALL, [b.cfg], { __home: b.home });
  assert.equal(r.status, 0, fail(r));
  assert.match(r.stdout, /PERINGATAN: menimpa mcp\.servers\.web yang sudah ada \(backup: /, "timpa web orang wajib bersuara + sebut path backup");
  assert.match(r.stdout, /PERINGATAN: plugins berbentuk string/, "retype plugins string→array wajib bersuara");
  const c = read(b.cfg);
  assert.deepEqual(c.mcp.servers.web.command.slice(0, 1), ["node"], "kini server mcp-web");
  assert.ok(Array.isArray(c.plugins) && c.plugins.includes("opencode.milik-saya"), "nilai plugins lama dipertahankan di dalam array");
  const bk = backups(b.cfg);
  assert.equal(bk.length, 1, "backup berisi isi lama utuh untuk pemulihan");
  assert.equal(read(path.join(path.dirname(b.cfg), bk[0])).mcp.servers.web.url, "https://milik-saya", "URL remote user ada di backup");
  // run ke-2: sudah milik kita → TIDAK ada peringatan timpa (idempoten, tanpa noise)
  const r2 = run(INSTALL, [b.cfg], { __home: b.home });
  assert.equal(r2.status, 0, fail(r2));
  assert.doesNotMatch(r2.stdout, /PERINGATAN: menimpa mcp\.servers\.web/, "peringatan hanya saat menimpa milik ORANG");
});

test("R6-4b (P3): mcp / mcp.servers berbentuk array → PERINGATAN + backup utuh (bukan hilang senyap / verifikasi gagal membingungkan)", () => {
  const b = box();
  fs.writeFileSync(b.cfg, JSON.stringify({ mcp: ["milik-1", "milik-2"] }, null, 2) + "\n");
  const r = run(INSTALL, [b.cfg], { __home: b.home });
  assert.equal(r.status, 0, fail(r));
  assert.match(r.stdout, /PERINGATAN: mcp berbentuk array/, "buang isi mcp array wajib bersuara");
  assert.ok(read(b.cfg).mcp.servers.web, "config kini object yang valid");
  const bk = backups(b.cfg);
  assert.equal(bk.length, 1);
  assert.deepEqual(read(path.join(path.dirname(b.cfg), bk[0])).mcp, ["milik-1", "milik-2"], "isi array lama utuh di backup");

  const b2 = box();
  fs.writeFileSync(b2.cfg, JSON.stringify({ mcp: { servers: ["a", "b"] } }, null, 2) + "\n");
  const r2 = run(INSTALL, [b2.cfg], { __home: b2.home });
  assert.equal(r2.status, 0, fail(r2)); // dulu: .web hilang saat stringify → VERIFIKASI GAGAL exit 4
  assert.match(r2.stdout, /PERINGATAN: mcp\.servers berbentuk array/, "servers array wajib bersuara sebelum di-set ulang");
  assert.ok(read(b2.cfg).mcp.servers.web, "mcp.servers.web tetap terpasang & terverifikasi");
});

test("R6-5 (P3): uninstall — server web BUKAN milik mcp-web dibiarkan + peringatan; backup HANYA bila config berubah", () => {
  const b = box();
  const foreignWeb = { type: "remote", url: "https://server-orang-lain" };
  fs.writeFileSync(b.cfg, JSON.stringify({ mcp: { servers: { web: { ...foreignWeb } } }, plugins: ["*"] }, null, 2) + "\n");
  const r = run(UNINSTALL, [b.cfg], { __home: b.home });
  assert.equal(r.status, 0, fail(r));
  const c = read(b.cfg);
  assert.deepEqual(c.mcp.servers.web, foreignWeb, "server web MILIK ORANG LAIN wajib dipertahankan");
  assert.match(r.stdout, /PERINGATAN: mcp\.servers\.web bukan milik mcp-web/, "penghapusan yang DITAHAN wajib bersuara");
  assert.match(r.stdout, /bersih/, "tak ada entri mcp-web yang dihapus");
  assert.equal(backups(b.cfg).length, 0, "config TAK BERUBAH → TANPA backup baru (tak menumpuk tiap run)");
  const r2 = run(UNINSTALL, [b.cfg], { __home: b.home });
  assert.equal(r2.status, 0, fail(r2));
  assert.equal(backups(b.cfg).length, 0, "uninstall berulang tetap tak menambah backup selama config tak berubah");
  assert.deepEqual(read(b.cfg).mcp.servers.web, foreignWeb, "run ke-2 juga tak menyentuh server orang lain");
});

test("R6-6 (P3): backup dgn timestamp SAMA → 2 file unik, backup pertama TIDAK tertimpa (jam beku NODE_OPTIONS)", () => {
  const b = box();
  const original = JSON.stringify({ model: "lama", plugins: ["*"] }, null, 2) + "\n";
  fs.writeFileSync(b.cfg, original);
  const frozen = { NODE_OPTIONS: "--require " + path.join(ROOT, "tests", "fixtures", "fake-clock.cjs") };
  assert.equal(run(INSTALL, [b.cfg], { __home: b.home, ...frozen }).status, 0);
  const first = backups(b.cfg);
  assert.equal(first.length, 1, "run-1: tepat 1 backup");
  const bakOf = (n) => path.join(path.dirname(b.cfg), n);
  assert.equal(fs.readFileSync(bakOf(first[0]), "utf8"), original, "backup-1 = isi lama persis");

  // Date.now() SAMA PERSIS (jam beku) → tanpa existsSync loop, copyFileSync
  // MENIMPA backup pertama dan jumlah file tetap 1 → test ini merah.
  assert.equal(run(INSTALL, [b.cfg], { __home: b.home, ...frozen }).status, 0);
  const second = backups(b.cfg);
  assert.equal(second.length, 2, "run-2 jam sama → file backup BARU (suffix .N), bukan 1 tertimpa");
  assert.equal(fs.readFileSync(bakOf(first[0]), "utf8"), original, "backup pertama TETAP utuh (isi lama, tak tertimpa run-2)");

  const u = run(UNINSTALL, [b.cfg], { __home: b.home, ...frozen });
  assert.equal(u.status, 0, fail(u));
  assert.equal(backups(b.cfg).length, 3, "uninstall dgn jam sama → mekanisme unik yang sama (.bak.<ts>.N)");
});

test("R6-7 (P3): jalur fallback $HOME/mcp-web (piped, cwd ≠ repo, TANPA jaringan) — jalur README satu baris", () => {
  const b = box();
  seedRepo(path.join(b.home, "mcp-web")); // repo seed lokal → is_repo lolos tanpa clone
  const cwd = fs.mkdtempSync(path.join(TMPBASE, "mw-fallback-cwd-")); // bukan repo, bukan HOME
  // MCP_WEB_REPO mustahil: bila fallback rusak & script nekat `git clone` → exit 2
  // TANPA menyentuh jaringan (path lokal tak ada) → test merah, bukan lolos ke GitHub.
  const r = runPiped(INSTALL, { __home: b.home, MCP_WEB_REPO: "/nonexistent-mcp-web.git" }, cwd);
  assert.equal(r.status, 0, fail(r));
  assert.match(r.stdout, /repo\s+: /, "repo terdeteksi");
  assert.doesNotMatch(r.stdout, /clone/, "fallback $HOME/mcp-web ketemu → TANPA clone");
  const c = read(b.cfg);
  assert.ok(c.mcp.servers.web, "install sukses lewat jalur fallback");
  assert.ok(c.plugins.includes(path.join(b.home, "mcp-web", "plugin", "browser-mcp")), "path plugin = $HOME/mcp-web (fallback), bukan cwd");
  assert.ok(!fs.existsSync(path.join(cwd, "package.json")), "cwd TIDAK dijadikan repo");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("R6-8 (P3): config = DIREKTORI → exit 5 (bukan 1), pesan [install] GAGAL di stderr, tanpa stack Node mentah", () => {
  const b = box();
  const dirCfg = path.join(b.home, "bukan-json-dir");
  fs.mkdirSync(dirCfg, { recursive: true });
  const r = run(INSTALL, [dirCfg], { __home: b.home });
  assert.equal(r.status, 5, `baca/tulis config gagal = kode KELIRU 5, bukan 1 (argumen) — ${fail(r)}`);
  assert.match(r.stderr, /\[install\] GAGAL: .*EISDIR/, "pesan standar [install] GAGAL ke stderr");
  assert.doesNotMatch(r.stderr, /at \[eval\]/, "stack trace Node mentah TIDAK boleh bocor ke user");
  assert.doesNotMatch(r.stderr, /Node\.js v\d/, "banner versi Node TIDAK boleh ikut");
  assert.doesNotMatch(r.stdout, /VERIFIKASI OK/, "verifikasi tak dijalankan saat config gagal dibaca");
});

test("B3 (P3 r7): folder proyek LAIN bernama *-mcp-web dengan struktur plugin identik TIDAK ikut terhapus (identitas = web command, bukan pola longgar)", () => {
  const b = box();
  const r1 = run(INSTALL, [b.cfg], { __home: b.home, MCP_WEB_DIR: ROOT });
  assert.equal(r1.status, 0, fail(r1));
  let c = read(b.cfg);
  assert.ok(c.plugins.includes(PLUG), "entri milik mcp-web terpasang");
  // proyek lain: namanya mengandung "mcp-web" + ujung "/plugin/browser-mcp"
  // identik — pola longgar `includes("mcp-web")` ikut menelannya (B3 VERDICT r7)
  const other = path.join(b.home, "proyek-lain-mcp-web", "plugin", "browser-mcp");
  c.plugins.push(other);
  fs.writeFileSync(b.cfg, JSON.stringify(c, null, 2) + "\n");

  const r2 = run(UNINSTALL, [b.cfg], { __home: b.home, MCP_WEB_DIR: ROOT });
  assert.equal(r2.status, 0, fail(r2));
  c = read(b.cfg);
  assert.ok(!c.plugins.includes(PLUG), "entri milik mcp-web harus hilang");
  assert.ok(c.plugins.includes(other), "entri proyek-lain-mcp-web harus SELAMAT — dulu ikut terhapus (B3 r7)");
  assert.match(r2.stdout, /OK/, "verifikasi tetap jujur");
});
