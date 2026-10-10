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
const session = { user: { id: "user_ahmed", email: "ahmed@cedarlegacy.com", name: "Ahmed" } };

vi.mock("@workos-inc/authkit-nextjs", () => ({ getWorkOS: () => workos, switchToOrganization }));
vi.mock("@/lib/session", () => ({
  getSessionContext: async () => ({ user: session.user, organization: null }),
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
  });

  it("creates a company for whoever asks: nobody is joined to another company by their email's domain", async () => {
    await createOrganization({ id: "org_cedar", name: "Cedar Legacy" });
    expect(await createCompany({}, form({ name: "Cedar Legacy London" }))).toEqual({});
    expect(await createCompany({}, form({ name: "Side Project" }))).toEqual({});

    const ids = switchToOrganization.mock.calls.map(([id]) => id);
    expect(ids).toHaveLength(2);
    expect(await getOrganization(ids[0])).toMatchObject({ name: "Cedar Legacy London" });
  });
});
