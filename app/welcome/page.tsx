import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import { getSessionContext } from "@/lib/session";
import { websiteFromEmail } from "@/lib/website";

import { openCompany } from "./actions";
import { CreateCompanyForm } from "./create-company-form";

export default async function WelcomePage() {
  const context = await getSessionContext();
  if (context.organization) redirect("/");

  const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
    userId: context.user.id,
    statuses: ["active"],
  });

  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2">
          <p className="text-sm font-semibold tracking-tight text-zinc-500">Mach</p>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Welcome, {context.user.name}
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Name your company to get started. If you add your website, your Chief of Staff reads it so you don&apos;t
            have to explain the basics.
          </p>
        </div>
        {memberships.data.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">You&apos;re already a member of</p>
            {memberships.data.map((membership) => (
              <form key={membership.id} action={openCompany}>
                <input type="hidden" name="organizationId" value={membership.organizationId} />
                <button
                  type="submit"
                  className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2 text-left text-sm font-medium hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  {membership.organizationName} →
                </button>
              </form>
            ))}
            <p className="pt-2 text-sm text-zinc-500">Or create a new company:</p>
          </div>
        )}
        <CreateCompanyForm defaultWebsite={websiteFromEmail(context.user.email) ?? ""} />
      </div>
    </main>
  );
}
