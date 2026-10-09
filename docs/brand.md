# Brand

Mach is named for speed. Its brand comes from the Bell X-1, the first aircraft past Mach 1 (14 October 1947), and from that aircraft's colour, International Orange, which is the app's accent.

## The two marks

| | What | Where | Files |
|---|---|---|---|
| **Mark** | A forward-leaning M flying inside its shock cone, the orange square as its nose, on ink | Square places: app icons, the browser tab, the left and phone menus, the offline screen, the WhatsApp profile photo | `public/brand/mach-logo.svg` (+ `.png`, 1024px), `MachMark` in `components/brand.tsx` |
| **Small mark** | The same M and nose, larger, without the cone lines (they disappear below about 48px) | The favicon (16–48px) | `public/brand/mach-logo-small.svg` |
| **Lockup** | The X-1 in profile leading the word "Mach" (Geist, medium) | Wherever there's width: the sign-in and welcome pages, emails, WorkOS's pages, a website | `public/brand/mach-lockup.svg` / `-dark.svg` (+ `.png`), `MachLockup` in `components/brand.tsx` |

The X-1 in the lockup is the same drawing that flies across the screen when a task is done (`X1Plane`, `components/shell/flyby.tsx`). Keep the lockup and the easter egg one plane.

## Rendering the icons

The PNGs and `app/favicon.ico` are rendered from the SVGs with headless Chromium:
- `app/icon.png` 512px and `app/apple-icon.png` 180px, from the mark.
- `public/icons/icon-*`, from the mark.
- `public/icons/maskable-*`, the mark at 72% so Android's shaped masks don't clip it.
- `public/icons/badge-96.png`, a white silhouette of the M and nose for Android's status bar.
- `app/favicon.ico` (16, 32 and 48px), from the small mark.

After changing them, bump `VERSION` in `public/sw.js`, so installed apps fetch the new icons.

## Using it elsewhere

- **WorkOS** (Branding, in its dashboard): `mach-logo.png` as the icon and `mach-lockup.png` as the logo, so sign-in codes, invitations and its fallback sign-in page match.
- **WhatsApp:** set `mach-logo.png` as the Chief of Staff's profile photo on the Twilio WhatsApp sender.
