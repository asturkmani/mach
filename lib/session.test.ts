import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { user: { id: "user_ahmed", email: "ahmed@cedarlegacy.com", emailVerified: true } };

vi.mock("@workos-inc/authkit-nextjs", () => ({ withAuth: async () => auth, getWorkOS: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { getCompanyDomain } = await import("./session");

describe("getCompanyDomain", () => {
  beforeEach(() => {
    auth.user = { id: "user_ahmed", email: "ahmed@cedarlegacy.com", emailVerified: true };
  });

  it("returns the domain of a verified work email", async () => {
    expect(await getCompanyDomain()).toBe("cedarlegacy.com");
  });

  it("ignores unverified addresses, so nobody can claim a domain they don't own", async () => {
    auth.user.emailVerified = false;
    expect(await getCompanyDomain()).toBeNull();
  });

  it("ignores personal email providers", async () => {
    auth.user.email = "ahmed@gmail.com";
    expect(await getCompanyDomain()).toBeNull();
  });
});
