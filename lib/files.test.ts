import { beforeEach, describe, expect, it } from "vitest";

import { createOrganization } from "@/lib/orgs";
import { linkMember } from "@/lib/people";
import { createTask } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import {
  attachToTask,
  findFiles,
  listLibrary,
  listTaskFiles,
  readTaskFiles,
  readVersion,
  saveVersion,
} from "./files";

const ORG = "org_cedar";

async function seed() {
  await createOrganization({ id: ORG, name: "Cedar Legacy" });
  await createOrganization({ id: "org_other", name: "Other" });
  const ahmed = await linkMember(ORG, { id: "user_ahmed", email: "ahmed@cedar.example", name: "Ahmed" });
  const first = await createTask(ORG, { title: "Build the portfolio model", people: [ahmed.id] });
  const second = await createTask(ORG, { title: "Add a 70/30 case", people: [ahmed.id] });
  return { first, second };
}

describe("file library", () => {
  beforeEach(async () => {
    await useTestDb();
  });

  it("keeps versions of a job's files and skips unchanged saves", async () => {
    const { first } = await seed();
    const v1 = await saveVersion(ORG, { name: "model.xlsx", kind: "deliverable", bytes: Buffer.from("v1"), taskId: first.id });
    const same = await saveVersion(ORG, { name: "model.xlsx", kind: "deliverable", bytes: Buffer.from("v1"), taskId: first.id });
    const v2 = await saveVersion(ORG, {
      name: "MODEL.xlsx",
      kind: "deliverable",
      bytes: Buffer.from("v2!"),
      taskId: first.id,
      note: "70/30",
    });

    expect([v1.version, same.unchanged, v2.version, v2.basedOn, v2.fileId]).toEqual([1, true, 2, 1, v1.fileId]);
    const [file] = await listTaskFiles(ORG, first.id);
    expect(file).toMatchObject({ name: "model.xlsx", kind: "deliverable", role: "output" });
    expect(file.versions.map((v) => [v.version, v.size, v.taskNumber, v.note])).toEqual([
      [2, 3, 1, "70/30"],
      [1, 2, 1, ""],
    ]);
    expect(file.versions[0].contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const content = await readVersion(ORG, v1.versionId);
    expect(content?.bytes.toString()).toBe("v1");
    expect(await readVersion("org_other", v1.versionId)).toBeNull();
  });

  it("lets a new job start from a file and save its next version", async () => {
    const { first, second } = await seed();
    const v1 = await saveVersion(ORG, { name: "model.xlsx", kind: "deliverable", bytes: Buffer.from("60/40"), taskId: first.id });
    await saveVersion(ORG, { name: "simulate.py", kind: "code", bytes: Buffer.from("print(1)"), taskId: first.id });

    const [found] = await findFiles(ORG, ["Model.xlsx"]);
    await attachToTask(ORG, second.id, found.id, "input");
    await expect(attachToTask("org_other", second.id, found.id)).rejects.toThrow(/isn't in this company/);

    expect((await readTaskFiles(ORG, second.id)).map((f) => [f.name, f.role, f.version, f.bytes.toString()])).toEqual([
      ["model.xlsx", "input", 1, "60/40"],
    ]);
    const v2 = await saveVersion(ORG, { name: "model.xlsx", kind: "deliverable", bytes: Buffer.from("70/30"), taskId: second.id });
    expect([v2.fileId, v2.version]).toEqual([v1.fileId, 2]);

    const library = await listLibrary(ORG);
    expect(library.map((f) => [f.name, f.kind, f.versions.map((v) => v.taskNumber)])).toEqual([
      ["model.xlsx", "deliverable", [2, 1]],
      ["simulate.py", "code", [1]],
    ]);
  });

  it("refuses files that are too big or outside the company", async () => {
    const { first } = await seed();
    const saved = await saveVersion(ORG, { name: "a.csv", kind: "deliverable", bytes: Buffer.from("x"), taskId: first.id });
    await expect(
      saveVersion("org_other", { name: "a.csv", kind: "deliverable", bytes: Buffer.from("y"), fileId: saved.fileId }),
    ).rejects.toThrow(/isn't in this company/);
    await expect(
      saveVersion(ORG, { name: "big.bin", kind: "deliverable", bytes: Buffer.alloc(26 * 1024 * 1024) }),
    ).rejects.toThrow(/larger than/);
  });
});
