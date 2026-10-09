import { PageBody } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings-nav";

// Everything that's configuration rather than work: the company's details,
// integrations and channels, and your own account. Reached from the company
// menu and the menu under your name.
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <>
      <PageHeader title="Settings" />
      <PageBody width="5xl" className="flex flex-col gap-6 md:flex-row md:gap-12">
        <SettingsNav />
        <div className="min-w-0 max-w-3xl flex-1 space-y-12">{children}</div>
      </PageBody>
    </>
  );
}
