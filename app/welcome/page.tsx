import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import { signOutAction } from "@/app/(app)/actions";
import { MachLockup } from "@/components/brand";
import { joinRequestFor } from "@/lib/members";
import { findOrganizationByDomain } from "@/lib/orgs";
import { getCompanyDomain, getSessionContext } from "@/lib/session";
import { websiteFromEmail } from "@/lib/website";

import { joinCompanyAction, openCompany, requestToJoinAction } from "./actions";
import { WaitForAdmin } from "./wait-for-admin";
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
  const request = domainCompany && !isDomainMember ? await joinRequestFor(domainCompany.id, context.user.id) : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="frame w-full max-w-md space-y-6 bg-panel p-6 sm:p-8">
        <div className="space-y-2">
          <MachLockup size={20} />
          <h1 className="text-2xl font-medium tracking-tight">
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
            <p className="text-ink">{domainCompany.name} is already on Mach1</p>
            {domainCompany.autoJoin ? (
              <>
                <p className="text-muted">Everyone with an @{domain} email can join.</p>
                <form action={joinCompanyAction}>
                  <button type="submit" className="btn btn-primary w-full justify-center py-2">
                    Join {domainCompany.name}
                  </button>
                </form>
              </>
            ) : request?.status === "pending" ? (
              <>
                <p className="text-muted">
                  You asked to join. An admin at {domainCompany.name} lets you in from their inbox, and it appears here
                  as soon as they do.
                </p>
                <WaitForAdmin />
              </>
            ) : (
              <>
                <p className="text-muted">
                  {request?.status === "declined"
                    ? `Your last request wasn't accepted. Check with someone at ${domainCompany.name}, or ask again.`
                    : `Everyone with an @${domain} email shares one company. Ask to join, and an admin there lets you in.`}
                </p>
                <form action={requestToJoinAction}>
                  <button type="submit" className="btn btn-primary w-full justify-center py-2">
                    Ask to join {domainCompany.name}
                  </button>
                </form>
              </>
            )}
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
