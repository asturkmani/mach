"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The Settings pages: the company's, then your own. A column beside the page
// on a computer, a row of tabs above it on a phone.

const GROUPS = [
  {
    label: "Company",
    items: [
      { href: "/settings", label: "General" },
      { href: "/settings/integrations", label: "Integrations" },
      { href: "/settings/channels", label: "Channels" },
    ],
  },
  { label: "You", items: [{ href: "/settings/account", label: "Account" }] },
];

export function SettingsNav() {
  const pathname = usePathname();
  const active = (href: string) => (href === "/settings" ? pathname === href : pathname.startsWith(href));
  return (
    <nav aria-label="Settings" className="shrink-0 md:w-44">
      <div className="scroll-quiet flex gap-1 overflow-x-auto md:flex-col md:gap-5 md:overflow-visible">
        {GROUPS.map((group) => (
          <div key={group.label} className="flex shrink-0 gap-1 md:flex-col md:gap-0.5">
            <p className="label mb-1 hidden px-2.5 md:block">{group.label}</p>
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`whitespace-nowrap px-2.5 py-1.5 text-sm ${
                  active(item.href) ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
