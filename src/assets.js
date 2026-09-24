// Batas waktu fetch aset screenshot (stylesheet <link> & <img>) — SATU sumber
// angka untuk engine-js (ensureStyles) dan render-shot (loadImages).
// P1 critic R4: fetch aset dulu TANPA signal/timeout → aset yang tak pernah
// merespons GANTUNGKAN screenshot ±301 detik (batas alam undici) dan
// menyumbat antrian serial stdio — SEMUA tool terblokir. Kini 10 detik:
// gagal = render LANJUT tanpa aset itu + catatan jujur `notes`, BUKAN gantung.
export const ASSET_TIMEOUT_MS = 10000
