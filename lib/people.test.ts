import { beforeEach, describe, expect, it } from "vitest";

import { createOrganization } from "@/lib/orgs";
import { getPerson, linkMember, listPeople, markInvited, removePersonByName, renamePerson, savePerson, syncPeopleSection, updatePerson } from "@/lib/people";
import { getSection } from "@/lib/profile/markdown";
import { loadProfile } from "@/lib/profile/store";
import { useTestDb } from "@/test/db";

const ORG = "org_test";

describe("people", () => {
  beforeEach(async () => {
    await useTestDb();
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
  });

  it("adds people and resolves managers by name", async () => {
    await savePerson(ORG, { name: "Ahmed", role: "Principal" });
    await savePerson(ORG, { name: "Mustapha", role: "Finance lead", managerName: "ahmed" });
    const people = await listPeople(ORG);
    expect(people.map((p) => [p.name, p.managerName, p.status])).toEqual([
      ["Ahmed", null, "not_invited"],
      ["Mustapha", "Ahmed", "not_invited"],
    ]);
  });

  it("creates unknown managers as not-invited people", async () => {
    await savePerson(ORG, { name: "Tom", managerName: "Jo" });
    expect((await listPeople(ORG)).map((p) => [p.name, p.managerName])).toEqual([
      ["Jo", null],
      ["Tom", "Jo"],
    ]);
  });

  it("only changes the fields passed", async () => {
    await savePerson(ORG, { name: "Ahmed", role: "Principal", email: "ahmed@cedar.example" });
    await savePerson(ORG, { name: "Mustapha", managerName: "Ahmed" });
    await savePerson(ORG, { name: "mustapha", responsibilities: "Masttro, cash flow" });
    const mustapha = (await listPeople(ORG)).find((p) => p.name === "Mustapha")!;
    expect(mustapha).toMatchObject({ managerName: "Ahmed", responsibilities: "Masttro, cash flow" });

    await savePerson(ORG, { name: "Mustapha", managerName: "" });
    expect((await listPeople(ORG)).find((p) => p.name === "Mustapha")!.managerName).toBeNull();
  });

  it("removing a manager leaves their reports without one", async () => {
    await savePerson(ORG, { name: "Mustapha", managerName: "Ahmed" });
    expect(await removePersonByName(ORG, "Ahmed")).toBe("removed");
    expect((await listPeople(ORG)).map((p) => [p.name, p.managerName])).toEqual([["Mustapha", null]]);
  });

  it("renames people in place and never removes someone who has signed in", async () => {
    const me = await linkMember(ORG, { id: "user_1", email: "kj@cedar.example", name: "kjdhf kjhdfs" });
    await savePerson(ORG, { name: "Mustapha", managerName: "kjdhf kjhdfs" });
    const renamed = await renamePerson(ORG, "kjdhf kjhdfs", "Abdel Wahab Turkmani");
    expect(renamed).toMatchObject({ id: me.id, name: "Abdel Wahab Turkmani", status: "active" });
    expect((await listPeople(ORG)).find((p) => p.name === "Mustapha")!.managerName).toBe("Abdel Wahab Turkmani");
    await expect(renamePerson(ORG, "Mustapha", "abdel wahab turkmani")).rejects.toThrow(/already/);
    expect(await renamePerson(ORG, "Nobody", "X")).toBeNull();

    expect(await removePersonByName(ORG, "Abdel Wahab Turkmani")).toBe("has_account");
    const sam = await savePerson(ORG, { name: "Sam" });
    expect(await removePersonByName(ORG, "Sam", { protect: [sam.id] })).toBe("has_account");
    expect(await removePersonByName(ORG, "Nobody")).toBe("not_found");
  });

  it("links a signed-in user to their invited entry by email", async () => {
    const invited = await savePerson(ORG, { name: "Mustapha", email: "Mustapha@cedar.example" });
    await markInvited(ORG, invited.id, { id: "invitation_1", url: "https://invite.example" });
    expect((await listPeople(ORG))[0]).toMatchObject({ status: "invited", inviteUrl: "https://invite.example" });

    const linked = await linkMember(ORG, { id: "user_1", email: "mustapha@cedar.example", name: "Mustapha D" });
    expect(linked).toMatchObject({ id: invited.id, status: "active", workosUserId: "user_1", inviteUrl: null });
    // Linking again is a no-op.
    expect((await linkMember(ORG, { id: "user_1", email: "x@y.z", name: "x" })).id).toBe(invited.id);
  });

  it("adds a signed-in user who isn't listed yet", async () => {
    await savePerson(ORG, { name: "Sam" });
    const added = await linkMember(ORG, { id: "user_2", email: "sam@other.example", name: "Sam" });
    expect(added).toMatchObject({ name: "sam@other.example", status: "active" });
    expect(await listPeople(ORG)).toHaveLength(2);
  });

  it("edits anyone's details from the Team page, but never a joined person's sign-in email", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
    const lina = await savePerson(ORG, { name: "Lina", email: "lina@old.example" });

    const edited = await updatePerson(ORG, lina.id, { name: "Lina Haddad", role: "Operations", responsibilities: "Banking, payroll", email: "Lina@Cedar.example", phone: "+44 7700 900456" });
    expect(edited).toMatchObject({ name: "Lina Haddad", role: "Operations", responsibilities: "Banking, payroll", email: "lina@cedar.example", phone: "+44 7700 900456" });
    await expect(updatePerson(ORG, lina.id, { name: "ahmed" })).rejects.toThrow("Someone called ahmed is already on the team.");
    await expect(updatePerson(ORG, lina.id, { email: "not an email" })).rejects.toThrow("doesn't look right");
    expect((await updatePerson(ORG, lina.id, { phone: "" })).phone).toBeNull();

    // Ahmed has joined: his email is how he signs in and how email to the Chief of Staff is matched to him.
    await expect(updatePerson(ORG, ahmed.id, { email: "intruder@evil.example" })).rejects.toThrow("signs in with");
    expect((await updatePerson(ORG, ahmed.id, { email: "ahmed@cedar.example", role: "Principal" })).role).toBe("Principal");
    // Nor can the Chief of Staff change it when told "Ahmed's email is ...".
    await savePerson(ORG, { name: "Ahmed", email: "intruder@evil.example", phone: "+44 7700 900999" });
    expect(await getPerson(ORG, ahmed.id)).toMatchObject({ email: "ahmed@cedar.example", phone: "+44 7700 900999" });
  });

  it("renders the people section of the profile from the database", async () => {
    await savePerson(ORG, { name: "Ahmed", role: "Principal" });
    await savePerson(ORG, { name: "Mustapha", role: "Finance lead", managerName: "Ahmed" });
    await syncPeopleSection(ORG);
    const section = getSection(await loadProfile(ORG), "People & Responsibilities")!;
    expect(section).toContain("| Mustapha | Finance lead | Ahmed |");
    expect(section).toContain("- **Ahmed**, Principal\n  - **Mustapha**, Finance lead");
  });
});
