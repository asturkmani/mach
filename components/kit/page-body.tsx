// A page's scrolling body under its header: the same side margins everywhere
// (16px on a phone, 32px from small tablets up) and a readable width.

const WIDTHS = { "3xl": "max-w-3xl", "4xl": "max-w-4xl", "5xl": "max-w-5xl" } as const;

export function PageBody({
  width = "4xl",
  className = "",
  children,
}: {
  width?: keyof typeof WIDTHS;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className={`mx-auto px-4 py-6 sm:px-8 md:py-8 ${WIDTHS[width]} ${className}`}>{children}</div>
    </div>
  );
}
