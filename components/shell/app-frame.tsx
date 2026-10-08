"use client";

import { Suspense, useEffect, useState } from "react";

import { rememberTimezoneAction } from "@/app/(app)/actions";

import { CosPanel } from "./cos-panel";
import { DeviceSetup, OfflineBanner } from "./device";
import { Flyby } from "./flyby";
import { InboxNotifier } from "./inbox-notifier";
import { MobileNav } from "./mobile-nav";
import { Rail } from "./rail";
import { ShellProvider, useIsPhone, useShell, type ShellData } from "./shell";
import { UrlActions } from "./url-actions";

type CosProps = React.ComponentProps<typeof CosPanel>;

// On a computer: the left menu, the page in a frame, and the Chief of Staff
// beside it. On a phone: the page full width, a bar of the main actions at the
// bottom, and the Chief of Staff as a full-screen sheet.
function Layout({ children, cos }: { children: React.ReactNode; cos: CosProps }) {
  const { cosOpen } = useShell();
  const phone = useIsPhone();
  const [opened, setOpened] = useState(cosOpen);
  if (cosOpen && !opened) setOpened(true);
  return (
    <div className="flex h-dvh">
      <Rail />
      <main className="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[calc(3.5rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] md:py-3 md:pr-3 md:pl-0">
        <div className="frame flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
      {/* Once opened, the panel stays mounted and is only hidden when closed, so a reply keeps streaming. */}
      {opened && (
        <div
          className={
            !cosOpen
              ? "hidden"
              : phone
                ? "fixed inset-x-0 top-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 bg-bg pt-[env(safe-area-inset-top)]"
                : // Hidden by CSS on a phone until hydrated, so the panel never flashes there.
                  "fixed inset-y-0 right-0 z-20 hidden w-full max-w-[420px] py-3 pr-3 pl-3 md:block lg:static lg:w-[400px] lg:shrink-0 lg:pl-0 xl:w-[440px] xl:max-w-none"
          }
        >
          <CosPanel {...cos} />
        </div>
      )}
      <MobileNav />
    </div>
  );
}

export function AppFrame({ data, cos, children }: { data: ShellData; cos: CosProps; children: React.ReactNode }) {
  const knowsTimezone = Boolean(data.organization.timezone);
  useEffect(() => {
    if (!knowsTimezone) void rememberTimezoneAction(Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => {});
  }, [knowsTimezone]);
  return (
    <ShellProvider data={data}>
      <InboxNotifier />
      <DeviceSetup />
      <OfflineBanner />
      <Suspense fallback={null}>
        <UrlActions />
      </Suspense>
      <Flyby />
      <Layout cos={cos}>{children}</Layout>
    </ShellProvider>
  );
}
