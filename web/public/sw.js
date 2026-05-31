/* codeclone service worker — offline shell. */
const VERSION = "v1";
const SHELL_CACHE = `codeclone-shell-${VERSION}`;
const RUNTIME_CACHE = `codeclone-runtime-${VERSION}`;

const SHELL_URLS = [
  "/",
  "/offline",
  "/manifest.webmanifest",
  "/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Best-effort: don't fail install if a single URL 404s during dev.
      Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(url).catch(() => undefined),
        ),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API/SSE/streaming routes; let them hit the network or fail.
  if (url.pathname.startsWith("/api/")) return;

  const isHTML =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          const offline = await caches.match("/offline");
          if (offline) return offline;
          return new Response(
            "<!doctype html><meta charset=utf-8><title>offline</title><body style=\"font:14px ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px;color:#1A1A1F;background:#FAFAF7\"><h1 style=\"font-size:16px;text-transform:uppercase;letter-spacing:.14em\">offline</h1><p>codeclone cannot reach the network. Reconnect and reload.</p></body>",
            { headers: { "content-type": "text/html; charset=utf-8" }, status: 503 },
          );
        }),
    );
    return;
  }

  // Static assets: cache-first, fall back to network, then cache the response.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req)
          .then((res) => {
            if (res && res.ok && res.type === "basic") {
              const copy = res.clone();
              caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
            }
            return res;
          })
          .catch(() => cached || Response.error()),
    ),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
