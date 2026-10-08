"use client";

import {
  Bell,
  BellOff,
  Building,
  ChevronDown,
  FolderOpen,
  House,
  LogOut,
  Monitor,
  Moon,
  PanelsTopLeft,
  Search,
  Settings,
  Sun,
  UserPlus,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { signOutAction } from "@/app/(app)/actions";
import { Elapsed, TypingDots } from "@/components/agent-status";
import { MachMark } from "@/components/brand";
import { Face } from "@/components/ui";

import { useNotificationPermission } from "./inbox-notifier";
import { useShell, type ShellData } from "./shell";

// The left menu: a column of icons that widens into labels while the pointer
// (or keyboard focus) is on it, or while one of its menus is open, laid over
// the page rather than pushing it. It lists only the places people go every
// day. The company's profile and settings are in the company menu at the top,
// and your own settings in the menu under your name. New task, commands and
// the Chief of Staff are buttons in each page's header.

type Item = { href: string; label: string; icon: LucideIcon; count?: number; accent?: boolean };

/** The places people go every day, after Home: in the left menu and the phone's menu sheet. */
export const MAIN_PAGES: Item[] = [
  { href: "/pages", label: "Pages", icon: PanelsTopLeft },
  { href: "/team", label: "Team", icon: Users },
  { href: "/files", label: "Files", icon: FolderOpen },
];

/** The company menu's pages, also in the phone's menu sheet. */
export const COMPANY_LINKS: Item[] = [
  { href: "/company", label: "Company profile", icon: Building },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/tasks/");
  // An agent's own page is part of the team.
  if (href === "/team") return pathname === "/team" || pathname.startsWith("/agents/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function themeLabel(theme: string): string {
  return `Theme: ${theme === "system" ? "match system" : theme}`;
}

export function ThemeIcon({ theme, size }: { theme: string; size: number }) {
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return <Icon size={size} strokeWidth={1.6} className="shrink-0" />;
}

export function Rail() {
  const pathname = usePathname();
  const { data, openPalette, theme, setTheme, toast } = useShell();
  const notifications = useNotificationPermission();

  // One menu open at a time; going somewhere, clicking elsewhere or Esc closes it.
  const [menu, setMenu] = useState<"company" | "account" | null>(null);
  const [menuFor, setMenuFor] = useState(pathname);
  if (menuFor !== pathname) {
    setMenuFor(pathname);
    setMenu(null);
  }
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onPointer = (e: MouseEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const row = "flex h-10 w-full items-center gap-3 px-[17px] text-[15px] whitespace-nowrap";
  const text =
    "opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100 group-data-[menu=open]/rail:opacity-100";

  const link = (item: Item) => {
    const active = isActive(pathname, item.href);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-label={item.label}
        className={`${row} relative border ${
          active ? "border-line bg-selected text-ink" : "border-transparent text-muted hover:bg-hover hover:text-ink"
        }`}
      >
        <Icon size={18} strokeWidth={1.6} className="shrink-0" />
        <span className={`${text} flex-1`}>{item.label}</span>
        {item.count ? (
          <>
            <span className={`${text} font-mono text-sm ${item.accent ? "text-accent" : "text-faint"}`}>{item.count}</span>
            {item.accent && (
              <span className="absolute left-[30px] top-[9px] h-1.5 w-1.5 rounded-full bg-accent group-hover/rail:opacity-0 group-has-[:focus-visible]/rail:opacity-0 group-data-[menu=open]/rail:opacity-0" />
            )}
          </>
        ) : null}
      </Link>
    );
  };

  const toggleNotifications = async () => {
    if (notifications.state === "granted") return toast("Notifications are on. Turn them off in your browser's site settings.");
    const result = await notifications.request();
    toast(
      result === "granted"
        ? "You'll get a notification when something needs you."
        : "Notifications are blocked. Allow them for this site in your browser's settings.",
    );
  };

  return (
    <nav ref={navRef} aria-label="Main" data-menu={menu ? "open" : undefined} className="group/rail relative z-30 hidden w-[60px] shrink-0 md:block">
      <div className="absolute inset-y-0 left-0 flex w-[60px] flex-col border-r border-transparent bg-bg py-3 transition-[width,box-shadow,border-color] duration-200 group-hover/rail:w-60 group-hover/rail:border-line group-hover/rail:shadow-[var(--shadow)] group-has-[:focus-visible]/rail:w-60 group-has-[:focus-visible]/rail:border-line group-data-[menu=open]/rail:w-60 group-data-[menu=open]/rail:border-line group-data-[menu=open]/rail:shadow-[var(--shadow)]">
        <div className="relative mb-3 px-1.5">
          <button
            onClick={() => setMenu(menu === "company" ? null : "company")}
            aria-haspopup="menu"
            aria-expanded={menu === "company"}
            aria-label={`${data.organization.name}: company menu`}
            className="flex h-10 w-full items-center gap-3 overflow-hidden px-[9px] whitespace-nowrap hover:bg-hover"
          >
            <MachMark size={26} />
            <span className={`${text} min-w-0 flex-1 truncate text-left text-[15px] font-medium`}>{data.organization.name}</span>
            <ChevronDown size={15} className={`${text} shrink-0 text-faint`} />
          </button>
          {menu === "company" && (
            <MenuList className="top-full mt-1">
              {COMPANY_LINKS.map((page) => (
                <MenuLink key={page.href} href={page.href} icon={page.icon} label={page.label} />
              ))}
              {data.me.isAdmin && <MenuLink href="/team?new=person" icon={UserPlus} label="Add people" />}
            </MenuList>
          )}
        </div>

        <div className="overflow-hidden px-1.5">
          <button
            onClick={() => openPalette("search")}
            aria-label="Search"
            className={`${row} mb-4 border border-transparent px-[15px] text-muted hover:text-ink group-hover/rail:border-line group-has-[:focus-visible]/rail:border-line group-data-[menu=open]/rail:border-line`}
          >
            <Search size={17} strokeWidth={1.6} className="shrink-0" />
            <span className={`${text} label flex-1 text-left`}>Search</span>
            <span className={`${text} font-mono text-xs text-faint`}>/</span>
          </button>

          <div className="space-y-0.5">
            {link({ href: "/", label: "Home", icon: House, count: data.inboxCount, accent: true })}
            {data.working.length > 0 && <Working working={data.working} text={text} />}
            {MAIN_PAGES.map(link)}
          </div>
        </div>

        <div className="relative mt-auto px-1.5">
          {menu === "account" && (
            <MenuList className="bottom-full mb-1">
              <MenuLink href="/settings/account" icon={UserRound} label="Account settings" />
              <MenuItem
                label={themeLabel(theme)}
                icon={<ThemeIcon theme={theme} size={16} />}
                onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}
              />
              {notifications.state !== "unsupported" && (
                <MenuItem
                  label={notifications.state === "granted" ? "Notifications on" : "Turn on notifications"}
                  icon={notifications.state === "granted" ? <Bell size={16} strokeWidth={1.6} /> : <BellOff size={16} strokeWidth={1.6} />}
                  onClick={toggleNotifications}
                />
              )}
              <form action={signOutAction}>
                <MenuItem type="submit" label="Sign out" icon={<LogOut size={16} strokeWidth={1.6} />} />
              </form>
            </MenuList>
          )}
          <button
            onClick={() => setMenu(menu === "account" ? null : "account")}
            aria-haspopup="menu"
            aria-expanded={menu === "account"}
            aria-label={`${data.me.name}: account menu`}
            className={`${row} overflow-hidden px-[15px] text-muted hover:bg-hover hover:text-ink`}
          >
            <Face name={data.me.name} size={22} />
            <span className={`${text} min-w-0 flex-1 truncate text-left text-sm`}>{data.me.name}</span>
            <ChevronDown size={15} className={`${text} shrink-0 rotate-180 text-faint`} />
          </button>
        </div>
      </div>
    </nav>
  );
}

function MenuList({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <div role="menu" className={`absolute inset-x-1.5 z-10 border border-line bg-panel py-1 shadow-[var(--shadow)] ${className}`}>
      {children}
    </div>
  );
}

const menuRow = "flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-muted hover:bg-hover hover:text-ink";

function MenuLink({ href, icon: Icon, label }: { href: string; icon: LucideIcon; label: string }) {
  return (
    <Link href={href} role="menuitem" className={menuRow}>
      <Icon size={16} strokeWidth={1.6} className="shrink-0" />
      {label}
    </Link>
  );
}

function MenuItem({
  label,
  icon,
  onClick,
  type = "button",
}: {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} role="menuitem" onClick={onClick} className={menuRow}>
      {icon}
      {label}
    </button>
  );
}

/**
 * Agents working right now: three moving dots under Home while the menu is
 * narrow; widened, who is on which task and what they're doing.
 */
function Working({ working, text }: { working: ShellData["working"]; text: string }) {
  const label = `${working.length} agent${working.length === 1 ? "" : "s"} working`;
  return (
    <div className="mt-1" role="status" aria-label={label}>
      <div className="flex h-8 items-center gap-3 px-[17px] whitespace-nowrap text-accent" title={label}>
        <span className="flex w-[18px] shrink-0 justify-center">
          <TypingDots />
        </span>
        <span className={`${text} label flex-1 text-accent`}>{label}</span>
      </div>
      <ul className="hidden space-y-0.5 group-hover/rail:block group-has-[:focus-visible]/rail:block">
        {working.slice(0, 5).map((w) => (
          <li key={w.number}>
            <Link
              href={`/tasks/${w.number}`}
              tabIndex={-1}
              className="block px-[17px] py-1 text-xs whitespace-nowrap hover:bg-hover"
              title={`#${w.number} ${w.title}`}
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-faint">#{w.number}</span>
                <span className="min-w-0 flex-1 truncate">{w.agent}</span>
                <Elapsed since={w.since} className="text-faint" />
              </span>
              <span className="block truncate pl-0 text-muted">{w.activity || "Working"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
