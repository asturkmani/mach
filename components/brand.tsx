// Mach's mark: a forward-leaning M with the accent square as its full stop.
// The same drawing as public/brand/mach-logo.svg (the app icons and the
// WhatsApp profile photo are rendered from that file).
export function MachMark({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} aria-hidden="true" className={`shrink-0 ${className}`}>
      <rect width="1024" height="1024" fill="#1c1b19" />
      <g transform="translate(498 512) skewX(-12) translate(-512 -512)">
        <path fill="#fbfaf8" d="M262 712V312h120l130 170 130-170h120v400H652V482L512 662 372 482v230z" />
      </g>
      <rect x="742" y="640" width="72" height="72" fill="#d4521c" />
    </svg>
  );
}
