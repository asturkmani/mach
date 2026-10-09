// Mach1's brand is the Bell X-1, the first aircraft past Mach 1, in profile:
// - The mark, for square places (the app icon, the browser tab, the menu):
//   the plane flying across a dark tile. The same drawing as
//   public/brand/mach-logo.svg (the app icons and the WhatsApp profile photo
//   are rendered from that file).
// - The lockup, wherever there's width: the plane leading the word "Mach1".
// It's the same plane that flies across the screen when a task is done
// (components/shell/flyby.tsx).

export function MachMark({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect width="1024" height="1024" fill="#1c1b19" />
      <svg x="44" y="356" width="936" height="312" viewBox="0 0 78 26">
        <X1Paths cone="#fbfaf8" />
      </svg>
    </svg>
  );
}

/** The plane's shapes in its 78 by 26 box; the cone and exhaust lines take the given colours. */
function X1Paths({ cone = "var(--faint)", exhaust = "var(--accent)" }: { cone?: string; exhaust?: string }) {
  return (
    <>
      {/* The Mach cone off the nose. */}
      <path d="M73 13 Q56 6 30 1 M73 13 Q56 20 30 25" stroke={cone} strokeWidth="0.6" strokeLinecap="round" opacity="0.4" fill="none" />
      {/* Exhaust. */}
      <path d="M2 13.5 H11" stroke={exhaust} strokeWidth="1.6" strokeLinecap="round" opacity="0.45" fill="none" />
      {/* Tail fin and stabiliser. */}
      <path d="M14 12 L17 3 H22 L24 11 Z" fill="#c9581f" />
      <path d="M13 14 L25 14 L22 16 L15 16 Z" fill="#b84f1b" />
      {/* Fuselage: a .50-calibre bullet, which is what it was shaped after. */}
      <path d="M11 11 H52 C62 11 68 12 72 13.2 C68 14.6 62 16 52 16 H11 C10 16 10 11 11 11 Z" fill="#e8732a" />
      {/* Canopy, flush with the nose. */}
      <path d="M53 11.2 C56 10 59 10.2 61 11.6" stroke="#f6c39c" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      {/* The straight, thin wing. */}
      <path d="M33 14.5 L46 14.5 L43 18.5 L36 18.5 Z" fill="#b84f1b" />
    </>
  );
}

/** The X-1 in profile, nose right: a bullet of a fuselage, straight wing, tall fin, and its shock cone. 78 by 26 at width 78. */
export function X1Plane({ width = 78, className = "" }: { width?: number; className?: string }) {
  return (
    <svg width={width} height={(width * 26) / 78} viewBox="0 0 78 26" fill="none" aria-hidden="true" className={`shrink-0 ${className}`}>
      <X1Paths />
    </svg>
  );
}

/** The plane leading the word "Mach1". `size` is the word's height in px. */
export function MachLockup({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-[0.4em] ${className}`} style={{ fontSize: size }} aria-label="Mach1">
      <X1Plane width={Math.round(size * 3.4)} />
      <span aria-hidden="true" className="font-medium tracking-tight text-ink">
        Mach1
      </span>
    </span>
  );
}
