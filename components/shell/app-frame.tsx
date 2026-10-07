"use client";

import { useEffect } from "react";

import { rememberTimezoneAction } from "@/app/(app)/actions";

import { CosPanel } from "./cos-panel";
import { Rail } from "./rail";
import { ShellProvider, useShell, type ShellData } from "./shell";

type CosProps = React.ComponentProps<typeof CosPanel>;

function Layout({ children, cos }: { children: React.ReactNode; cos: CosProps }) {
  const { cosOpen } = useShell();
  return (
    <div className="flex h-dvh">
      <Rail />
      <main className="flex min-w-0 flex-1 flex-col py-3 pr-3">
        <div className="frame flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
      {cosOpen && (
        <div className="fixed inset-y-0 right-0 z-20 w-full max-w-[420px] py-3 pr-3 pl-3 lg:static lg:w-[400px] lg:shrink-0 lg:pl-0 xl:w-[440px] xl:max-w-none">
          <CosPanel {...cos} />
        </div>
      )}
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
      <Layout cos={cos}>{children}</Layout>
    </ShellProvider>
  );
}
