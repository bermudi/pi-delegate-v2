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

type CallMode = "ticket" | "session" | "dispatch" | "help";
type SelectorMode = "ticket" | "session";

/**
 * One row per top-level argument field: the mode that owns it, how presence
 * is detected, and the whole-call rejection for carrying it where it does
 * not belong. This table is the single source of mode-shape knowledge — for
 * `validateCall`'s orphan/conflict checks here and, through
 * `hasTicketIntent`/`hasSessionIntent`, for `prepareArguments`' flat-field
 * folding decision in delegate.ts. A new top-level field means one schema
 * entry and one row here.
 *
 * Declaration order is rejection precedence: when one input violates several
 * rules, the earlier row decides the message the caller sees (tests pin
 * these choices). Insert new rows at the position matching their conflict
 * priority — dispatch-owned fields after `sessionId`.
 *
 * Deliberate omissions, preserved for identical behavior: `async` carries no
 * ticket/session foreign entries (a stray async flag beside a ticket or
 * session RPC is silently ignored today), and `sessionId` has no detached
 * entry (after folding it can only reach this module beside a selector or a
 * non-empty task list).
 */
interface FieldRule {
  /** The one mode whose calls may carry this field at top level. */
  readonly mode: CallMode;
  /**
   * Presence as the table treats it: `force` and `async` count only when
   * true (false is carried anywhere, silently), `tasks` only when
   * non-empty (help legitimately carries `[]`), the rest on being defined.
   */
  readonly carried: (args: RawArguments) => boolean;
  /**
   * Values of this mode's selector that mark intent when carried; absent
   * means mere presence does (consumed by the intent functions below).
   */
  readonly selectorValues?: readonly string[];
  /** True when the field's presence signals its mode's folding intent. */
  readonly signalsIntent?: boolean;
  /**
   * Whole-call rejection when carried inside a foreign mode, keyed by that
   * mode ("dispatch" covers the no-selector region with a non-empty task
   * list). No entry means silently ignored there.
   */
  readonly foreign?: Partial<Record<"ticket" | "session" | "dispatch", string>>;
  /** Rejection when carried with no selector at all: ticket-owned controls naming their selector. */
  readonly detached?: string;
  /** Help-facing rejection: a dispatch-owned field carried without any task. */
  readonly requiresTasks?: string;
  /**
   * Carry constraint inside the owning mode: the field may only accompany
   * that selector value. Carried beside another value is forbidden; required
   * by the value but absent names the missing field.
   */
  readonly onlyWith?: {
    readonly value: string;
    readonly forbiddenMessage: string;
    readonly missingMessage?: string;
  };
  /**
   * Inverted requirement: when the owning selector is present with any value
   * but `unless`, the field must be carried.
   */
  readonly requirement?: {
    readonly unless: string;
    readonly message: (selectorValue: string) => string;
  };
}

function carriedWhenDefined(name: keyof RawArguments): FieldRule["carried"] {
  return (args) => args[name] !== undefined;
}

const FIELD_RULES: Record<keyof RawArguments, FieldRule> = {
  ticketAction: {
    mode: "ticket",
    carried: carriedWhenDefined("ticketAction"),
    signalsIntent: true,
  },
  sessionAction: {
    mode: "session",
    carried: carriedWhenDefined("sessionAction"),
    signalsIntent: true,
    foreign: {
      ticket: `ticketAction cannot be combined with sessionAction; choose one operation.`,
    },
    // prepareArguments runs before schema validation, so intent needs the
    // valid operation values, not mere presence, to keep folding decisions
    // (and therefore recovery prose) stable for invalid selectors.
    selectorValues: ["close", "list"],
  },
  tasks: {
    mode: "dispatch",
    carried: (args) => (args.tasks ?? []).length > 0,
    foreign: {
      ticket: `ticketAction cannot be combined with tasks; dispatch work with { tasks: [...] } or run a ticket operation, not both.`,
      session: `sessionAction cannot be combined with tasks; run a session operation or dispatch work, not both.`,
    },
  },
  ticket: {
    mode: "ticket",
    carried: carriedWhenDefined("ticket"),
    signalsIntent: true,
    foreign: {
      session: `sessionAction cannot be combined with ticket, force, or timeoutMs.`,
    },
    detached: `ticket requires ticketAction "poll", "wait", "cancel", "pause", or "resume".`,
    requirement: {
      unless: "poll",
      message: (action) =>
        `ticketAction "${action}" requires a ticket id in the ticket field.`,
    },
  },
  force: {
    mode: "ticket",
    carried: (args) => args.force === true,
    foreign: {
      session: `sessionAction cannot be combined with ticket, force, or timeoutMs.`,
    },
    detached: `force is valid only with ticketAction "cancel".`,
    onlyWith: {
      value: "cancel",
      forbiddenMessage: `force is valid only with ticketAction "cancel".`,
    },
  },
  timeoutMs: {
    mode: "ticket",
    carried: carriedWhenDefined("timeoutMs"),
    foreign: {
      session: `sessionAction cannot be combined with ticket, force, or timeoutMs.`,
    },
    detached: `timeoutMs is valid only with ticketAction "wait".`,
    onlyWith: {
      value: "wait",
      forbiddenMessage: `timeoutMs is valid only with ticketAction "wait".`,
    },
  },
  sessionId: {
    mode: "session",
    carried: carriedWhenDefined("sessionId"),
    foreign: {
      ticket: `ticketAction cannot be combined with sessionId; sessionId is only valid for sessionAction close or a task.`,
      dispatch: `sessionId is a task field or belongs to sessionAction "close"; move it into a task or drop it.`,
    },
    onlyWith: {
      value: "close",
      forbiddenMessage: `sessionId is valid only with sessionAction "close" or a task.`,
      missingMessage: `sessionAction "close" requires a sessionId.`,
    },
  },
  async: {
    mode: "dispatch",
    carried: (args) => args.async === true,
    requiresTasks: `async dispatch requires at least one task.`,
  },
  workspace: {
    mode: "dispatch",
    carried: carriedWhenDefined("workspace"),
    requiresTasks: `workspace requires at least one task; it is a dispatch field.`,
    foreign: {
      ticket: `ticketAction cannot be combined with workspace; workspace is a dispatch field.`,
      session: `sessionAction cannot be combined with workspace; workspace is a dispatch field.`,
    },
  },
  operationId: {
    mode: "dispatch",
    carried: carriedWhenDefined("operationId"),
    requiresTasks: `operationId requires a non-empty dispatch task list.`,
    foreign: {
      ticket: `ticketAction cannot be combined with operationId; operationId is a dispatch field.`,
      session: `sessionAction cannot be combined with operationId; operationId is a dispatch field.`,
    },
  },
};

/**
 * Top-level evidence that the caller means the ticket RPC rather than work:
 * the `ticketAction` selector, or the `ticket` field. `force`/`timeoutMs`
 * are ticket-owned too but deliberately do not signal intent — beside flat
 * task fields they fold into the task and fail later as detached controls,
 * matching the SPEC repair list. Consumed by delegate.ts's folding decision.
 */
export function hasTicketIntent(
  args: Pick<RawArguments, "ticketAction" | "ticket">,
): boolean {
  return signalsMode("ticket", args);
}

/**
 * Top-level evidence that the caller means the session RPC: the
 * `sessionAction` selector carrying one of its operation values. A bare
 * `sessionId` is task-reuse intent, not session intent. Consumed by
 * delegate.ts's folding decision.
 */
export function hasSessionIntent(
  args: Pick<RawArguments, "sessionAction">,
): boolean {
  return signalsMode("session", args);
}

function signalsMode(mode: SelectorMode, args: RawArguments): boolean {
  for (const [name, rule] of Object.entries(FIELD_RULES)) {
    if (rule.mode !== mode || rule.signalsIntent !== true || !rule.carried(args)) {
      continue;
    }
    const accepted = rule.selectorValues;
    if (accepted === undefined) return true;
    const value = args[name as keyof RawArguments];
    if (typeof value === "string" && accepted.includes(value)) return true;
  }
  return false;
}

/** Reject fields owned by another selector mode; row order picks the message. */
function rejectForeignFields(mode: SelectorMode, args: RawArguments): void {
  for (const rule of Object.values(FIELD_RULES)) {
    if (rule.mode === mode) continue;
    const message = rule.foreign?.[mode];
    if (message === undefined) continue;
    if (rule.carried(args)) fail(message);
  }
}

/**
 * Enforce the owning mode's carry rules in two passes — conditional carries,
 * then requirements — so a multi-violation input names the conditional
 * control before the missing one, as the contract has always done.
 */
function enforceCarryRules(
  mode: SelectorMode,
  selector: string,
  args: RawArguments,
): void {
  for (const rule of Object.values(FIELD_RULES)) {
    if (rule.mode !== mode || rule.onlyWith === undefined) continue;
    const { value, forbiddenMessage, missingMessage } = rule.onlyWith;
    if (selector === value) {
      if (!rule.carried(args) && missingMessage !== undefined) {
        fail(missingMessage);
      }
    } else if (rule.carried(args)) {
      fail(forbiddenMessage);
    }
  }
  for (const rule of Object.values(FIELD_RULES)) {
    const requirement = rule.requirement;
    if (rule.mode !== mode || requirement === undefined) continue;
    if (selector !== requirement.unless && !rule.carried(args)) {
      fail(requirement.message(selector));
    }
  }
}

/**
 * No selector selected: fields carried away from their mode. Ticket-owned
 * controls name their missing selector, a session-owned sessionId beside
 * real work belongs inside a task, and dispatch-owned fields without any
 * task are help-mode violations.
 */
function rejectDetachedFields(args: RawArguments, hasTasks: boolean): void {
  for (const rule of Object.values(FIELD_RULES)) {
    if (!rule.carried(args)) continue;
    if (rule.mode === "ticket" && rule.detached !== undefined) {
      fail(rule.detached);
    }
    if (rule.mode === "session" && hasTasks && rule.foreign?.dispatch !== undefined) {
      fail(rule.foreign.dispatch);
    }
    if (rule.mode === "dispatch" && !hasTasks && rule.requiresTasks !== undefined) {
      fail(rule.requiresTasks);
    }
  }
}

/**
 * Mode selection and semantic validation. Runs after schema validation and
 * before any task starts; every rejection is an actionable whole-call error.
 * Mode precedence is SPEC order — ticket RPC, session RPC, dispatch, help —
 * with the field-ownership table deciding each mode's shape rejections.
 */
export function validateCall(args: RawArguments): ValidatedCall {
  const tasks = args.tasks ?? [];
  const hasTasks = tasks.length > 0;

  if (args.ticketAction !== undefined) {
    rejectForeignFields("ticket", args);
    enforceCarryRules("ticket", args.ticketAction, args);
    return {
      mode: "ticket",
      action: args.ticketAction,
      ticket: args.ticket,
      force: args.force === true,
      timeoutMs: args.timeoutMs,
    };
  }

  if (args.sessionAction !== undefined) {
    rejectForeignFields("session", args);
    enforceCarryRules("session", args.sessionAction, args);
    return {
      mode: "session",
      action: args.sessionAction,
      sessionId: args.sessionId,
    };
  }

  rejectDetachedFields(args, hasTasks);

  if (!hasTasks) {
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
