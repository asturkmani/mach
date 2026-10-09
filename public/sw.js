// Mach's service worker. It keeps three things:
// - the offline screen, shown when a page can't load because there's no connection;
// - the app's built files (/_next/static, named by their content so they never
//   change), so an installed app opens fast;
// - push notifications: "#12 needs your answer" while Mach is closed, opening
//   the task when tapped, and the count of what waits on you on the app's icon.
// Pages and data always come from the network: nothing about the company is
// stored on the device.

const VERSION = "mach-v2";
const OFFLINE = "/offline.html";
const PRECACHE = [OFFLINE, "/icons/icon-192.png", "/icons/badge-96.png"];

/** Each deploy brings new file names: keep the newest few hundred, never the precached ones. */
async function trim(cache, keep = 400) {
  const keys = (await cache.keys()).filter((request) => new URL(request.url).pathname.startsWith("/_next/static/"));
  await Promise.all(keys.slice(0, Math.max(0, keys.length - keep)).map((request) => cache.delete(request)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) event.waitUntil(cache.put(request, response.clone()).then(() => trim(cache)));
        return response;
      }),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.match(OFFLINE)) ?? Response.error()));
  }
});

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { title: "Mach", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      if (typeof message.badge === "number" && self.navigator.setAppBadge) {
        await (message.badge > 0 ? self.navigator.setAppBadge(message.badge) : self.navigator.clearAppBadge()).catch(() => {});
      }
      if (!message.title) return;
      await self.registration.showNotification(message.title, {
        body: message.body ?? "",
        tag: message.tag,
        renotify: Boolean(message.tag),
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        data: { url: message.url ?? "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Use the open app if there is one, rather than starting another.
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ("navigate" in open) return open.navigate(target).catch(() => open.postMessage({ type: "mach:open", path: new URL(target).pathname }));
        return;
      }
      return self.clients.openWindow(target);
    })(),
  );
});
