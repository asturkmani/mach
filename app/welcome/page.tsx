import { getWorkOS } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

import { signOutAction } from "@/app/(app)/actions";
import { MachLockup } from "@/components/brand";
import { getOrganization } from "@/lib/orgs";
import { pendingInvitation } from "@/lib/sign-in";
import { getSessionContext } from "@/lib/session";
import { websiteFromEmail } from "@/lib/website";

import { acceptInvitationAction, openCompany } from "./actions";
import { CreateCompanyForm } from "./create-company-form";

export default async function WelcomePage() {
  const context = await getSessionContext();
  if (context.organization) redirect("/");

  const memberships = await getWorkOS().userManagement.listOrganizationMemberships({
    userId: context.user.id,
    statuses: ["active"],
  });

  // Invited by a company, but signed in without the invitation's link (or with Google).
  const invitation = await pendingInvitation(context.user.email);
  const invitedTo =
    invitation && !memberships.data.some((m) => m.organizationId === invitation.organizationId)
      ? ((await getOrganization(invitation.organizationId))?.name ?? "Your team")
      : null;

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="frame w-full max-w-md space-y-6 bg-panel p-6 sm:p-8">
        <div className="space-y-2">
          <MachLockup size={20} />
          <h1 className="text-2xl font-medium tracking-tight">
            Welcome, {context.user.name}
          </h1>
          {!invitedTo && (
            <p className="text-muted">
              Name your company to get started. If you add your website, your Chief of Staff reads it so you
              don&apos;t have to explain the basics.
            </p>
          )}
        </div>
        {invitedTo && (
          <div className="space-y-3 border border-line bg-raised p-4 text-sm">
            <p className="text-ink">{invitedTo} invited you to Mach1</p>
            <form action={acceptInvitationAction}>
              <button type="submit" className="btn btn-primary w-full justify-center py-2">
                Join {invitedTo}
              </button>
            </form>
          </div>
        )}
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
            <p className="pt-2 text-sm text-muted">Or create a new company:</p>
          </div>
        )}
        {!invitedTo && (
          <>
            <CreateCompanyForm defaultWebsite={websiteFromEmail(context.user.email) ?? ""} />
            <div className="space-y-1 border-t border-line pt-4 text-sm text-muted">
              <p>
                <span className="text-ink">Joining your team?</span> Don&apos;t create a company: ask an admin to add you on
                Mach1&apos;s Team page and invite you, then sign in with the email they used.
              </p>
              <form action={signOutAction}>
                <button type="submit" className="underline underline-offset-2 hover:text-ink">
                  Use a different email
                </button>
              </form>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
