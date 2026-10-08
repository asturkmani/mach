import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization } from "@/lib/orgs";
import { useTestDb } from "@/test/db";

const auth: {
  user: { id: string; email: string; emailVerified: boolean; firstName?: string | null; lastName?: string | null };
  organizationId?: string;
  role?: string;
} = { user: { id: "user_ahmed", email: "ahmed@cedarlegacy.com", emailVerified: true } };
const workosOrganizations = new Map<string, { id: string; name: string }>();

vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: async () => auth,
  getWorkOS: () => ({
    organizations: {
      getOrganization: async (id: string) => {
        const org = workosOrganizations.get(id);
        if (!org) throw new Error("Not found");
        return org;
      },
    },
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { getCompanyDomain, getSessionContext } = await import("./session");

describe("getSessionContext", () => {
  beforeEach(async () => {
    await useTestDb();
    workosOrganizations.clear();
    auth.user = { id: "user_ahmed", email: "ahmed@cedarlegacy.com", emailVerified: true, firstName: "Ahmed", lastName: null };
  });

  it("finds the company the session points at", async () => {
    await createOrganization({ id: "org_cedar", name: "Cedar Legacy" });
    auth.organizationId = "org_cedar";
    expect((await getSessionContext()).organization).toMatchObject({ id: "org_cedar", name: "Cedar Legacy" });
  });

  it("treats a session still pointing at a deleted company as having none, so they start again", async () => {
    auth.organizationId = "org_deleted";
    expect((await getSessionContext()).organization).toBeNull();
  });
});

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
