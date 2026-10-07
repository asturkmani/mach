"use client";

import { Bell, BellOff,
  Bot,
  Building,
  Command as CommandIcon,
  FolderOpen,
  House,
  LogOut,
  Monitor,
  Moon,
  PanelRight,
  Plus,
  Search,
  Sun,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { signOutAction } from "@/app/(app)/actions";
import { Face } from "@/components/ui";

import { useNotificationPermission } from "./inbox-notifier";
import { useShell } from "./shell";

// The left menu: a column of icons that widens into labels while the pointer
// (or keyboard focus) is on it, laid over the page rather than pushing it.

type Item = { href: string; label: string; icon: LucideIcon; count?: number; accent?: boolean };

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/tasks/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Rail() {
  const pathname = usePathname();
  const { data, openPalette, openNewTask, cosOpen, setCosOpen, theme, setTheme, toast } = useShell();
  const notifications = useNotificationPermission();

  const workspace: Item[] = [
    { href: "/", label: "Home", icon: House, count: data.inboxCount, accent: true },
  ];
  const company: Item[] = [
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/files", label: "Files", icon: FolderOpen },
    { href: "/team", label: "Team", icon: Users },
    { href: "/company", label: "Company profile", icon: Building },
  ];

  const row = "flex h-10 w-full items-center gap-3 px-[17px] text-[15px] whitespace-nowrap";
  const text = "opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:opacity-100";

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
              <span className="absolute left-[30px] top-[9px] h-1.5 w-1.5 rounded-full bg-accent group-hover/rail:opacity-0 group-has-[:focus-visible]/rail:opacity-0" />
            )}
          </>
        ) : null}
      </Link>
    );
  };

  const button = (label: string, Icon: LucideIcon, onClick: () => void, key?: string) => (
    <button key={label} onClick={onClick} aria-label={label} className={`${row} text-muted hover:bg-hover hover:text-ink`}>
      <Icon size={18} strokeWidth={1.6} className="shrink-0" />
      <span className={`${text} flex-1 text-left`}>{label}</span>
      {key && <kbd className={`kbd ${text}`}>{key}</kbd>}
    </button>
  );

  return (
    <nav aria-label="Main" className="group/rail relative z-30 w-[60px] shrink-0">
      <div className="absolute inset-y-0 left-0 flex w-[60px] flex-col overflow-clip border-r border-transparent bg-bg py-3 transition-[width,box-shadow,border-color] duration-200 group-hover/rail:w-60 group-hover/rail:border-line group-hover/rail:shadow-[var(--shadow)] group-has-[:focus-visible]/rail:w-60 group-has-[:focus-visible]/rail:border-line">
        <div className="mb-3 flex h-10 items-center gap-3 px-[15px] whitespace-nowrap">
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center bg-ink font-mono text-sm font-semibold text-panel">
            M
          </span>
          <span className={`${text} min-w-0 truncate text-[15px] font-medium`}>{data.organization.name}</span>
        </div>

        <div className="px-1.5">
          <button
            onClick={() => openPalette("search")}
            aria-label="Search"
            className={`${row} mb-4 border border-transparent px-[15px] text-muted hover:text-ink group-hover/rail:border-line group-has-[:focus-visible]/rail:border-line`}
          >
            <Search size={17} strokeWidth={1.6} className="shrink-0" />
            <span className={`${text} label flex-1 text-left`}>Search</span>
            <span className={`${text} font-mono text-xs text-faint`}>/</span>
          </button>

          <p className={`${text} label mb-1 px-[15px]`}>Workspace</p>
          <div className="space-y-0.5">{workspace.map(link)}</div>

          <p className={`${text} label mb-1 mt-5 px-[15px]`}>Company</p>
          <div className="space-y-0.5">{company.map(link)}</div>
        </div>

        <div className="mt-auto space-y-0.5 px-1.5">
          {button("New task", Plus, openNewTask, "N")}
          {button(cosOpen ? "Hide Chief of Staff" : "Chief of Staff", PanelRight, () => setCosOpen(!cosOpen), "C")}
          {button("Commands", CommandIcon, () => openPalette(), "⌘K")}
          {notifications.state !== "unsupported" &&
            button(
              notifications.state === "granted" ? "Notifications on" : "Turn on notifications",
              notifications.state === "granted" ? Bell : BellOff,
              async () => {
                if (notifications.state === "granted") return toast("Notifications are on. Turn them off in your browser's site settings.");
                const result = await notifications.request();
                toast(
                  result === "granted"
                    ? "You'll get a notification when something needs you."
                    : "Notifications are blocked. Allow them for this site in your browser's settings.",
                );
              },
            )}
          {button(
            `Theme: ${theme === "system" ? "match system" : theme}`,
            theme === "light" ? Sun : theme === "dark" ? Moon : Monitor,
            () => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system"),
          )}
          <form action={signOutAction}>
            <button type="submit" aria-label="Sign out" className={`${row} text-muted hover:bg-hover hover:text-ink`}>
              <Face name={data.me.name} size={20} />
              <span className={`${text} min-w-0 flex-1 truncate text-left text-sm`}>{data.me.name}</span>
              <LogOut size={15} className={`${text} shrink-0`} />
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
