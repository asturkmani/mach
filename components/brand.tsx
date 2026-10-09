// Mach's brand, in two parts:
// - The mark, for square places (the app icon, the browser tab, the menu): a
//   forward-leaning M flying inside its shock cone, the accent square as its
//   nose. The same drawing as public/brand/mach-logo.svg (the app icons and
//   the WhatsApp profile photo are rendered from that file).
// - The lockup, wherever there's width: the Bell X-1, the first aircraft past
//   Mach 1, leading the word. The same plane flies across the screen when a
//   task is done (components/shell/flyby.tsx); public/brand/mach-lockup.svg.

export function MachMark({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect width="1024" height="1024" fill="#1c1b19" />
      <path d="M880 512L60 39M880 512L60 985" stroke="#fbfaf8" strokeOpacity="0.32" strokeWidth="26" fill="none" />
      <g transform="translate(560 512) scale(0.76) translate(-772 -512)">
        <g transform="translate(498 512) skewX(-12) translate(-512 -512)">
          <path fill="#fbfaf8" d="M262 712V312h120l130 170 130-170h120v400H652V482L512 662 372 482v230z" />
        </g>
      </g>
      <rect x="836" y="468" width="88" height="88" fill="#ec4800" />
    </svg>
  );
}

/** The X-1 in profile, nose right: a bullet of a fuselage, straight wing, tall fin, and its shock cone. 78 by 26 at width 78. */
export function X1Plane({ width = 78, className = "" }: { width?: number; className?: string }) {
  return (
    <svg width={width} height={(width * 26) / 78} viewBox="0 0 78 26" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      {/* The Mach cone off the nose. */}
      <path d="M73 13 Q56 6 30 1 M73 13 Q56 20 30 25" stroke="var(--faint)" strokeWidth="0.6" strokeLinecap="round" opacity="0.4" />
      {/* Exhaust. */}
      <path d="M2 13.5 H11" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" opacity="0.45" />
      {/* Tail fin and stabiliser. */}
      <path d="M14 12 L17 3 H22 L24 11 Z" fill="#c9581f" />
      <path d="M13 14 L25 14 L22 16 L15 16 Z" fill="#b84f1b" />
      {/* Fuselage: a .50-calibre bullet, which is what it was shaped after. */}
      <path d="M11 11 H52 C62 11 68 12 72 13.2 C68 14.6 62 16 52 16 H11 C10 16 10 11 11 11 Z" fill="#e8732a" />
      {/* Canopy, flush with the nose. */}
      <path d="M53 11.2 C56 10 59 10.2 61 11.6" stroke="#f6c39c" strokeWidth="1.2" strokeLinecap="round" />
      {/* The straight, thin wing. */}
      <path d="M33 14.5 L46 14.5 L43 18.5 L36 18.5 Z" fill="#b84f1b" />
    </svg>
  );
}

/** The plane leading the word "Mach". `size` is the word's height in px. */
export function MachLockup({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[0.4em] ${className}`} style={{ fontSize: size }} aria-label="Mach">
      <X1Plane width={Math.round(size * 3.4)} />
      <span aria-hidden="true" className="font-medium tracking-tight text-ink">
        Mach
      </span>
    </span>
  );
}
