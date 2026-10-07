// Task statuses and priorities, and the words the app uses for them. Shared by
// the server and the browser.

export const TASK_STATUSES = ["backlog", "ready", "in_progress", "waiting", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUS_WORDS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  waiting: "Waiting",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

export const PRIORITY_WORDS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** The board's columns, left to right. Cancelled tasks are left off. */
export const BOARD_COLUMNS: TaskStatus[] = ["backlog", "ready", "in_progress", "waiting", "review", "done"];
