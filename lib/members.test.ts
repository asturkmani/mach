import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization, getOrganization } from "@/lib/orgs";
import { linkMember, listPeople } from "@/lib/people";
import { savePushSubscription } from "@/lib/push";
import { getTask, listInbox } from "@/lib/tasks";
import { useTestDb } from "@/test/db";

// WorkOS's memberships, kept here: { id, userId, organizationId, role, status }.
let memberships: { id: string; userId: string; organizationId: string; role: { slug: string }; status: string }[] = [];
const workos = {
  userManagement: {
    listOrganizationMemberships: vi.fn(async ({ organizationId, userId }: { organizationId: string; userId?: string }) => ({
      data: memberships.filter((m) => m.organizationId === organizationId && (!userId || m.userId === userId)),
    })),
    createOrganizationMembership: vi.fn(async ({ organizationId, userId, roleSlug }: { organizationId: string; userId: string; roleSlug: string }) => {
      memberships.push({ id: `om_${memberships.length + 1}`, organizationId, userId, role: { slug: roleSlug }, status: "active" });
    }),
    updateOrganizationMembership: vi.fn(async (id: string, { roleSlug }: { roleSlug: string }) => {
      memberships.find((m) => m.id === id)!.role = { slug: roleSlug };
    }),
    reactivateOrganizationMembership: vi.fn(),
  },
};
vi.mock("@workos-inc/authkit-nextjs", () => ({ getWorkOS: () => workos }));

const pushed: { endpoint: string; payload: Record<string, unknown> }[] = [];
vi.mock("web-push", () => ({
  default: { sendNotification: async (s: { endpoint: string }, payload: string) => void pushed.push({ endpoint: s.endpoint, payload: JSON.parse(payload) }) },
}));

const { memberRoles, setRole } = await import("@/lib/members");

const ORG = "org_cedar";
const sara = { userId: "user_sara", email: "sara@cedarlegacy.com", name: "Sara Khan" };

async function setUp() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedarlegacy.com", name: "Ahmed" });
  memberships = [{ id: "om_ahmed", userId: "user_ahmed", organizationId: ORG, role: { slug: "admin" }, status: "active" }];
  return { ahmed, organization: (await getOrganization(ORG))! };
}

describe("roles in a company", () => {
  beforeEach(async () => {
    await useTestDb();
    vi.clearAllMocks();
    pushed.length = 0;
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPublicKey");
    vi.stubEnv("VAPID_PRIVATE_KEY", "privateKey");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("makes someone an admin, and never leaves a company without one", async () => {
    await setUp();
    memberships.push({ id: "om_sara", userId: "user_sara", organizationId: ORG, role: { slug: "member" }, status: "active" });

    await setRole(ORG, "user_sara", "admin");
    expect((await memberRoles(ORG)).get("user_sara")?.role).toBe("admin");
    await setRole(ORG, "user_ahmed", "member");
    expect((await memberRoles(ORG)).get("user_ahmed")?.role).toBe("member");
    await expect(setRole(ORG, "user_sara", "member")).rejects.toThrow(/at least one admin/);
  });
});
