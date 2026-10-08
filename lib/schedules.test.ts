import { beforeEach, describe, expect, it } from "vitest";

import { createOrganization } from "@/lib/orgs";
import { createTask, setArchived } from "@/lib/tasks";
import { useTestDb } from "@/test/db";
import { describeSchedule, getSchedule, nextRun, saveSchedule, scheduleProblem, setPaused, takeDueRuns } from "./schedules";

const ORG = "org_cedar";

let pg: Awaited<ReturnType<typeof useTestDb>>;

describe("schedules", () => {
  beforeEach(async () => {
    pg = await useTestDb();
  });

  it("checks and describes schedules in the company's timezone", () => {
    expect(scheduleProblem("0 16 * * 1-5", "Europe/London")).toBeNull();
    expect(scheduleProblem("0 16 * *", "Europe/London")).toMatch(/five-field/);
    expect(scheduleProblem("0 16 * * 1-5", "Mars/Base")).toMatch(/isn't a timezone/);
    expect(scheduleProblem("*/5 * * * *", "Europe/London")).toMatch(/15 minutes apart/);
    expect(describeSchedule("0 16 * * 1-5", "Europe/London")).toBe("At 16:00, Monday through Friday (Europe/London)");
    // 16:00 in London is 15:00 UTC in summer time.
    expect(nextRun("0 16 * * 1-5", "Europe/London", new Date("2026-10-07T15:30:00Z"))).toEqual(new Date("2026-10-08T15:00:00Z"));
  });

  it("starts each due run once, and skips paused and archived jobs", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const daily = await createTask(ORG, { title: "Chart the option flow" });
    const paused = await createTask(ORG, { title: "Weekly digest" });
    const archived = await createTask(ORG, { title: "Old job" });
    for (const task of [daily, paused, archived]) await saveSchedule(task.id, { cron: "0 16 * * *", timezone: "Europe/London" });
    await setPaused(paused.id, true);
    await setArchived(ORG, archived.id, true);

    const first = (await getSchedule(daily.id))!.nextRunAt!;
    const later = new Date(first.getTime() + 60_000);
    const [taken, again] = [await takeDueRuns(later), await takeDueRuns(later)];
    expect(taken).toEqual([{ taskId: daily.id, organizationId: ORG, dueAt: first }]);
    expect(again).toEqual([]);
    expect((await getSchedule(daily.id))!.nextRunAt).toEqual(nextRun("0 16 * * *", "Europe/London", later));
  });

  it("takes runs that are due by the database's clock, whatever the timestamp's precision", async () => {
    await createOrganization({ id: ORG, name: "Cedar Legacy" });
    const task = await createTask(ORG, { title: "Chart the option flow" });
    await saveSchedule(task.id, { cron: "0 16 * * *", timezone: "Europe/London" });
    await pg.query("update task_schedules set next_run_at = now() - interval '1.234567 seconds' where task_id = $1", [task.id]);
    expect((await takeDueRuns()).map((r) => r.taskId)).toEqual([task.id]);
    expect(await takeDueRuns()).toEqual([]);
  });
});
