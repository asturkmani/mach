import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workos = {
  sso: { listConnections: vi.fn() },
  userManagement: { createMagicAuth: vi.fn(), listUsers: vi.fn(), authenticateWithMagicAuth: vi.fn(), listInvitations: vi.fn() },
};
vi.mock("@workos-inc/authkit-nextjs", () => ({ getWorkOS: () => workos }));

const { attempt, pendingInvitation, safeReturnTo, sealPending, startWithEmail, unsealPending, withCode } = await import("@/lib/sign-in");

/** An error shaped like the WorkOS SDK's, with its raw response. */
const workosError = (rawData: Record<string, unknown>) => Object.assign(new Error("WorkOS error"), { name: "AuthenticationException", rawData });

describe("signing in on Mach1's own page", () => {
  beforeEach(() => {
    vi.stubEnv("WORKOS_COOKIE_PASSWORD", "a-cookie-password-at-least-32-characters-long");
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
    for (const fn of [workos.sso.listConnections, ...Object.values(workos.userManagement)]) fn.mockReset();
    workos.sso.listConnections.mockResolvedValue({ data: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps what a sign-in remembers in a cookie nobody can alter, for 15 minutes", () => {
    const sealed = sealPending({ email: "sara@cedar.example", token: "pending_123", returnTo: "/team" });
    expect(unsealPending(sealed)).toEqual({ email: "sara@cedar.example", token: "pending_123", returnTo: "/team" });

    const [body, signature] = sealed.split(".");
    const tampered = Buffer.from(JSON.stringify({ email: "mallory@evil.example", token: "pending_123", at: Date.now() })).toString("base64url");
    expect(unsealPending(`${tampered}.${signature}`)).toBeNull();
    expect(unsealPending(`${body}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`)).toBeNull();
    expect(unsealPending("garbage")).toBeNull();
    expect(unsealPending(undefined)).toBeNull();

    vi.useFakeTimers({ now: Date.now() + 16 * 60_000 });
    expect(unsealPending(sealed)).toBeNull();
    vi.useRealTimers();
  });

  it("only sends people back to a page inside Mach1", () => {
    expect(safeReturnTo("/tasks/12?tab=files")).toBe("/tasks/12?tab=files");
    for (const bad of ["https://evil.example", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "/sign-in", "/callback?code=x", "", null, undefined]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });

  it("sends a code by email, and says so plainly when email codes aren't switched on", async () => {
    workos.userManagement.createMagicAuth.mockResolvedValueOnce({ id: "magic_1" });
    expect(await startWithEmail("sara@cedar.example")).toEqual({ next: "code" });

    // No password to fall back to: Mach1 signs in by code only.
    workos.userManagement.createMagicAuth.mockRejectedValueOnce(workosError({ error: "authentication_method_not_allowed" }));
    expect(await startWithEmail("sara@cedar.example")).toEqual({
      next: "error",
      message: "Signing in by email isn't switched on yet. Use Google or Microsoft for now.",
    });
    expect(workos.userManagement.listUsers).not.toHaveBeenCalled();
  });

  it("sends a work email whose company has single sign-on to it, without emailing a code", async () => {
    workos.sso.listConnections.mockResolvedValue({ data: [{ id: "conn_old", state: "inactive" }, { id: "conn_okta", state: "active" }] });
    expect(await startWithEmail("sara@cedar.example")).toEqual({ next: "sso", connectionId: "conn_okta" });
    expect(workos.sso.listConnections).toHaveBeenCalledWith({ domain: "cedar.example" });
    expect(workos.userManagement.createMagicAuth).not.toHaveBeenCalled();

    // Personal addresses never look for a company's sign-on.
    workos.sso.listConnections.mockClear();
    workos.userManagement.createMagicAuth.mockResolvedValueOnce({ id: "magic_2" });
    await startWithEmail("sara@gmail.com");
    expect(workos.sso.listConnections).not.toHaveBeenCalled();
  });

  it("turns each of WorkOS's answers into the next step", async () => {
    const fail = (rawData: Record<string, unknown>) => attempt(() => Promise.reject(workosError(rawData)));
    expect(
      await fail({ code: "organization_selection_required", pending_authentication_token: "tok", organizations: [{ id: "org_a", name: "Alpha" }] }),
    ).toEqual({ kind: "choose-company", token: "tok", companies: [{ id: "org_a", name: "Alpha" }] });
    expect(await fail({ code: "email_verification_required", pending_authentication_token: "tok" })).toEqual({ kind: "verify-email", token: "tok" });
    expect(await fail({ error: "sso_required", connection_ids: ["conn_1"] })).toEqual({ kind: "sso", connectionId: "conn_1" });
    expect(await fail({ code: "mfa_challenge", pending_authentication_token: "tok" })).toEqual({ kind: "hosted" });
    expect(await fail({ code: "invalid_one_time_code" })).toEqual({ kind: "error", message: "That code didn't work. Check it, or send a new one." });

    const auth = { user: { id: "user_1" }, accessToken: "a", refreshToken: "r" };
    workos.userManagement.authenticateWithMagicAuth.mockResolvedValueOnce(auth);
    expect(await withCode("sara@cedar.example", "123456", "inv_1")).toEqual({ kind: "signed-in", auth });
    expect(workos.userManagement.authenticateWithMagicAuth).toHaveBeenCalledWith({
      clientId: "client_test",
      email: "sara@cedar.example",
      code: "123456",
      invitationToken: "inv_1",
    });
  });

  it("finds the open invitation for an email, so a lost invitation link still joins the company", async () => {
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const earlier = new Date(Date.now() - 1000).toISOString();
    workos.userManagement.listInvitations.mockResolvedValueOnce({
      data: [
        { id: "inv_revoked", token: "t0", state: "revoked", organizationId: "org_a", expiresAt: later },
        { id: "inv_expired", token: "t1", state: "pending", organizationId: "org_a", expiresAt: earlier },
        { id: "inv_open", token: "t2", state: "pending", organizationId: "org_cedar", expiresAt: later },
      ],
    });
    expect(await pendingInvitation("sara@cedar.example")).toEqual({ id: "inv_open", token: "t2", organizationId: "org_cedar" });
    expect(workos.userManagement.listInvitations).toHaveBeenCalledWith({ email: "sara@cedar.example", limit: 20, order: "desc" });

    workos.userManagement.listInvitations.mockResolvedValueOnce({ data: [] });
    expect(await pendingInvitation("sara@cedar.example")).toBeNull();
    workos.userManagement.listInvitations.mockRejectedValueOnce(workosError({ code: "server_error" }));
    expect(await pendingInvitation("sara@cedar.example")).toBeNull();
  });
});
