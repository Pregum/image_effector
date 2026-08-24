// ネットワーク優先・キャッシュフォールバックのシンプルなSW。
// キャッシュはオフライン時の保険にのみ使うため、デプロイ後の古い殻を配ることはない。
const CACHE = "noizlab-shell-v3";
const SHELL = ["/", "/style.css", "/app.js", "/project-format.js", "/manifest.json", "/icon-192.png", "/icon-512.png", "/icon-1024.png", "/og.png", "/about", "/about-en", "/about.css", "/i18n.js", "/analytics.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("noizlab-shell-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 同一オリジンのGETかつシェル資産のみ対象。/api/ は一切触らない
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // APIは一切キャッシュしない（構成情報や作品データが古いまま配られないように）
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
