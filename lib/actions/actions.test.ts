import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChiefOfStaff } from "@/lib/agents/chief-of-staff";
import { setScheduler } from "@/lib/agents/dispatch";
import { createAgent, getAgent } from "@/lib/agents/store";
import { getDb } from "@/lib/db";
import type { Actor } from "@/lib/operations";
import { createOrganization, getOrganization } from "@/lib/orgs";
import { getPerson, linkMember, savePerson } from "@/lib/people";
import { createTask, getTaskByNumber } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { doAction } from "@/test/do-action";
import { scriptedModel } from "@/test/scripted-model";


const workos = {
  userManagement: {
    sendInvitation: vi.fn(async () => ({ id: "inv_1", acceptInvitationUrl: "https://auth.example/invite" })),
    resendInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    listOrganizationMemberships: vi.fn(async () => ({ data: [] })),
    deleteOrganizationMembership: vi.fn(),
  },
};
vi.mock("@workos-inc/authkit-nextjs", () => ({ getWorkOS: () => workos }));

const ORG = "org_cedar";

const use = doAction;

describe("actions, done from chat as the screens do them", () => {
  let admin: Actor;
  let member: Actor;

  beforeEach(async () => {
    await useTestDb();
    vi.clearAllMocks();
    setScheduler(() => {}); // agent runs aren't part of this test
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const sara = await linkMember(ORG, { id: "user_sara", email: "sara@cedar.example", name: "Sara" });
    const omar = await linkMember(ORG, { id: "user_omar", email: "omar@cedar.example", name: "Omar" });
    admin = { organizationId: ORG, personId: sara.id, name: "Sara", userId: "user_sara", isAdmin: true };
    member = { organizationId: ORG, personId: omar.id, name: "Omar", userId: "user_omar", isAdmin: false };
    await savePerson(ORG, { name: "Lina Haddad", email: "lina@cedar.example" });
  });
  afterEach(() => setScheduler(null));

  it("invites and removes people only for admins, like the Team page", async () => {
    expect(await use(member, "person.invite", { person: "Lina Haddad" })).toBe("Not done: Only admins can do that (person.invite).");
    expect(workos.userManagement.sendInvitation).not.toHaveBeenCalled();

    expect(await use(admin, "person.invite", { person: "Lina Haddad" })).toBe("Invitation sent to lina@cedar.example.");
    expect(workos.userManagement.sendInvitation).toHaveBeenCalledWith({ email: "lina@cedar.example", organizationId: ORG, inviterUserId: "user_sara" });

    expect(await use(member, "person.remove", { person: "Lina Haddad" })).toBe("Not done: Only admins can do that (person.remove).");
    expect(await use(admin, "person.remove", { person: "Sara" })).toBe("Not done: You can't remove yourself.");
    expect(await use(admin, "person.remove", { person: "Lina Haddad" })).toBe("Removed Lina Haddad.");
    expect(workos.userManagement.revokeInvitation).toHaveBeenCalledWith("inv_1");
    expect(await use(admin, "person.invite", { person: "Nobody" })).toBe("Not done: No one called Nobody is on the Team page.");
    expect(await use(admin, "person.fly", {})).toBe("Not done: There's no action called person.fly. Pick a name from the catalogue.");
    expect(await use(admin, "person.invite", {})).toMatch(/^Not done: That doesn't fit person.invite: person: /);
  });

  it("changes a task the way its screen does, and never one they can't see", async () => {
    const writer = await createAgent(ORG, { name: "Writer" });
    const task = await createTask(ORG, { title: "Draft the letter", createdBy: { personId: admin.personId } });
    expect(await use(member, "task.edit", { task: task.number, title: "Draft the board letter" })).toBe("Saved #1.");
    expect(await use(member, "task.set_status", { task: "1", status: "review" })).toMatch(/^#1 is now review\. https?:\/\/.+\/tasks\/1$/);
    expect(await use(member, "task.set_priority", { task: 1, priority: "high" })).toBe("#1 is high priority.");
    expect(await use(member, "task.add_member", { task: 1, member: "Writer" })).toBe("Added Writer to #1.");
    expect(await getTaskByNumber(ORG, 1)).toMatchObject({ title: "Draft the board letter", status: "review", priority: "high" });
    expect((await getTaskByNumber(ORG, 1))!.members.map((m) => m.name)).toContain(writer.name);

    const secret = await createTask(ORG, { title: "Sara's own", createdBy: { personId: admin.personId }, visibility: "private" });
    expect(await use(member, "task.archive", { task: secret.number })).toBe(`Not done: There's no task #${secret.number}.`);
    expect(await use(member, "task.set_visibility", { task: 1, visibility: "private" })).toBe("Not done: Only whoever created it, or an admin, can change who sees it.");
    expect((await getTaskByNumber(ORG, secret.number))!.archivedAt).toBeNull();
  });

  it("changes an agent's model, and the company's models only for admins", async () => {
    const analyst = await createAgent(ORG, { name: "Analyst" });
    expect(await use(member, "agent.update", { agent: "Analyst", model: "anthropic/claude-sonnet-4.5" })).toMatch(/^Saved Analyst\./);
    expect((await getAgent(ORG, analyst.id))!.model).toBe("anthropic/claude-sonnet-4.5");
    expect(await use(member, "agent.update", { agent: "Analyst", model: "nonsense" })).toMatch(/^Not done: nonsense isn't a model id/);

    expect(await use(member, "company.set_models", { chiefOfStaff: "openai/gpt-5-mini" })).toBe("Not done: Only admins can do that (company.set_models).");
    expect(await use(admin, "company.set_models", { chiefOfStaff: "openai/gpt-5-mini" })).toMatch(/^Saved\./);
    expect((await getOrganization(ORG))!.models).toEqual({ chiefOfStaff: "openai/gpt-5-mini" });
  });

  it("knows who has joined, what they may do, and links to the exact screen", async () => {
    await getDb().query("update people set status = 'invited' where organization_id = $1 and name = 'Lina Haddad'", [ORG]);
    const organization = { ...(await getOrganization(ORG))!, onboardingCompletedAt: new Date() };
    const model = scriptedModel(["Ok."]);
    await createChiefOfStaff(
      {
        organization,
        user: { id: "user_omar", email: "omar@cedar.example", name: "Omar" },
        person: (await getPerson(ORG, member.personId))!,
        profile: "",
        isAdmin: false,
        team: [
          { name: "Sara", status: "active", admin: true },
          { name: "Omar", status: "active", admin: false },
          { name: "Lina Haddad", status: "invited", admin: false },
        ],
      },
      { model, research: false },
    ).generate({ prompt: "who's joined?" });
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("- Lina Haddad: invited, not joined yet");
    expect(prompt).toContain("- Sara: joined, admin");
    expect(prompt).toContain("they're a member, not an admin");
    expect(prompt).toMatch(/- Team: https?:\/\/[^ ]+\/team \(Left menu → Team\)/);
    expect(prompt).toContain("Never through chat, whoever asks: credentials");
    // The catalogue: everything a member may do, not what's for admins.
    expect(prompt).toContain("- task.set_status(task, status): ");
    expect(prompt).toContain("- me.set_hours(timezone, days, start, end, quietStart, quietEnd): ");
    expect(prompt).not.toContain("person.invite");
  });
});
