"use client";

import { ArrowLeft, Building2 } from "lucide-react";
import { useState, useTransition } from "react";

import type { Provider } from "@/lib/sign-in";

import { codeStep, companyStep, emailStep, passwordStep, resendCode, verifyStep, type Step } from "./actions";

// The steps of signing in, one screen at a time: email (or Google, Microsoft),
// then a code by email or a password, then which company if there's more than one.

export type Start =
  | { step: "email" }
  | { step: "verify"; email: string }
  | { step: "company"; companies: { id: string; name: string }[] };

type Screen = Start | { step: "code"; email: string } | { step: "password"; email: string; newUser: boolean };

export function SignInForm({
  start,
  providers,
  returnTo,
  invitationToken,
  email: initialEmail,
  problem,
}: {
  start: Start;
  providers: Provider[];
  returnTo: string;
  invitationToken?: string;
  email?: string;
  problem?: string;
}) {
  const [screen, setScreen] = useState<Screen>(start);
  const [error, setError] = useState(problem ?? "");
  const [notice, setNotice] = useState("");
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState(initialEmail ?? "");

  const run = (work: () => Promise<Step>, after?: (step: Step) => void) =>
    startTransition(async () => {
      setError("");
      setNotice("");
      const result = await work().catch(() => ({ error: "Couldn't reach Mach1. Check your connection and try again." }) as Step);
      if ("error" in result) return setError(result.error);
      if ("go" in result) {
        // Leaving for a provider is a full page load; back into Mach1, a fresh one so the session is read.
        window.location.assign(result.go);
        return;
      }
      setScreen(result);
      after?.(result);
    });

  const query = new URLSearchParams({ returnTo, ...(invitationToken ? { invitation_token: invitationToken } : {}) });
  const back = () => {
    setScreen({ step: "email" });
    setError("");
    setNotice("");
  };

  return (
    <div className="space-y-5">
      {screen.step === "email" && (
        <>
          {providers.length > 0 && (
            <div className="space-y-2">
              {providers.map((provider) => (
                <a key={provider} href={`/sign-in/${provider}?${query}`} className="btn w-full justify-center gap-2.5 py-2.5 text-[15px]">
                  <ProviderIcon provider={provider} />
                  Continue with {provider === "google" ? "Google" : "Microsoft"}
                </a>
              ))}
              <p className="flex items-center gap-3 pt-2 text-xs text-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">or</p>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => emailStep({ email, returnTo, invitationToken }));
            }}
            className="space-y-3"
          >
            <label className="block space-y-1">
              <span className="label">Work email</span>
              <input
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                required
                autoFocus={providers.length === 0}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="field py-2.5 text-[15px]"
                placeholder="you@company.com"
              />
            </label>
            <button type="submit" disabled={pending} className="btn btn-primary w-full justify-center py-2.5 text-[15px]">
              {pending ? "One moment…" : "Continue with email"}
            </button>
          </form>
        </>
      )}

      {(screen.step === "code" || screen.step === "verify") && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const code = String(new FormData(e.currentTarget).get("code") ?? "");
            run(() => (screen.step === "code" ? codeStep({ code }) : verifyStep({ code })));
          }}
          className="space-y-3"
        >
          <p className="text-[15px]">
            We emailed a code to <span className="font-medium">{screen.email}</span>. Enter it here.
          </p>
          <input
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9 ]*"
            maxLength={7}
            required
            autoFocus
            aria-label="Code from the email"
            className="field py-3 text-center font-mono text-2xl tracking-[0.4em]"
            placeholder="000000"
            onChange={(e) => {
              // A full code submits itself.
              if (e.target.value.replace(/\s/g, "").length === 6) e.currentTarget.form?.requestSubmit();
            }}
          />
          <button type="submit" disabled={pending} className="btn btn-primary w-full justify-center py-2.5 text-[15px]">
            {pending ? "Checking…" : "Continue"}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" onClick={back} className="flex items-center gap-1 text-muted hover:text-ink">
              <ArrowLeft size={14} /> Different email
            </button>
            {screen.step === "code" && (
              <button type="button" disabled={pending} onClick={() => run(resendCode, () => setNotice("We sent a new code."))} className="text-muted hover:text-ink">
                Send a new code
              </button>
            )}
          </div>
        </form>
      )}

      {screen.step === "password" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(() =>
              passwordStep({ password: String(data.get("password") ?? ""), name: String(data.get("name") ?? ""), newUser: screen.newUser }),
            );
          }}
          className="space-y-3"
        >
          <p className="text-[15px]">
            {screen.newUser ? "Create your account for " : "Signing in as "}
            <span className="font-medium">{screen.email}</span>
          </p>
          {screen.newUser && (
            <label className="block space-y-1">
              <span className="label">Your name</span>
              <input name="name" autoComplete="name" required autoFocus className="field py-2.5 text-[15px]" placeholder="Ahmed Khan" />
            </label>
          )}
          <label className="block space-y-1">
            <span className="label">{screen.newUser ? "Choose a password" : "Password"}</span>
            <input
              type="password"
              name="password"
              autoComplete={screen.newUser ? "new-password" : "current-password"}
              required
              autoFocus={!screen.newUser}
              minLength={screen.newUser ? 10 : undefined}
              className="field py-2.5 text-[15px]"
            />
          </label>
          <button type="submit" disabled={pending} className="btn btn-primary w-full justify-center py-2.5 text-[15px]">
            {pending ? "One moment…" : screen.newUser ? "Create account" : "Sign in"}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" onClick={back} className="flex items-center gap-1 text-muted hover:text-ink">
              <ArrowLeft size={14} /> Different email
            </button>
            {!screen.newUser && (
              <a href={`/sign-in/hosted?${new URLSearchParams({ email: screen.email, returnTo })}`} className="text-muted hover:text-ink">
                Forgot your password?
              </a>
            )}
          </div>
        </form>
      )}

      {screen.step === "company" && (
        <div className="space-y-3">
          <p className="text-[15px]">You&apos;re in more than one company. Which one?</p>
          <ul className="space-y-2">
            {screen.companies.map((company) => (
              <li key={company.id}>
                <button
                  disabled={pending}
                  onClick={() => run(() => companyStep({ organizationId: company.id }))}
                  className="btn w-full justify-start gap-2.5 py-2.5 text-[15px]"
                >
                  <Building2 size={16} strokeWidth={1.6} className="text-muted" />
                  {company.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {notice && (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="border border-danger/40 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {screen.step === "email" && (
        <p className="text-xs text-faint">
          Trouble signing in?{" "}
          <a href={`/sign-in/hosted?${new URLSearchParams({ ...(email ? { email } : {}), returnTo })}`} className="underline underline-offset-2 hover:text-muted">
            Other ways to sign in
          </a>
        </p>
      )}
    </div>
  );
}

function ProviderIcon({ provider }: { provider: Provider }) {
  if (provider === "google") {
    return (
      <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 21 21" width="16" height="16" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
