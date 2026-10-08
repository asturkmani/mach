"use client";

import { Bell, BellOff, House, LogOut, Menu, MessageSquare, Plus, Search, UserRound, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { signOutAction } from "@/app/(app)/actions";
import { Elapsed, Sweep } from "@/components/agent-status";
import { MachMark } from "@/components/brand";
import { Face } from "@/components/ui";

import { useNotificationPermission } from "./inbox-notifier";
import { COMPANY_LINKS, MAIN_PAGES, ThemeIcon, isActive, themeLabel } from "./rail";
import { useShell } from "./shell";

// A phone's navigation: a bar of the main actions at the bottom of the
// screen, and a menu sheet with the other pages, the company's profile and
// settings, and your account.

export function MobileNav() {
  const pathname = usePathname();
  const { data, cosOpen, setCosOpen, openNewTask, openPalette } = useShell();
  const [menu, setMenu] = useState(false);
  // Going somewhere closes the menu.
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setMenu(false);
  }

  const item = "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]";
  const home = isActive(pathname, "/") && !cosOpen && !menu;
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-50 flex h-[calc(3.5rem+env(safe-area-inset-bottom))] border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <Link
          href="/"
          onClick={() => {
            setCosOpen(false);
            setMenu(false);
          }}
          className={`${item} relative ${home ? "text-ink" : "text-muted"}`}
        >
          <House size={20} strokeWidth={1.6} />
          Home
          {data.inboxCount > 0 && (
            <span className="absolute top-1.5 left-1/2 ml-2 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-[10px] leading-4 text-on-accent">
              {data.inboxCount}
            </span>
          )}
        </Link>
        <button
          onClick={() => {
            setMenu(false);
            setCosOpen(!cosOpen);
          }}
          className={`${item} ${cosOpen ? "text-ink" : "text-muted"}`}
        >
          <MessageSquare size={20} strokeWidth={1.6} />
          Chief of Staff
        </button>
        <button
          onClick={() => {
            setMenu(false);
            setCosOpen(false);
            openNewTask();
          }}
          className={`${item} text-muted`}
        >
          <Plus size={21} strokeWidth={1.6} />
          New task
        </button>
        <button
          onClick={() => {
            setMenu(false);
            setCosOpen(false);
            openPalette("search");
          }}
          className={`${item} text-muted`}
        >
          <Search size={19} strokeWidth={1.6} />
          Search
        </button>
        <button
          onClick={() => {
            setCosOpen(false);
            setMenu(!menu);
          }}
          className={`${item} relative ${menu ? "text-ink" : "text-muted"}`}
          aria-expanded={menu}
        >
          {data.working.length > 0 && !menu ? (
            <span className="flex h-5 items-center">
              <Sweep inline />
            </span>
          ) : (
            <Menu size={20} strokeWidth={1.6} />
          )}
          Menu
        </button>
      </nav>
      {menu && <MenuSheet onClose={() => setMenu(false)} />}
    </>
  );
}

function MenuSheet({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const { data, theme, setTheme, toast } = useShell();
  const notifications = useNotificationPermission();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const row = "flex h-12 w-full items-center gap-3 px-5 text-[16px]";
  return (
    <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-label="Menu">
      <button aria-label="Close the menu" onClick={onClose} className="absolute inset-0 bg-black/30" />
      <div className="enter-rise absolute inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-h-[80dvh] overflow-y-auto border-t border-line bg-panel pb-2 shadow-[var(--shadow)]">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <p className="flex min-w-0 items-center gap-2.5">
            <MachMark size={24} />
            <span className="truncate text-[15px] font-medium">{data.organization.name}</span>
          </p>
          <button onClick={onClose} aria-label="Close" className="p-1 text-muted">
            <X size={18} />
          </button>
        </div>

        {data.working.length > 0 && (
          <div className="mx-5 mb-2 border border-line bg-raised py-1" role="status">
            <p className="label flex items-center gap-2 px-3 py-1.5 text-accent-ink">
              <Sweep inline /> {data.working.length} agent{data.working.length === 1 ? "" : "s"} working
            </p>
            {data.working.slice(0, 5).map((w) => (
              <Link key={w.number} href={`/tasks/${w.number}`} className="block px-3 py-1.5 text-sm">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-faint">#{w.number}</span>
                  <span className="min-w-0 flex-1 truncate">{w.agent}</span>
                  <Elapsed since={w.since} className="text-faint" />
                </span>
                <span className="block truncate text-xs text-muted">{w.activity || "Working"}</span>
              </Link>
            ))}
          </div>
        )}

        {[MAIN_PAGES, COMPANY_LINKS].map((pages, i) => (
          <ul key={i} className={i ? "mt-2 border-t border-line-soft pt-2" : undefined}>
            {pages.map((page) => {
              const Icon = page.icon;
              const active = isActive(pathname, page.href);
              return (
                <li key={page.href}>
                  <Link href={page.href} className={`${row} ${active ? "bg-selected text-ink" : "text-muted"}`}>
                    <Icon size={19} strokeWidth={1.6} />
                    {page.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        ))}

        <div className="mt-2 border-t border-line-soft pt-2">
          <Link href="/settings/account" className={`${row} ${isActive(pathname, "/settings/account") ? "bg-selected text-ink" : "text-muted"}`}>
            <UserRound size={19} strokeWidth={1.6} />
            Account settings
          </Link>
          {notifications.state !== "unsupported" && (
            <button
              onClick={async () => {
                if (notifications.state === "granted") return toast("Notifications are on. Turn them off in your browser's site settings.");
                const result = await notifications.request();
                toast(result === "granted" ? "You'll get a notification when something needs you." : "Notifications are blocked in your browser's settings.");
              }}
              className={`${row} text-muted`}
            >
              {notifications.state === "granted" ? <Bell size={19} strokeWidth={1.6} /> : <BellOff size={19} strokeWidth={1.6} />}
              {notifications.state === "granted" ? "Notifications on" : "Turn on notifications"}
            </button>
          )}
          <button
            onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}
            className={`${row} text-muted`}
          >
            <ThemeIcon theme={theme} size={19} />
            {themeLabel(theme)}
          </button>
          <form action={signOutAction}>
            <button type="submit" className={`${row} text-muted`}>
              <Face name={data.me.name} size={20} />
              <span className="min-w-0 flex-1 truncate text-left">{data.me.name}</span>
              <LogOut size={17} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
