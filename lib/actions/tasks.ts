import "server-only";

import { z } from "zod";

import { agentFor, defineAction, fileFor, memberFor, taskFor, taskRef, type ActionScope } from "@/lib/actions/define";
import { appUrl } from "@/lib/app-url";
import { detachFromTask } from "@/lib/files";
import { attachFileAs, OperationError } from "@/lib/operations";
import { addMessage, PRIORITIES, removeMember, setTaskVisibility, TASK_STATUSES, updateTask } from "@/lib/tasks";
import {
  addToTask,
  archiveTask,
  pauseTaskSchedule,
  pickOption,
  rerunScript,
  runNow,
  scheduleTask,
  setStatus,
  unarchiveTask,
  unscheduleTask,
} from "@/lib/work";

// What a task's screen does. Only tasks the person can see (taskFor).

const by = ({ actor }: ActionScope) => ({ name: actor.name, personId: actor.personId });
const link = (number: number) => appUrl(`/tasks/${number}`);

export const taskActions = [
  defineAction({
    name: "task.set_status",
    description: "Move a task to a status (open, ready, working, waiting, review, done, cancelled…).",
    input: z.object({ task: taskRef, status: z.enum(TASK_STATUSES) }),
    run: async (scope, { task, status }) => {
      const found = await taskFor(scope.actor, task);
      await setStatus(scope.actor.organizationId, found.id, status, by(scope));
      return `#${found.number} is now ${status}. ${link(found.number)}`;
    },
  }),
  defineAction({
    name: "task.set_priority",
    description: "Set a task's priority.",
    input: z.object({ task: taskRef, priority: z.enum(PRIORITIES) }),
    run: async (scope, { task, priority }) => {
      const found = await taskFor(scope.actor, task);
      await updateTask(scope.actor.organizationId, found.id, { priority });
      return `#${found.number} is ${priority} priority.`;
    },
  }),
  defineAction({
    name: "task.later",
    description: "Put a task off (out of Needs you) until a time, or bring it back now with no time.",
    input: z.object({ task: taskRef, until: z.string().nullable().optional().describe("ISO 8601 time; null or empty brings it back.") }),
    run: async (scope, { task, until }) => {
      const found = await taskFor(scope.actor, task);
      const date = until ? new Date(until) : null;
      if (date && Number.isNaN(date.getTime())) throw new OperationError("That time doesn't look right.");
      await updateTask(scope.actor.organizationId, found.id, { laterUntil: date });
      if (date) {
        await addMessage(found.id, { author: scope.actor.name, personId: scope.actor.personId, kind: "event", body: `Put this off until ${date.toISOString().slice(0, 16).replace("T", " ")} UTC.` });
      }
      return date ? `#${found.number} is put off until ${date.toISOString()}.` : `#${found.number} is back.`;
    },
  }),
  defineAction({
    name: "task.edit",
    description: "Change a task's title, description, context or progress notes.",
    input: z.object({
      task: taskRef,
      title: z.string().max(100).optional(),
      description: z.string().optional(),
      context: z.string().optional(),
      progress: z.string().optional(),
    }),
    run: async (scope, { task, ...patch }) => {
      if (patch.title !== undefined && !patch.title.trim()) throw new OperationError("A task needs a title.");
      const found = await taskFor(scope.actor, task);
      await updateTask(scope.actor.organizationId, found.id, patch);
      return `Saved #${found.number}.`;
    },
  }),
  defineAction({
    name: "task.add_member",
    description: "Put a person or an agent on a task (an agent on it starts work), or a new worker agent with a role.",
    input: z.object({ task: taskRef, member: z.string().optional().describe("Exact name (or id) of a person or agent."), workerRole: z.string().optional() }),
    run: async (scope, { task, member, workerRole }) => {
      const found = await taskFor(scope.actor, task);
      if (!member && !workerRole) throw new OperationError("Say who to add.");
      await addToTask(scope.actor.organizationId, found.id, by(scope), member ? await memberFor(scope.actor, member) : { workerRole });
      return `Added ${member ?? `a ${workerRole} worker`} to #${found.number}.`;
    },
  }),
  defineAction({
    name: "task.remove_member",
    description: "Take a person or an agent off a task.",
    input: z.object({ task: taskRef, member: z.string().describe("Exact name (or id) of the person or agent.") }),
    run: async (scope, { task, member }) => {
      const found = await taskFor(scope.actor, task);
      const leaving = found.members.find((m) => m.id === member || m.name.trim().toLowerCase() === member.trim().toLowerCase());
      if (!leaving) throw new OperationError(`${member} isn't on #${found.number}.`);
      await removeMember(found.id, leaving.type === "person" ? { personId: leaving.id } : { agentId: leaving.id });
      await addMessage(found.id, { author: scope.actor.name, personId: scope.actor.personId, kind: "event", body: `Took ${leaving.name} off this task.` });
      return `Took ${leaving.name} off #${found.number}.`;
    },
  }),
  defineAction({
    name: "task.run_agent",
    description: "Run one of the agents on a task now.",
    input: z.object({ task: taskRef, agent: z.string().describe("Exact name (or id) of an agent on it.") }),
    run: async (scope, { task, agent }) => {
      const found = await taskFor(scope.actor, task);
      const runner = await agentFor(scope.actor, agent);
      await runNow(scope.actor.organizationId, found.id, runner.id, by(scope));
      return `${runner.name} is working on #${found.number}.`;
    },
  }),
  defineAction({
    name: "task.pick_option",
    description: "Answer a task's question by picking one of the options it offers (by its label, or 1 for the first).",
    input: z.object({ task: taskRef, option: z.union([z.number().int().positive(), z.string().min(1)]) }),
    run: async (scope, { task, option }) => {
      const found = await taskFor(scope.actor, task);
      const index =
        typeof option === "number" ? option - 1 : found.options.findIndex((o) => o.label.trim().toLowerCase() === option.trim().toLowerCase());
      if (index < 0 || index >= found.options.length) throw new OperationError(`#${found.number} doesn't offer that option.`);
      await pickOption(scope.actor.organizationId, found.id, by(scope), index);
      return `Picked "${found.options[index].label}" on #${found.number}.`;
    },
  }),
  defineAction({
    name: "task.archive",
    description: "Archive a task (its sandbox goes), or bring it back from the archive.",
    input: z.object({ task: taskRef, archived: z.boolean().default(true) }),
    run: async (scope, { task, archived }) => {
      const found = await taskFor(scope.actor, task);
      if (archived) await archiveTask(scope.actor.organizationId, found.id, by(scope));
      else await unarchiveTask(scope.actor.organizationId, found.id, by(scope));
      return archived ? `Archived #${found.number}.` : `#${found.number} is back from the archive.`;
    },
  }),
  defineAction({
    name: "task.attach_file",
    description: "Put one of the company's files on a task as an input, so its agent works from it.",
    input: z.object({ task: taskRef, file: z.string().describe("Its exact name in Files (or id).") }),
    run: async (scope, { task, file }) => {
      const found = await taskFor(scope.actor, task);
      const attaching = await fileFor(scope.actor, file);
      await attachFileAs(scope.actor, found.id, attaching.id);
      return `Attached ${attaching.name} to #${found.number}.`;
    },
  }),
  defineAction({
    name: "task.detach_file",
    description: "Take a file off a task (it stays in Files).",
    input: z.object({ task: taskRef, file: z.string() }),
    run: async (scope, { task, file }) => {
      const found = await taskFor(scope.actor, task);
      const leaving = await fileFor(scope.actor, file);
      await detachFromTask(found.id, leaving.id);
      return `Took ${leaving.name} off #${found.number}.`;
    },
  }),
  defineAction({
    name: "task.set_schedule",
    description: "Make a job repeat, or change its schedule: a five-field cron in a timezone; script replays its run.sh, agent does the job each time.",
    input: z.object({ task: taskRef, cron: z.string(), timezone: z.string(), mode: z.enum(["script", "agent"]) }),
    run: async (scope, { task, ...schedule }) => {
      const found = await taskFor(scope.actor, task);
      await scheduleTask(scope.actor.organizationId, found.id, by(scope), schedule);
      return `#${found.number} repeats on its new schedule.`;
    },
  }),
  defineAction({
    name: "task.pause_schedule",
    description: "Pause a repeating job, or resume it.",
    input: z.object({ task: taskRef, paused: z.boolean() }),
    run: async (scope, { task, paused }) => {
      const found = await taskFor(scope.actor, task);
      await pauseTaskSchedule(scope.actor.organizationId, found.id, by(scope), paused);
      return paused ? `Paused #${found.number}'s schedule.` : `Resumed #${found.number}'s schedule.`;
    },
  }),
  defineAction({
    name: "task.remove_schedule",
    description: "Stop a job repeating.",
    input: z.object({ task: taskRef }),
    run: async (scope, { task }) => {
      const found = await taskFor(scope.actor, task);
      await unscheduleTask(scope.actor.organizationId, found.id, by(scope));
      return `#${found.number} no longer repeats.`;
    },
  }),
  defineAction({
    name: "task.rerun_script",
    description: "Run a job's script (run.sh) again now.",
    input: z.object({ task: taskRef }),
    run: async (scope, { task }) => {
      const found = await taskFor(scope.actor, task);
      await rerunScript(scope.actor.organizationId, found.id, by(scope));
      return `Re-running #${found.number}'s script.`;
    },
  }),
  defineAction({
    name: "task.set_visibility",
    description: "Share a task with the whole company, or make it private to whoever created it and the people on it (they, or an admin).",
    input: z.object({ task: taskRef, visibility: z.enum(["company", "private"]) }),
    run: async (scope, { task, visibility }) => {
      const found = await taskFor(scope.actor, task);
      if (found.createdByPersonId !== scope.actor.personId && !scope.actor.isAdmin) {
        throw new OperationError("Only whoever created it, or an admin, can change who sees it.");
      }
      await setTaskVisibility(scope.actor.organizationId, found.id, visibility);
      return visibility === "company" ? `#${found.number} is shared with the company.` : `#${found.number} is private.`;
    },
  }),
];
