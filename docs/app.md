# Mach as an app on your phone

Mach is a progressive web app: install it from the browser and it behaves like a native app. There's nothing to download from an app store, and every deploy reaches it straight away.

## Installing

- **iPhone and iPad (Safari):** tap Share, then **Add to Home Screen**. Menu → Get notifications explains this too.
- **Android (Chrome), and Chrome or Edge on a computer:** Menu → **Install the app** (also in Settings → Account), or the install button in the address bar.

Installed, Mach opens full screen with its own icon. The status bar takes Mach's colours in light and dark, and pages sit clear of the notch and the home bar. A long press on the icon offers **New task** and **Chief of Staff**.

## What the app does

- **Push notifications**, even with Mach closed: when a task starts waiting on you or is ready for your review, and when someone @-mentions you. Tapping one opens the task. Turn them on per device in Menu, or in Settings → Account. On an iPhone they need the installed app (iOS 16.4 or later).
- **A badge on the icon** with the number of things waiting on you, kept up to date by the open app and by every notification.
- **Share to Mach:** share text or a link from any app's share sheet, and it opens the Chief of Staff with it drafted (Android, from the installed app).
- **Offline:** a page that can't load shows an offline screen that reloads itself when the connection is back. While you're in the app, a line at the top says you're offline, and what you do waits and goes through when you're back (Next's `experimental.useOffline`).
- **Touch:** fields don't zoom in when tapped, taps don't flash, and the app doesn't rubber-band or pull to refresh as a whole. Lists scroll inside it, and toasts sit above the tab bar.

## How it works

| Part | Where |
|---|---|
| Manifest: name, icons (including maskable ones for Android), shortcuts, share target | `app/manifest.ts`, `public/icons/` |
| Service worker: offline screen, cache of the app's built files (`/_next/static`, named by content), push and notification taps | `public/sw.js`, `public/offline.html` |
| Registering the worker (production builds only), install, push subscribe, badge, offline line | `components/shell/device.tsx` |
| Turning notifications on, wherever it's offered | `components/shell/notifications.tsx` |
| Shortcuts and shares arriving as `/?do=…` or `/?share_text=…` | `components/shell/url-actions.tsx` |
| Devices and sending | `lib/push.ts`, table `push_subscriptions` |

**Nothing about the company is stored on the device.** The service worker caches only the offline screen, icons and the app's code. Pages and data always come from the network. The proxy lets the manifest, worker, icons and offline screen load before sign-in.

**Sending.** `updateTask` notices a task changing into *waiting* or *review* and notifies its people. `addMention` notifies the person mentioned. Each person's devices get the message with their inbox count for the badge. The push itself is a workflow step (`deliverPushes`), because agent runs change tasks from inside workflows, which can't load `web-push`. A device the push service reports as gone (404/410) is forgotten. Delivery never throws, so a notification can't break the work that caused it. A device with push on isn't also notified by the open app, so nothing arrives twice.

## Setting up push

1. Generate a key pair once: `npx web-push generate-vapid-keys`.
2. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in the Vercel project (Production and Preview) and in `.env.local`. Optionally set `VAPID_SUBJECT` (a `mailto:` or `https:` contact). It defaults to the app's URL.
3. Redeploy. Menu → Turn on notifications now subscribes the device.

Keep the same key pair: changing it orphans every device that subscribed with the old one, until each turns notifications on again. Without the keys, Mach offers the browser's own notifications instead, which only appear while Mach is open in a tab.

## Not covered (yet)

- App store listings. Mach could be wrapped for the App Store and Play Store (Capacitor, or a Trusted Web Activity on Android), but that needs Apple and Google developer accounts.
- Sharing files or photos into Mach. The share target takes text and links. Files would need a POST share target that uploads them.
- Using Mach offline beyond the offline screen: reading tasks without a connection would mean storing company data on the device, which Mach deliberately doesn't.
