import { requireAppContext } from "@/lib/session";

import { signOutAction } from "./actions";
import { NavLinks } from "./nav-links";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { organization, user } = await requireAppContext();

  return (
    <div className="flex h-dvh flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-lg font-semibold tracking-tight">Mach</span>
            <span className="truncate text-sm text-zinc-500">{organization.name}</span>
          </div>
          <NavLinks />
        </div>
        <form action={signOutAction} className="flex items-center gap-3 text-sm">
          <span className="hidden text-zinc-500 sm:inline">{user.name}</span>
          <button type="submit" className="rounded-md px-2 py-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            Sign out
          </button>
        </form>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
