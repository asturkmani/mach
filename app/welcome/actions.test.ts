import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization, getOrganization } from "@/lib/orgs";
import { useTestDb } from "@/test/db";

let nextOrg = 0;
const workos = {
  organizations: {
    createOrganization: vi.fn(async ({ name }: { name: string }) => ({ id: `org_${++nextOrg}`, name })),
    deleteOrganization: vi.fn(),
  },
  userManagement: { createOrganizationMembership: vi.fn() },
};
const switchToOrganization = vi.fn();
const session = { user: { id: "user_ahmed", email: "ahmed@cedarlegacy.com", name: "Ahmed" }, domain: null as string | null };

vi.mock("@workos-inc/authkit-nextjs", () => ({ getWorkOS: () => workos, switchToOrganization }));
vi.mock("@/lib/session", () => ({
  getSessionContext: async () => ({ user: session.user, organization: null }),
  getCompanyDomain: async () => session.domain,
}));

const { createCompany } = await import("./actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("createCompany", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await useTestDb();
    session.domain = null;
  });

  it("claims the creator's work email domain for the new company", async () => {
    session.domain = "cedarlegacy.com";
    expect(await createCompany({}, form({ name: "Cedar Legacy" }))).toEqual({});

    const [orgId] = switchToOrganization.mock.calls[0];
    expect(await getOrganization(orgId)).toMatchObject({ name: "Cedar Legacy", domain: "cedarlegacy.com" });
  });

  it("points colleagues with the same domain to the existing company", async () => {
    await createOrganization({ id: "org_cedar", name: "Cedar Legacy", domain: "cedarlegacy.com" });
    session.domain = "cedarlegacy.com";

    const result = await createCompany({}, form({ name: "Cedar Legacy London" }));
    expect(result.error).toBe("Cedar Legacy already uses Mach1 for @cedarlegacy.com emails. Ask to join it instead.");
    expect(workos.organizations.createOrganization).not.toHaveBeenCalled();
  });

  it("lets personal email users create as many companies as they like, without a domain", async () => {
    expect(await createCompany({}, form({ name: "Solo Consulting" }))).toEqual({});
    expect(await createCompany({}, form({ name: "Side Project" }))).toEqual({});

    const ids = switchToOrganization.mock.calls.map(([id]) => id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect((await getOrganization(id))?.domain).toBeNull();
  });

  it("never lets two companies share a domain, whatever the casing", async () => {
    await createOrganization({ id: "org_a", name: "Cedar Legacy", domain: "cedarlegacy.com" });
    await expect(createOrganization({ id: "org_b", name: "Cedar Two", domain: "CedarLegacy.com" })).rejects.toThrow();
  });
});
