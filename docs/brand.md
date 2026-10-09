# Brand

Mach1 is named for the moment an aircraft first flew faster than sound: the Bell X-1, past Mach 1 on 14 October 1947. The X-1 is the brand, and its colour, International Orange, is the app's accent.

## The marks

| | What | Where | Files |
|---|---|---|---|
| **Mark** | The X-1 in profile, flying across a dark tile with its shock cone | Square places: app icons, the left and phone menus, the offline screen, the WhatsApp profile photo | `public/brand/mach-logo.svg` (+ `.png`, 1024px), `MachMark` in `components/brand.tsx` |
| **Small mark** | The plane alone, as wide as the tile (its cone and exhaust would only blur) | The favicon (16–48px) | `public/brand/mach-logo-small.svg` |
| **Lockup** | The X-1 leading the word "Mach1" (Geist, medium) | Wherever there's width: the sign-in and welcome pages, emails, WorkOS's pages, the website | `public/brand/mach-lockup.svg` / `-dark.svg` (+ `.png`), `MachLockup` in `components/brand.tsx` |

Every one of them is the same drawing of the X-1 that flies across the screen when a task is done (`X1Paths` in `components/brand.tsx`, used by `components/shell/flyby.tsx`). Keep them one plane.

The name is **Mach1**, one word. "Mach 1", with a space, is only ever the speed, as in the X-1's flight.

## Rendering the icons

The PNGs and `app/favicon.ico` are rendered from the SVGs with headless Chromium:
- `app/icon.png` 512px and `app/apple-icon.png` 180px, from the mark.
- `public/icons/icon-*`, from the mark.
- `public/icons/maskable-*`, the mark at 72%, so Android's shaped masks don't clip it.
- `public/icons/badge-96.png`, a white silhouette of the plane for Android's status bar.
- `app/favicon.ico` (16, 32 and 48px), from the small mark.

After changing them, bump `VERSION` in `public/sw.js`, so installed apps fetch the new icons.

## Using it elsewhere

- **WorkOS** (Branding, in its dashboard): `mach-logo.png` as the icon and `mach-lockup.png` as the logo, so sign-in codes, invitations and its fallback sign-in page match.
- **WhatsApp:** set `mach-logo.png` as the Chief of Staff's profile photo on the Twilio WhatsApp sender.
