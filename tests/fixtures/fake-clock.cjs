// Jam BEKU — fixture test utk mekanisme nama backup UNIK (P3 R6 temuan 6).
// Dipakai lewat NODE_OPTIONS="--require <file ini>" pada CHILD test saja:
// semua `node -e` install.sh/uninstall.sh menghitung Date.now() SAMA →
// loop existsSync wajib menambah suffix `.N` (backup tak boleh tertimpa).
// Tanpa guard unik, dua run menulis file backup yang SAMA → test ini merah.
// Sengaja TIDAK menambah seam/env khusus di kode produksi.
Date.now = () => 1790000000000
