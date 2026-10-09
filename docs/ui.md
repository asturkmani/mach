# Building the interface

Mach1 is used on computers and phones equally, so every screen is built from
pieces that already work on both. They live in `components/kit` (import from
`@/components/kit`). Write a screen with them instead of hand-rolling tables,
dialogs, tabs or page containers; if a screen needs something new, add it to
the kit so the next screen gets it for free.

| Piece | On a computer | On a phone |
| --- | --- | --- |
| `PageBody` | The page's scrolling body: centred, a readable width (`3xl`, `4xl`, `5xl`) | Same, with 16px side margins |
| `Section` | A heading with a count, an optional description, and an add button that opens its form in place. The form closes itself with `useCloseForm()` once it's done | Same |
| `DataTable`, `DataRow`, `DataCell` | A table with a header row | A stack of cards: the `main` cell leads, `label`led cells show as "LABEL value" lines, `end` cells (buttons) close the card |
| `Segmented` | A row of options, one picked: links (the choice is in the URL) or buttons | Taller, for a thumb |
| `Sheet` | A dialog near the top of the screen | A sheet that rises from the bottom, above the tab bar |

The CSS classes in `app/globals.css` carry the rest: `.btn` (40px tall on
touch screens, without keyboard hints), `.field` (16px text on touch screens,
so iPhones don't zoom in), `.label`, `.frame`.

## Rules of thumb

- **Check every change at 390px wide** as well as on a computer. Nothing may
  scroll sideways except things that are meant to (the board's columns, a
  spreadsheet preview).
- **Phone first for anything tapped:** at least 40px tall, with room around it.
- **Breakpoints:** `md` (768px) is where the phone layout ends: the tab bar,
  full-screen Chief of Staff and card lists. Use `max-md:` for phone-only
  styles and `md:` for computer-only ones.
- **Heights:** the app's full height is `var(--app-height)` and the tab bar's
  is `var(--nav-height)`, never `100vh`/`100dvh` directly. See below.

## The iPhone's screen height

iOS 26 home-screen apps report the screen (`100dvh`, `innerHeight`) short by
the status bar's height, which left an empty band under the tab bar. In that
case `--app-height` is `100lvh`, the whole screen, and `body` becomes the
containing block for fixed elements so the tab bar and sheets reach the real
bottom edge. An iPhone also lays its keyboard over the page without resizing
it: while the keyboard is up (`html.keyboard-open`, set by
`useKeyboardViewport` in `components/shell/device.tsx`), the app is sized to
what's visible above it and the tab bar steps aside (`.hide-with-keyboard`).
