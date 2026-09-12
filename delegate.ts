import { Type, type SchemaOptions, type Static } from "@sinclair/typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options: SchemaOptions,
) {
  return Type.Unsafe<Values[number]>({
    ...options,
    type: "string",
    enum: [...values],
  });
}

const taskSchema = Type.Object(
  {
    id: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9._-]{1,64}$",
        description: "Optional correlation key.",
      }),
    ),
    prompt: Type.Optional(
      Type.String({ description: "Self-contained task prompt." }),
    ),
    agent: Type.Optional(
      Type.String({ description: "Named profile; omit for an inline task." }),
    ),
    cwd: Type.Optional(
      Type.String({ description: "Working directory for the task." }),
    ),
    systemPrompt: Type.Optional(
      Type.String({ description: "Base prompt for the subagent." }),
    ),
    context: Type.Optional(
      stringEnum(["fresh", "with-parent-transcript"], {
        description: "Conversation context supplied to the task.",
      }),
    ),
    model: Type.Optional(
      Type.String({ description: "Explicit model override." }),
    ),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description: "Exact capabilities; * and ro are groups.",
      }),
    ),
    thinking: Type.Optional(
      stringEnum(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        { description: "Thinking budget." },
      ),
    ),
    sessionId: Type.Optional(
      Type.String({ description: "Live reusable-session key." }),
    ),
    resumeFrom: Type.Optional(
      Type.String({ description: "Absolute session transcript path." }),
    ),
    deadlineMs: Type.Optional(
      Type.Number({ description: "Positive wall-clock task budget." }),
    ),
    workspace: Type.Optional(
      stringEnum(["shared", "scratch", "isolated"], {
        description: "Workspace behavior.",
      }),
    ),
  },
  { additionalProperties: false },
);

const argumentsSchema = Type.Object(
  {
    ticketAction: Type.Optional(
      stringEnum(["poll", "cancel", "wait", "pause", "resume"], {
        description: "Ticket operation.",
      }),
    ),
    sessionAction: Type.Optional(
      stringEnum(["close", "list"], { description: "Session operation." }),
    ),
    sessionId: Type.Optional(
      Type.String({ description: "Session to close or flat-task session key." }),
    ),
    async: Type.Optional(
      Type.Boolean({ description: "Run the entire batch in the background." }),
    ),
    ticket: Type.Optional(
      Type.String({ description: "Background ticket identifier." }),
    ),
    force: Type.Optional(
      Type.Boolean({ description: "Confirm cooperative cancellation." }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({ description: "Maximum ticket wait duration." }),
    ),
    tasks: Type.Optional(
      Type.Array(taskSchema, {
        minItems: 0,
        description: "Tasks to run; omit or pass [] for help.",
      }),
    ),
  },
  { additionalProperties: false },
);

type DelegateArguments = Static<typeof argumentsSchema>;
type DelegateDetails = {
  readonly mode: "help";
};

const taskFieldNames = [
  "id",
  "prompt",
  "agent",
  "cwd",
  "systemPrompt",
  "context",
  "model",
  "tools",
  "thinking",
  "sessionId",
  "resumeFrom",
  "deadlineMs",
  "workspace",
] as const;

function parseArray(value: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTools(value: string): unknown {
  const parsed = parseArray(value);
  if (parsed) return parsed;
  const token = value.trim();
  return token !== "" && !/[\s,]/.test(token) ? [token] : value;
}

function normalizeTask(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const task = { ...(value as Record<string, unknown>) };
  if (typeof task.tools === "string") task.tools = normalizeTools(task.tools);
  if (task.agent === "") delete task.agent;
  return task;
}

function prepareArguments(value: unknown): DelegateArguments {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value as DelegateArguments;
  }

  const args = { ...(value as Record<string, unknown>) };
  if (typeof args.tasks === "string") {
    const parsed = parseArray(args.tasks);
    if (parsed) args.tasks = parsed;
  }

  const hasTasks = Array.isArray(args.tasks) && args.tasks.length > 0;
  const ticketIntent =
    args.ticketAction !== undefined || args.ticket !== undefined;
  const sessionIntent =
    args.sessionAction === "close" || args.sessionAction === "list";

  if (!hasTasks && !ticketIntent && !sessionIntent) {
    const task: Record<string, unknown> = {};
    for (const field of taskFieldNames) {
      if (args[field] !== undefined) {
        task[field] = args[field];
        delete args[field];
      }
    }
    if (Object.keys(task).length > 0) args.tasks = [task];
  }

  if (Array.isArray(args.tasks)) {
    args.tasks = args.tasks.map(normalizeTask);
  }

  return args as DelegateArguments;
}

const help = `# Delegate Tool Manual

Delegate runs subagent tasks synchronously or as an asynchronous ticket.

- Pass a non-empty \`tasks\` array to dispatch work.
- Omit \`tasks\`, or pass \`tasks: []\`, to show this help.
- Use top-level \`ticketAction\` for ticket operations.
- Use top-level \`sessionAction\` for reusable-session operations.
`;

const delegateTool = defineTool<typeof argumentsSchema, DelegateDetails>({
  name: "delegate",
  label: "Delegate to Subagents",
  description:
    "Run subagent tasks. Sync returns results; async returns a ticket; tasks:[] shows help.",
  parameters: argumentsSchema,
  prepareArguments,

  async execute(_toolCallId, params) {
    if (params.ticketAction) {
      throw new Error("Delegate v2 ticket operations are not implemented yet.");
    }
    if (params.sessionAction) {
      throw new Error(
        "Delegate v2 session operations are not implemented yet.",
      );
    }
    if (params.ticket !== undefined) {
      throw new Error(
        "ticket requires ticketAction poll, cancel, wait, pause, or resume.",
      );
    }
    if (params.force === true) {
      throw new Error("force is valid only with ticketAction cancel.");
    }
    if (params.timeoutMs !== undefined) {
      throw new Error("timeoutMs is valid only with ticketAction wait.");
    }
    if (!params.tasks || params.tasks.length === 0) {
      if (params.async === true) {
        throw new Error("async dispatch requires at least one task.");
      }
      return {
        content: [{ type: "text" as const, text: help }],
        details: { mode: "help" as const },
      };
    }

    throw new Error("Delegate v2 dispatch is not implemented yet.");
  },
});

export default function delegateExtension(pi: ExtensionAPI): void {
  pi.registerTool(delegateTool);
}
