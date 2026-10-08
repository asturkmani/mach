import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings-nav";

// Everything that's configuration rather than work: the company's details,
// integrations and channels, and your own account. Reached from the company
// menu and the menu under your name.
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8 md:flex-row md:gap-12 md:py-8">
          <SettingsNav />
          <div className="min-w-0 max-w-3xl flex-1 space-y-12">{children}</div>
        </div>
      </div>
    </>
  );
}
