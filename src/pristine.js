// src/pristine.js — SATU sumber kebenaran untuk global proses SEBELUM patch.
//
// Engine js (src/engine-js.js) mem-patch `globalThis` (document/window/fetch/…)
// per SESI dan kini berswap PEMILIK (P1 R6) — patch boleh hidup lama setelah
// navigate. Konsumen yang TIDAK boleh terpengaruh:
//   - src/browser.js   : navigate engine dom memanggil fetch;
//   - src/render-shot.js: fallback fetch gambar utk engine dom;
//   - src/engine-js.js : `page._fetch` harus fetch ASLI, bukan hasil patch.
// Dulu mereka memakai `fetch` telanjang → navigate dom bisa membawa fetch milik
// sesi js lain / stub test (bleed silang-engine; bukti regresi:
// tests/abort-mislabel.test.js P2-3 "port mati → navigate dom wajib gagal").
//
// Modul ini di-import lewat rantai STATIS dari boot (tools.js → browser.js;
// engine-js.js; render-shot.js) → dijalankan SEBELUM navigasi/patch apa pun,
// sama seperti jaminan ORIGINAL_FETCH lama.
export const PRISTINE_FETCH = globalThis.fetch.bind(globalThis)
