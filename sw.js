/* ぺたろぐ service worker
   - アプリ本体（画面のファイル・ライブラリ・フォント）を端末に保存して、電波やサーバーの調子が悪くても開けるようにする
   - 画面のファイルは「まずネット、だめなら保存分」なので、更新はすぐ届く
   - 記録のデータ（Supabase）や地図のタイルはここでは扱わない */
const V = "petalog-44e42a5dea";
const SHELL = ["./", "./index.html", "./cloud.js", "./vendor/supabase.js", "./vendor/leaflet.js", "./vendor/matter.min.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
const LIBS = /^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("petalog-") && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true }).then(m => m || (req.mode === "navigate" ? caches.match("./index.html").then(x => x || caches.match("./")) : null));
}
// network first, but do not wait forever: after 4 s use the saved copy if there is one
function networkFirst(req) {
  return new Promise(resolve => {
    let done = false; const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => fromCache(req).then(finish), 4000);
    // ブラウザの一時保存（最大10分）を使わず、毎回サーバーに新しい版を確認する
    fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(res => {
      clearTimeout(timer);
      if (res && res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(req, copy)).catch(() => {}); }
      if (res && res.ok) finish(res); else fromCache(req).then(m => finish(m || res));
    }).catch(() => { clearTimeout(timer); fromCache(req).then(m => { if (!done) { done = true; resolve(m || Response.error()); } }); });
  });
}
function cacheFirst(req) {
  return caches.match(req).then(m => m || fetch(req).then(res => { if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(V).then(c => c.put(req, copy)).catch(() => {}); } return res; }));
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req)); return; }
  if (LIBS.test(req.url)) e.respondWith(cacheFirst(req));
});
