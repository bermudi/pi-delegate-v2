import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { expandTools, getBuiltinProfile, knownAgentNames } from "./profiles.ts";

export interface TaskInput {
  readonly id?: string;
  readonly prompt?: string;
  readonly agent?: string;
  readonly cwd?: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly tools?: string[];
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly sessionId?: string;
  readonly resumeFrom?: string;
  readonly deadlineMs?: number;
  readonly workspace?: "shared" | "scratch" | "isolated";
}

export type ValidatedCall =
  | { readonly mode: "help" }
  | {
      readonly mode: "ticket";
      readonly action: "poll" | "wait" | "cancel" | "pause" | "resume";
      readonly ticket: string | undefined;
      readonly force: boolean;
      readonly timeoutMs: number | undefined;
    }
  | {
      readonly mode: "session";
      readonly action: "list" | "close";
      readonly sessionId: string | undefined;
    }
  | {
      readonly mode: "dispatch";
      readonly tasks: readonly TaskInput[];
      readonly async: boolean;
      readonly operationId: string | undefined;
    };

export interface RawArguments {
  readonly ticketAction?: "poll" | "cancel" | "wait" | "pause" | "resume";
  readonly sessionAction?: "close" | "list";
  readonly sessionId?: string;
  readonly async?: boolean;
  readonly ticket?: string;
  readonly force?: boolean;
  readonly timeoutMs?: number;
  /** Batch-level workspace default; a task's own `workspace` wins. */
  readonly workspace?: "shared" | "scratch" | "isolated";
  readonly tasks?: TaskInput[];
  readonly operationId?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Mode selection and semantic validation. Runs after schema validation and
 * before any task starts; every rejection is an actionable whole-call error.
 */
export function validateCall(args: RawArguments): ValidatedCall {
  const tasks = args.tasks ?? [];
  const hasTasks = tasks.length > 0;

  if (args.ticketAction !== undefined) {
    if (args.sessionAction !== undefined) {
      fail(
        `ticketAction cannot be combined with sessionAction; choose one operation.`,
      );
    }
    if (hasTasks) {
      fail(
        `ticketAction cannot be combined with tasks; dispatch work with { tasks: [...] } or run a ticket operation, not both.`,
      );
    }
    if (args.sessionId !== undefined) {
      fail(
        `ticketAction cannot be combined with sessionId; sessionId is only valid for sessionAction close or a task.`,
      );
    }
    if (args.workspace !== undefined) {
      fail(
        `ticketAction cannot be combined with workspace; workspace is a dispatch field.`,
      );
    }
    if (args.operationId !== undefined) {
      fail(
        `ticketAction cannot be combined with operationId; operationId is a dispatch field.`,
      );
    }
    const action = args.ticketAction;
    if (action !== "cancel" && args.force === true) {
      fail(`force is valid only with ticketAction "cancel".`);
    }
    if (action !== "wait" && args.timeoutMs !== undefined) {
      fail(`timeoutMs is valid only with ticketAction "wait".`);
    }
    if (action !== "poll" && args.ticket === undefined) {
      fail(`ticketAction "${action}" requires a ticket id in the ticket field.`);
    }
    return {
      mode: "ticket",
      action,
      ticket: args.ticket,
      force: args.force === true,
      timeoutMs: args.timeoutMs,
    };
  }

  if (args.sessionAction !== undefined) {
    if (hasTasks) {
      fail(
        `sessionAction cannot be combined with tasks; run a session operation or dispatch work, not both.`,
      );
    }
    if (args.ticket !== undefined || args.force === true || args.timeoutMs !== undefined) {
      fail(
        `sessionAction cannot be combined with ticket, force, or timeoutMs.`,
      );
    }
    if (args.workspace !== undefined) {
      fail(
        `sessionAction cannot be combined with workspace; workspace is a dispatch field.`,
      );
    }
    if (args.operationId !== undefined) {
      fail(
        `sessionAction cannot be combined with operationId; operationId is a dispatch field.`,
      );
    }
    if (args.sessionAction === "close" && args.sessionId === undefined) {
      fail(`sessionAction "close" requires a sessionId.`);
    }
    if (args.sessionAction === "list" && args.sessionId !== undefined) {
      fail(`sessionId is valid only with sessionAction "close" or a task.`);
    }
    return {
      mode: "session",
      action: args.sessionAction,
      sessionId: args.sessionId,
    };
  }

  if (args.ticket !== undefined) {
    fail(`ticket requires ticketAction "poll", "wait", "cancel", "pause", or "resume".`);
  }
  if (args.force === true) {
    fail(`force is valid only with ticketAction "cancel".`);
  }
  if (args.timeoutMs !== undefined) {
    fail(`timeoutMs is valid only with ticketAction "wait".`);
  }

  if (hasTasks && args.sessionId !== undefined) {
    fail(
      `sessionId is a task field or belongs to sessionAction "close"; move it into a task or drop it.`,
    );
  }

  if (!hasTasks) {
    if (args.async === true) {
      fail(`async dispatch requires at least one task.`);
    }
    if (args.workspace !== undefined) {
      fail(`workspace requires at least one task; it is a dispatch field.`);
    }
    if (args.operationId !== undefined) {
      fail(`operationId requires a non-empty dispatch task list.`);
    }
    return { mode: "help" };
  }

  // The batch-level workspace is a default: tasks that name their own keep it.
  const effectiveTasks =
    args.workspace === undefined
      ? tasks
      : tasks.map((task) =>
          task.workspace === undefined
            ? { ...task, workspace: args.workspace }
            : task,
        );
  validateTasks(effectiveTasks);
  return {
    mode: "dispatch",
    tasks: effectiveTasks,
    async: args.async === true,
    operationId: args.operationId,
  };
}

/** Batch-level checks over normalized tasks; all run before any task starts. */
function validateTasks(tasks: readonly TaskInput[]): void {
  const ids = new Set<string>();
  const sessionIds = new Set<string>();
  tasks.forEach((task, index) => {
    const where = `tasks[${index}]${task.id ? ` (id '${task.id}')` : ""}`;
    if (task.id !== undefined) {
      if (ids.has(task.id)) {
        fail(`Duplicate task id '${task.id}'; task ids must be unique within a call.`);
      }
      ids.add(task.id);
    }
    if (task.sessionId !== undefined) {
      if (task.sessionId.trim() === "") {
        fail(`${where}: sessionId must be a non-empty string.`);
      }
      if (sessionIds.has(task.sessionId)) {
        fail(
          `Duplicate sessionId '${task.sessionId}'; a session cannot run two tasks at once.`,
        );
      }
      sessionIds.add(task.sessionId);
    }
    if (task.model !== undefined) {
      fail(
        `${where}: the model field is not accepted — callers do not select subagent models. ` +
          `Remove it: the task runs on the parent's model, or on the model the user ` +
          `configured for its agent under "models" in the delegate.json config.`,
      );
    }
    if (task.prompt === undefined && task.resumeFrom === undefined) {
      fail(`${where}: a task needs a prompt (prompt is optional only with resumeFrom).`);
    }
    if (task.deadlineMs !== undefined && task.deadlineMs <= 0) {
      fail(`${where}: deadlineMs must be positive; got ${task.deadlineMs}.`);
    }
    if (
      (task.workspace === "scratch" || task.workspace === "isolated") &&
      (task.sessionId !== undefined || task.resumeFrom !== undefined)
    ) {
      fail(
        `${where}: workspace "${task.workspace}" is one-shot and cannot be combined with sessionId or resumeFrom.`,
      );
    }
    if (task.resumeFrom !== undefined) {
      if (!isAbsolute(task.resumeFrom) || !task.resumeFrom.endsWith(".jsonl")) {
        fail(
          `${where}: resumeFrom must be an absolute path to a .jsonl session transcript; got '${task.resumeFrom}'.`,
        );
      }
      if (!existsSync(task.resumeFrom)) {
        fail(
          `${where}: resumeFrom transcript does not exist: '${task.resumeFrom}'.`,
        );
      }
    }
    if (task.agent !== undefined && getBuiltinProfile(task.agent) === undefined) {
      fail(
        `${where}: unknown agent '${task.agent}'. Known agents: ${knownAgentNames().join(", ")}.`,
      );
    }
    if (task.tools !== undefined) {
      const expanded = expandTools(task.tools);
      if (typeof expanded === "string") {
        fail(`${where}: ${expanded}`);
      }
    }
  });
}
