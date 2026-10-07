import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import { signOutAction } from "@/app/(app)/actions";
import { findOrganizationByDomain } from "@/lib/orgs";
import { getCompanyDomain, getSessionContext } from "@/lib/session";
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

  // A company already owns this work email domain: join it rather than create a duplicate.
  const domain = await getCompanyDomain();
  const domainCompany = domain ? await findOrganizationByDomain(domain) : null;
  const isDomainMember = memberships.data.some((m) => m.organizationId === domainCompany?.id);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2">
          <p className="text-sm font-semibold tracking-tight text-zinc-500">Mach</p>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Welcome, {context.user.name}
          </h1>
          {!domainCompany && (
            <p className="text-zinc-600 dark:text-zinc-400">
              Name your company to get started. If you add your website, your Chief of Staff reads it so you
              don&apos;t have to explain the basics.
            </p>
          )}
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
            {!domainCompany && <p className="pt-2 text-sm text-zinc-500">Or create a new company:</p>}
          </div>
        )}
        {domainCompany && !isDomainMember && (
          <div className="space-y-3 rounded-lg border border-zinc-300 bg-white p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            <p className="font-medium text-zinc-900 dark:text-zinc-100">{domainCompany.name} is already on Mach</p>
            <p className="text-zinc-600 dark:text-zinc-400">
              Everyone with an @{domain} email shares one company. Ask someone at {domainCompany.name} to invite you from
              their Team page, and you&apos;ll get an email with a link to join.
            </p>
            <form action={signOutAction}>
              <button type="submit" className="text-zinc-500 underline underline-offset-2 hover:text-zinc-900">
                Use a different email
              </button>
            </form>
          </div>
        )}
        {!domainCompany && (
          <CreateCompanyForm defaultWebsite={websiteFromEmail(context.user.email) ?? ""} domain={domain} />
        )}
      </div>
    </main>
  );
}
