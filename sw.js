/**
 * sw.js
 * Service worker for the Naada Tarangini website.
 *
 * It exists for one reason: browsers only offer "Install app" once the site has
 * a service worker with a fetch handler. Without one there is no install prompt.
 *
 * It deliberately caches NOTHING. The UI is served with no-store precisely so a
 * deploy is never shadowed by an old build, and a caching worker would undo
 * that: a user would keep a player that no longer matches the server. Every
 * request is passed straight through to the network, and the old cache is
 * cleared on activate so nothing registered by an earlier version survives.
 *
 * Note what this is and is not. Installing the PWA gives a standalone window
 * with an app icon and its own taskbar entry. It does NOT give the always-on-top
 * window, the system tray, the desktop shortcut or the snap corners — those are
 * Electron capabilities, and only the real desktop app has them. The install
 * dialog in main.js says so rather than implying otherwise.
 */

self.addEventListener("install", () => {
  // No precache: taking over immediately is the whole point.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  // Pass through. Answering from the cache is exactly what must not happen.
  event.respondWith(fetch(event.request));
});
