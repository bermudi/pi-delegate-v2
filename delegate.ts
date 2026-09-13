import { join } from "node:path";
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
import { AdmissionController, type AdmissionGrant } from "./src/admission.ts";
import { loadDelegateConfig } from "./src/config.ts";
import { DispatchCoordinator } from "./src/coordinator.ts";
import {
  formatDispatchResult,
  serializedNotices,
} from "./src/format.ts";
import { hostEnvironment, resolveTasks } from "./src/host.ts";
import { prepareIsolated, type IsolatedPlan } from "./src/isolated.ts";
import { prepareScratch, type ScratchPlan } from "./src/scratch.ts";
import { handleSessionRpc, SessionPool } from "./src/sessions.ts";
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
      Type.String({
        description:
          "Key for a live reusable session; later calls with the same id continue it. Its configuration is frozen at first use.",
      }),
    ),
    resumeFrom: Type.Optional(
      Type.String({ description: "Absolute session transcript path." }),
    ),
    deadlineMs: Type.Optional(
      Type.Number({ description: "Positive wall-clock task budget." }),
    ),
    workspace: Type.Optional(
      stringEnum(["shared", "scratch", "isolated"], {
        description:
          "shared/scratch/isolated. 'shared' edits the tree; writers in one repo run one at a time in task order. 'isolated' runs each task in a private Git worktree — same-repo edits run in parallel and merge in order. 'scratch' runs once in a disposable copy and discards every change — for write-capable tasks whose value is the answer, not the edits; read-only tasks cannot use it.",
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
    workspace: Type.Optional(
      stringEnum(["shared", "scratch", "isolated"], {
        description:
          "Default workspace for every task lacking its own. 'isolated' = parallel same-repo edits. 'scratch' = disposable copy, changes discarded.",
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
  (shared/scratch/isolated). A top-level \`workspace\` is the batch default.

## Workspaces
- \`shared\` (default): the task edits the caller's tree directly. Writers
  whose scope overlaps in one call run one at a time, in task order — each
  sees its predecessor's changes. Use it for dependent edits.
- \`isolated\`: each task works in a detached Git worktree; successful
  changes merge into the source in task order. Independent edits to the
  same repository run in parallel — much faster than shared for
  independent work. Cannot use \`sessionId\` or \`resumeFrom\`.
- \`scratch\`: one task, one disposable copy of the tree (reflinked when
  the filesystem supports it); every change is discarded. Use it for
  tasks that may write or run commands but whose output is the answer,
  not the edits. A read-only task cannot use it — it needs no copy.
  Cannot use \`sessionId\` or \`resumeFrom\`.

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
- A task with \`sessionId\` keeps its session live after it finishes; a later
  call with the same id continues that conversation. The session's cwd,
  tools, thinking, model, and base prompt are frozen at first use —
  incompatible reuse is rejected.
- \`sessionAction: "list"\` lists live sessions; \`sessionAction: "close"\`
  with \`sessionId\` closes one.
`;

export default function delegateExtension(api: ExtensionAPI): void {
  const tickets = new TicketStore();
  const admission = new AdmissionController();
  const sessions = new SessionPool();
  const coordinator = new DispatchCoordinator(tickets);
  let callSeq = 0;

  api.on("session_shutdown", () => {
    sessions.shutdown();
  });

  api.registerTool(
    defineTool<typeof argumentsSchema, DelegateDetails>({
      name: "delegate",
      label: "Delegate to Subagents",
      description:
        "Run subagent tasks. Sync returns results; async returns a ticket; tasks:[] shows help. Same-repo writers serialize under 'shared'; 'isolated' runs independent edits in parallel; 'scratch' discards a disposable copy's changes.",
      parameters: argumentsSchema,
      prepareArguments,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
          const result = handleSessionRpc(call, sessions, admission);
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: {
              mode: "session" as const,
              action: call.action,
              sessionId: call.sessionId,
            },
            isError: result.isError,
          };
        }

        const env = hostEnvironment(ctx, () => api.getActiveTools());
        const config = loadDelegateConfig(ctx);
        const tasks = resolveTasks(call.tasks, env);
        sessions.validateReuse(tasks);

        if (call.async) {
          const ticket = tickets.create(tasks);
          let grant: AdmissionGrant | undefined;
          let scratchPlan: ScratchPlan | undefined;
          try {
            grant = admission.admit(tasks, ticket.id);
            ticket.notices = serializedNotices(tasks, grant.serialized);
            // Scratch before isolated: file copies are cheaper than Git
            // setup, and a later preparation failure can dispose() them.
            scratchPlan = await prepareScratch(
              tasks,
              join(env.agentDir, "delegate-scratch"),
            );
            const plan = await prepareIsolated(
              scratchPlan?.tasks ?? tasks,
              join(env.agentDir, "delegate-isolated"),
            );
            void coordinator
              .run(plan?.tasks ?? scratchPlan?.tasks ?? tasks, {
                env,
                config,
                grant,
                sessions,
                ticket,
                finalize:
                  plan || scratchPlan
                    ? async (outcomes) => {
                        if (plan) {
                          await plan.reconcile(outcomes, {
                            shouldApplySource: () =>
                              !ticket.cancellation.signal.aborted,
                            retainedReason:
                              "The ticket was cancelled before source application.",
                            signal: ticket.cancellation.signal,
                          });
                        }
                        if (scratchPlan) await scratchPlan.finalize(outcomes);
                        return outcomes;
                      }
                    : undefined,
                onWorkerQuiesced:
                  plan || scratchPlan
                    ? async (taskIndex) => {
                        await Promise.all([
                          plan?.cleanupWorker(taskIndex),
                          scratchPlan?.cleanupWorker(taskIndex),
                        ]);
                      }
                    : undefined,
              })
              .then(() => undefined)
              .catch((error: unknown) => {
                tickets.settle(ticket, "failed");
                console.error(
                  `[delegate] background ticket ${ticket.id} crashed: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
          } catch (error) {
            await scratchPlan?.dispose();
            grant?.release();
            tickets.remove(ticket.id);
            throw error;
          }
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Ticket "${ticket.id}" created: ${tasks.length} task(s) running in the background.\n` +
                  `Check progress with delegate({ ticketAction: "poll", ticket: "${ticket.id}" }).` +
                  (ticket.notices.length > 0
                    ? `\n${ticket.notices.join("\n")}`
                    : ""),
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
        // Surface same-call serialization immediately — a serialized batch of
        // independent writers is the expensive way to learn about "isolated".
        const notices = serializedNotices(tasks, grant.serialized);
        if (notices.length > 0) {
          onUpdate?.({
            content: [{ type: "text" as const, text: notices.join("\n") }],
            details: {},
          });
        }
        let plan: IsolatedPlan | undefined;
        let scratchPlan: ScratchPlan | undefined;
        try {
          scratchPlan = await prepareScratch(
            tasks,
            join(env.agentDir, "delegate-scratch"),
            signal,
          );
          plan = await prepareIsolated(
            scratchPlan?.tasks ?? tasks,
            join(env.agentDir, "delegate-isolated"),
            signal,
          );
        } catch (error) {
          await scratchPlan?.dispose();
          grant.release();
          throw error;
        }
        const result = await coordinator.run(
          plan?.tasks ?? scratchPlan?.tasks ?? tasks,
          {
            env,
            config,
            grant,
            sessions,
            signal,
            finalize:
              plan || scratchPlan
                ? async (outcomes) => {
                    if (plan) {
                      await plan.reconcile(outcomes, {
                        shouldApplySource: () => !signal?.aborted,
                        retainedReason:
                          "The call was aborted before source application.",
                        signal,
                      });
                    }
                    if (scratchPlan) await scratchPlan.finalize(outcomes);
                    return outcomes;
                  }
                : undefined,
            onWorkerQuiesced:
              plan || scratchPlan
                ? async (taskIndex) => {
                    await Promise.all([
                      plan?.cleanupWorker(taskIndex),
                      scratchPlan?.cleanupWorker(taskIndex),
                    ]);
                  }
                : undefined,
          },
        );
        const allFailed = result.outcomes.every(
          (outcome) => outcome.status !== "ok",
        );
        return {
          content: [
            {
              type: "text" as const,
              text:
                (notices.length > 0 ? `${notices.join("\n")}\n\n` : "") +
                formatDispatchResult(result.outcomes),
            },
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
