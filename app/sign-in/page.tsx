import { cookies } from "next/headers";

import { MachMark } from "@/components/brand";
import { enabledProviders, safeReturnTo, SIGN_IN_COOKIE, unsealPending } from "@/lib/sign-in";

import { SignInForm, type Start } from "./sign-in-form";

// Mach's sign-in page: Google or Microsoft, or a work email (a code by email,
// or the company's single sign-on). Also where /callback sends someone back
// mid-way, to confirm their email or pick a company.

export const metadata = { title: "Sign in · Mach" };

const PROBLEMS: Record<string, string> = {
  cancelled: "Signing in was cancelled. Try again.",
  expired: "That took too long. Start again.",
  failed: "That sign-in didn't work. Try again, or use your email.",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const params = await searchParams;
  const one = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);
  const returnTo = safeReturnTo(one("returnTo"));
  const invitationToken = one("invitation_token");
  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? "http://localhost:3000/callback";
  const providers = await enabledProviders(redirectUri);

  // Back from a provider with a step to finish here.
  const pending = unsealPending((await cookies()).get(SIGN_IN_COOKIE)?.value);
  const step = one("step");
  let start: Start = { step: "email" };
  if (step === "company" && pending?.token && pending.companies?.length) start = { step: "company", companies: pending.companies };
  else if (step === "verify" && pending?.token) start = { step: "verify", email: pending.email ?? "" };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="frame w-full max-w-sm space-y-6 bg-panel p-6 sm:p-8">
        <div className="space-y-4">
          <MachMark size={36} />
          <div className="space-y-1">
            <h1 className="text-2xl font-medium tracking-tight">{invitationToken ? "Join your team on Mach" : "Sign in to Mach"}</h1>
            <p className="text-sm text-muted">New here? The same steps create your account.</p>
          </div>
        </div>
        <SignInForm
          start={start}
          providers={providers}
          returnTo={returnTo}
          invitationToken={invitationToken}
          email={one("email")}
          problem={PROBLEMS[one("error") ?? ""]}
        />
      </div>
    </main>
  );
}
