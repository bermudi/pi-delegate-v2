import {
  Type,
  type SchemaOptions,
  type Static,
  type TUnsafe,
} from "@sinclair/typebox";
import {
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { AdmissionController } from "./src/admission.ts";
import { loadDelegateConfig } from "./src/config.ts";
import { DispatchCoordinator } from "./src/coordinator.ts";
import { formatDispatchResult } from "./src/format.ts";
import { hostEnvironment, resolveTasks } from "./src/host.ts";
import { handleTicketRpc, TicketStore } from "./src/tickets.ts";
import { validateCall } from "./src/validation.ts";

function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options: SchemaOptions,
): TUnsafe<Values[number]> {
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
type DelegateDetails = Record<string, unknown>;

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

## Dispatch
- Pass a non-empty \`tasks\` array to dispatch work. Sync calls return every
  task's result in input order; \`async: true\` returns a ticket immediately
  and runs the batch in the background.
- Task fields: \`prompt\` (required unless \`resumeFrom\`), \`id\` (correlation
  key), \`agent\` (named profile), \`cwd\`, \`systemPrompt\`, \`context\`,
  \`model\`, \`tools\` (\`*\`/\`ro\` groups or names), \`thinking\`,
  \`deadlineMs\`, \`sessionId\`, \`resumeFrom\`, \`workspace\`
  (shared/scratch/isolated).

## Tickets
- \`ticketAction: "poll"\` — status of one \`ticket\`, or all tickets when the
  field is omitted. Never blocks.
- \`ticketAction: "wait"\` — block until the ticket settles; \`timeoutMs\`
  detaches only the waiter, the work continues.
- \`ticketAction: "cancel"\` — previews without \`force\`; with \`force: true\`
  the ticket is cancelled now and in-flight tasks are asked to stop
  (cooperative; no rollback).
- \`ticketAction: "pause"\` / \`"resume"\` — hold and release queued work; a
  paused ticket stays live and keeps its reservations.

## Sessions
- \`sessionAction: "list"\` lists named sessions; \`sessionAction: "close"\`
  with \`sessionId\` closes one.
`;

export default function delegateExtension(api: ExtensionAPI): void {
  const tickets = new TicketStore();
  const admission = new AdmissionController();
  const coordinator = new DispatchCoordinator(tickets);
  let callSeq = 0;

  api.registerTool(
    defineTool<typeof argumentsSchema, DelegateDetails>({
      name: "delegate",
      label: "Delegate to Subagents",
      description:
        "Run subagent tasks. Sync returns results; async returns a ticket; tasks:[] shows help.",
      parameters: argumentsSchema,
      prepareArguments,

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        // pi's ToolDefinition types params via the `typebox` v1 package while
        // this schema is built with @sinclair/typebox 0.34; the v1 Static
        // resolves Unsafe enum fields to unknown, so re-assert our own Static.
        const call = validateCall(params as DelegateArguments);
        if (call.mode === "help") {
          return {
            content: [{ type: "text" as const, text: help }],
            details: { mode: "help" as const },
          };
        }
        if (call.mode === "ticket") {
          const result = await handleTicketRpc(call, tickets, signal);
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: { mode: "ticket" as const, action: call.action },
            isError: result.isError,
          };
        }
        if (call.mode === "session") {
          throw new Error(
            `Delegate v2 session operations are not implemented yet (sessionAction "${call.action}").`,
          );
        }

        const env = hostEnvironment(ctx, () => api.getActiveTools());
        const config = loadDelegateConfig(ctx);
        const tasks = resolveTasks(call.tasks, env);

        if (call.async) {
          const ticket = tickets.create(tasks);
          try {
            const grant = admission.admit(tasks, ticket.id);
            void coordinator
              .run(tasks, { env, config, grant, ticket })
              .then(() => undefined)
              .catch((error: unknown) => {
                tickets.settle(ticket, "failed");
                console.error(
                  `[delegate] background ticket ${ticket.id} crashed: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          } catch (error) {
            tickets.remove(ticket.id);
            throw error;
          }
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Ticket "${ticket.id}" created: ${tasks.length} task(s) running in the background.\n` +
                  `Check progress with delegate({ ticketAction: "poll", ticket: "${ticket.id}" }).`,
              },
            ],
            details: {
              mode: "dispatch" as const,
              async: true,
              ticket: ticket.id,
              tasks: tasks.map((task) => task.id),
            },
          };
        }

        callSeq += 1;
        const grant = admission.admit(tasks, `call-${callSeq}`);
        const result = await coordinator.run(tasks, {
          env,
          config,
          grant,
          signal,
        });
        const allFailed = result.outcomes.every(
          (outcome) => outcome.status !== "ok",
        );
        return {
          content: [
            { type: "text" as const, text: formatDispatchResult(result.outcomes) },
          ],
          details: {
            mode: "dispatch" as const,
            async: false,
            tasks: result.outcomes.map((outcome) => ({
              id: outcome.id,
              status: outcome.status,
            })),
          },
          usage: result.usage,
          isError: allFailed,
        };
      },
    }),
  );
}
