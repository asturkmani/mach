import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOrganization, getOrganization } from "@/lib/orgs";
import { linkMember, listPeople, type Person } from "@/lib/people";
import { useTestDb } from "@/test/db";

const ORG = "org_cedar";
const workos = {
  userManagement: {
    sendInvitation: vi.fn(),
    resendInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    listOrganizationMemberships: vi.fn(),
    deleteOrganizationMembership: vi.fn(),
  },
};
const session = { isAdmin: true, person: null as Person | null };

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@workos-inc/authkit-nextjs", () => ({ getWorkOS: () => workos }));
vi.mock("@/lib/session", () => ({
  actorOf: ({ organization, person, user, isAdmin }: { organization: { id: string }; person: { id: string; name: string }; user: { id: string }; isAdmin: boolean }) => ({
    organizationId: organization.id,
    personId: person.id,
    name: person.name,
    userId: user.id,
    isAdmin,
  }),
  requireAppContext: async () => ({
    organization: await getOrganization(ORG),
    user: { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" },
    person: session.person,
    isAdmin: session.isAdmin,
  }),
}));

const { addPersonAction, inviteAction, removePersonAction, setManagerAction } = await import("./actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const byName = async (name: string) => (await listPeople(ORG)).find((p) => p.name === name)!;

describe("team actions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    session.person = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    session.isAdmin = true;
  });

  it("adds a person and rejects bad input", async () => {
    expect(await addPersonAction({}, form({ name: "" }))).toEqual({ error: "Enter a name." });
    expect((await addPersonAction({}, form({ name: "Lina", email: "nope" }))).error).toMatch(/email/);

    expect(await addPersonAction({}, form({ name: "Mustapha", role: "Finance lead", manager: "Ahmed" }))).toEqual({
      message: "Added Mustapha.",
    });
    expect(await byName("Mustapha")).toMatchObject({ role: "Finance lead", managerName: "Ahmed", email: null });
  });

  it("changes someone's manager", async () => {
    await addPersonAction({}, form({ name: "Lina" }));
    await addPersonAction({}, form({ name: "Mustapha", manager: "Ahmed" }));
    await setManagerAction((await byName("Mustapha")).id, "Lina");
    expect((await byName("Mustapha")).managerName).toBe("Lina");
  });

  it("invites by email, then resends the same invitation", async () => {
    await addPersonAction({}, form({ name: "Mustapha" }));
    const mustapha = await byName("Mustapha");
    expect((await inviteAction(mustapha.id)).error).toMatch(/email address/);

    await addPersonAction({}, form({ name: "Mustapha", email: "mustapha@cedar.example" }));
    workos.userManagement.sendInvitation.mockResolvedValue({ id: "inv_1", acceptInvitationUrl: "https://accept/1" });
    expect(await inviteAction(mustapha.id)).toEqual({ message: "Invitation sent to mustapha@cedar.example." });
    expect(workos.userManagement.sendInvitation).toHaveBeenCalledWith({
      email: "mustapha@cedar.example",
      organizationId: ORG,
      inviterUserId: "user_ahmed",
    });
    expect(await byName("Mustapha")).toMatchObject({ status: "invited", invitationId: "inv_1", inviteUrl: "https://accept/1" });

    workos.userManagement.resendInvitation.mockResolvedValue({ id: "inv_1", acceptInvitationUrl: "https://accept/1" });
    await inviteAction(mustapha.id);
    expect(workos.userManagement.resendInvitation).toHaveBeenCalledWith("inv_1");
  });

  it("adds and invites in one step when invite is ticked", async () => {
    workos.userManagement.sendInvitation.mockResolvedValue({ id: "inv_1", acceptInvitationUrl: "https://accept/1" });
    expect(await addPersonAction({}, form({ name: "Mustapha", email: "mustapha@cedar.example", invite: "on" }))).toEqual({
      message: "Added Mustapha and sent an invitation to mustapha@cedar.example.",
    });
    expect(await byName("Mustapha")).toMatchObject({ status: "invited", invitationId: "inv_1" });

    expect(await addPersonAction({}, form({ name: "Lina", invite: "on" }))).toEqual({ message: "Added Lina. Add their email to invite them." });
    expect(await addPersonAction({}, form({ name: "Sami", email: "sami@cedar.example" }))).toEqual({ message: "Added Sami." });
    expect(workos.userManagement.sendInvitation).toHaveBeenCalledTimes(1);

    workos.userManagement.sendInvitation.mockRejectedValue(new Error("Rate limited."));
    expect((await addPersonAction({}, form({ name: "Omar", email: "omar@cedar.example", invite: "on" }))).error).toMatch(
      /Added Omar, but the invitation didn't send.*Rate limited/,
    );
    expect(await byName("Omar")).toMatchObject({ status: "not_invited" });

    session.isAdmin = false;
    expect(await addPersonAction({}, form({ name: "Rana", email: "rana@cedar.example", invite: "on" }))).toEqual({ message: "Added Rana." });
    expect(workos.userManagement.sendInvitation).toHaveBeenCalledTimes(2);
  });

  it("only lets admins invite and remove", async () => {
    await addPersonAction({}, form({ name: "Mustapha", email: "mustapha@cedar.example" }));
    session.isAdmin = false;
    const id = (await byName("Mustapha")).id;
    expect((await inviteAction(id)).error).toMatch(/Only admins/);
    expect((await removePersonAction(id)).error).toMatch(/Only admins/);
  });

  it("removes a person and revokes their pending invitation", async () => {
    await addPersonAction({}, form({ name: "Mustapha", email: "mustapha@cedar.example" }));
    workos.userManagement.sendInvitation.mockResolvedValue({ id: "inv_1", acceptInvitationUrl: "https://accept/1" });
    const id = (await byName("Mustapha")).id;
    await inviteAction(id);

    expect(await removePersonAction(id)).toEqual({ message: "Removed Mustapha." });
    expect(workos.userManagement.revokeInvitation).toHaveBeenCalledWith("inv_1");
    expect((await listPeople(ORG)).map((p) => p.name)).toEqual(["Ahmed"]);
  });

  it("removes a member's WorkOS membership and refuses to remove yourself", async () => {
    const joined = await linkMember(ORG, { id: "user_lina", email: "lina@cedar.example", name: "Lina" });
    workos.userManagement.listOrganizationMemberships.mockResolvedValue({ data: [{ id: "om_1" }] });
    await removePersonAction(joined.id);
    expect(workos.userManagement.deleteOrganizationMembership).toHaveBeenCalledWith("om_1");

    expect((await removePersonAction(session.person!.id)).error).toMatch(/yourself/);
  });
});
