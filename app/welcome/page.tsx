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
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="frame w-full max-w-md space-y-6 bg-panel p-8">
        <div className="space-y-2">
          <p className="label">Mach</p>
          <h1 className="text-2xl tracking-tight">
            Welcome, {context.user.name}
          </h1>
          {!domainCompany && (
            <p className="text-muted">
              Name your company to get started. If you add your website, your Chief of Staff reads it so you
              don&apos;t have to explain the basics.
            </p>
          )}
        </div>
        {memberships.data.length > 0 && (
          <div className="space-y-2">
            <p className="label">You&apos;re already a member of</p>
            {memberships.data.map((membership) => (
              <form key={membership.id} action={openCompany}>
                <input type="hidden" name="organizationId" value={membership.organizationId} />
                <button
                  type="submit"
                  className="w-full border border-line bg-raised px-4 py-2 text-left text-sm hover:border-muted"
                >
                  {membership.organizationName} →
                </button>
              </form>
            ))}
            {!domainCompany && <p className="pt-2 text-sm text-muted">Or create a new company:</p>}
          </div>
        )}
        {domainCompany && !isDomainMember && (
          <div className="space-y-3 border border-line bg-raised p-4 text-sm">
            <p className="text-ink">{domainCompany.name} is already on Mach</p>
            <p className="text-muted">
              Everyone with an @{domain} email shares one company. Ask someone at {domainCompany.name} to invite you from
              their Team page, and you&apos;ll get an email with a link to join.
            </p>
            <form action={signOutAction}>
              <button type="submit" className="text-muted underline underline-offset-2 hover:text-ink">
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
