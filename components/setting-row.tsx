import type { ReactNode } from "react";

/** A settings page's block: a heading, an optional line about it, and its rows. */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      {title && <h2 className="text-[17px] font-medium tracking-tight">{title}</h2>}
      {description && <p className="mt-1 max-w-xl text-sm text-muted">{description}</p>}
      <div className={`divide-y divide-line-soft border-y border-line ${title || description ? "mt-4" : ""}`}>{children}</div>
    </section>
  );
}

/**
 * One line of a settings list: what it is on the left, its action on the
 * right. Anything that opens up (a confirmation, a form) goes in children.
 */
export function SettingRow({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-[15px]">{title}</p>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
    </div>
  );
}
