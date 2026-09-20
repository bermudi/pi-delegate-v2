import { join } from "node:path";
import {
  Type,
  type Static,
  type TSchemaOptions,
  type TUnsafe,
} from "typebox";
import {
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { AdmissionController, type AdmissionGrant } from "./src/admission.ts";
import { loadDelegateConfig, resolveAgentDir } from "./src/config.ts";
import { DispatchCoordinator } from "./src/coordinator.ts";
import {
  formatDispatchResult,
  serializedNotices,
} from "./src/format.ts";
import { hostEnvironment, resolveTasks } from "./src/host.ts";
import { prepareIsolated, type IsolatedPlan } from "./src/isolated.ts";
import { prepareScratch, type ScratchPlan } from "./src/scratch.ts";
import { handleSessionRpc, SessionPool } from "./src/sessions.ts";
import { handleTicketRpc, TicketStore, ticketView } from "./src/tickets.ts";
import { Deferred } from "./src/types.ts";
import { validateCall } from "./src/validation.ts";

function stringEnum<const Values extends readonly string[]>(
  values: Values,
  options: TSchemaOptions,
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
    model: Type.Optional(
      Type.String({
        description:
          "Rejected: callers do not select subagent models. Omit entirely — tasks run on the parent's model, or the model the user configured for the agent in delegate.json.",
      }),
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

/** Run before host schema coercion so obsolete fields receive migration guidance. */
function rejectObsoleteContext(record: Record<string, unknown>): void {
  if (Object.hasOwn(record, "context")) {
    throw new Error(
      'The context field has been removed (including "fresh" and "with-parent-transcript"). ' +
        'Omit context and provide a self-contained task brief; parent conversation history is never shared. ' +
        'Child-owned sessionId and resumeFrom history remain supported.',
    );
  }
}

function normalizeTask(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const task = { ...(value as Record<string, unknown>) };
  rejectObsoleteContext(task);
  if (typeof task.tools === "string") task.tools = normalizeTools(task.tools);
  if (task.agent === "") delete task.agent;
  return task;
}

/**
 * Reject ambiguous shapes the host would silently coerce.
 *
 * pi-ai validates tool arguments with typebox 1.x `Value.Convert`, which
 * unconditionally coerces strings on schemas it recognizes — "true"→true,
 * "123"→123, "read, write"→["read, write"]. This schema is built with the
 * same `typebox` package, so it is always recognized: without this pass the
 * host would silently repair shapes SPEC.md does not authorize (its repair
 * list is exactly: stringified task arrays, flat task fields, JSON-array or
 * bare-token `tools` strings, and empty agent names). `prepareArguments` is
 * the only hook that runs before that coercion, so the boundary lives here;
 * a throw surfaces to the caller as a normal whole-call tool error.
 */
function rejectAmbiguousShapes(args: Record<string, unknown>): void {
  for (const field of ["async", "force", "timeoutMs"] as const) {
    const value = args[field];
    if (typeof value === "string") {
      throw new Error(
        `'${field}' must be a ${field === "timeoutMs" ? "number" : "boolean"}, not the string ${JSON.stringify(value)}.`,
      );
    }
  }
  if (!Array.isArray(args.tasks)) return;
  args.tasks.forEach((task, index) => {
    if (task === null || typeof task !== "object") return;
    const record = task as Record<string, unknown>;
    const where = `tasks[${index}]`;
    // normalizeTask has already repaired JSON-array strings and bare tokens;
    // a surviving string is ambiguous by construction.
    if (typeof record.tools === "string") {
      throw new Error(
        `${where}: 'tools' must be an array of tool names — a JSON array string or one bare name also works — not the ambiguous string ${JSON.stringify(record.tools)}.`,
      );
    }
    if (typeof record.deadlineMs === "string") {
      throw new Error(
        `${where}: 'deadlineMs' must be a positive number, not the string ${JSON.stringify(record.deadlineMs)}.`,
      );
    }
  });
}

function prepareArguments(value: unknown): DelegateArguments {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value as DelegateArguments;
  }

  const args = { ...(value as Record<string, unknown>) };
  rejectObsoleteContext(args);
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

  rejectAmbiguousShapes(args);

  return args as DelegateArguments;
}

const help = `# Delegate Tool Manual

Delegate runs subagent tasks synchronously or as an asynchronous ticket.

## Dispatch
- Pass a non-empty \`tasks\` array to dispatch work. Sync calls return every
  task's result in input order; \`async: true\` returns a ticket immediately
  and runs the batch in the background.
- Task fields: \`prompt\` (required unless \`resumeFrom\`), \`id\` (correlation
  key), \`agent\` (named profile), \`cwd\`, \`systemPrompt\`,
  \`tools\` (\`*\`/\`ro\` groups or names), \`thinking\`, \`deadlineMs\`,
  \`sessionId\`, \`resumeFrom\`, \`workspace\` (shared/scratch/isolated).
  A top-level \`workspace\` is the batch default.
- Models: you never pick models. Tasks run on the parent's model; a named
  agent may instead run on the model the user configured for it under
  "models" in the user-global delegate.json. A task \`model\` field is
  rejected.
- Children never inherit parent conversation history. Supply a self-contained
  brief; project instructions and child-owned pooled/resumed history still apply.

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
  // Owned by this closure: one fallback warning per extension instance, not
  // per call (see resolveAgentDir for why the fallback exists at all).
  let warnedAgentDirFallback = false;
  // Shutdown latch: once the host begins teardown, new dispatches reject and
  // pending results are never delivered.
  let shuttingDown = false;
  // Bumped on every observed tree transition — including a vetoed or
  // cancelled navigation attempt, which conservatively downgrades delivery.
  let navigationEpoch = 0;
  // One "fully quiesced" barrier per live dispatch; shutdown holds until
  // every one resolves (INVARIANTS "Ticket state"). The value is the
  // human-facing name for the shutdown waiting status (COMPATIBILITY
  // "Blocking shutdown" names the tickets): the ticket id for a background
  // batch, the call number for a synchronous dispatch, and a "(preparing)"
  // label in the window before either exists.
  const liveQuiescence = new Map<Promise<void>, string>();

  const trackQuiescence = (
    label: string,
  ): { barrier: Deferred; relabel: (label: string) => void } => {
    const barrier = new Deferred();
    liveQuiescence.set(barrier.promise, label);
    void barrier.promise.then(() => {
      liveQuiescence.delete(barrier.promise);
    });
    return {
      barrier,
      relabel: (next: string) => {
        // A resolved barrier is already untracked; relabeling must not
        // resurrect its entry.
        if (liveQuiescence.has(barrier.promise)) {
          liveQuiescence.set(barrier.promise, next);
        }
      },
    };
  };

  api.on("session_before_tree", () => {
    navigationEpoch += 1;
  });
  api.on("session_tree", () => {
    navigationEpoch += 1;
  });

  api.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    // Forced cancellation settles every ticket immediately and resolves its
    // waiters; delivery is suppressed by the latch above. Checked-out pooled
    // sessions must get their abort requests before the quiescence wait —
    // their runs own disposal through settle, and the barrier below is what
    // confirms they actually stopped (a worker that ignores the abort holds
    // shutdown for as long as it runs, per COMPATIBILITY.md).
    for (const ticket of tickets.list()) tickets.cancel(ticket, true);
    sessions.shutdown();
    const pending = [...liveQuiescence];
    if (pending.length > 0) {
      // The visible status names what is being waited on, so a worker that
      // ignores its abort is identifiable (its ticket id, or the sync call
      // label) without guessing from a bare count.
      const names = pending.map(([, label]) => label).join(", ");
      try {
        ctx.ui.notify(
          `Delegate: waiting for ${pending.length} dispatch(es) to stop before shutdown (${names})…`,
          "info",
        );
      } catch {
        // The UI may already be gone; the log line below still reports it.
      }
      console.error(
        `[delegate] shutdown waiting for ${pending.length} dispatch(es) to reach quiescence (${names})`,
      );
      await Promise.all(pending.map(([promise]) => promise));
    }
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
        const call = validateCall(params);
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

        if (shuttingDown) {
          throw new Error(
            "Delegate is shutting down with this session; new dispatches are not accepted. " +
              "Existing tickets remain pollable for the rest of the session's lifetime.",
          );
        }

        // The dispatch barrier is tracked before anything between the
        // latch check and the coordinator handoff can throw or yield:
        // task resolution probes Git for each writer/isolated task's
        // write scope, admission grants reservations, and workspace
        // preparation awaits subprocesses. A shutdown that starts while
        // this dispatch sits anywhere in that range must already count it
        // in the liveQuiescence snapshot, or the session boundary could
        // complete before the dispatch starts workers or releases its
        // reservations. The same barrier is handed to the coordinator;
        // every path below that ends without that handoff resolves it in
        // the catch.
        const { barrier: quiescence, relabel } = trackQuiescence(
          call.async ? "async dispatch (preparing)" : "dispatch (preparing)",
        );
        try {
          const agentDirResolution = resolveAgentDir(ctx);
          if (agentDirResolution.source === "cwd" && !warnedAgentDirFallback) {
            warnedAgentDirFallback = true;
            console.warn(
              `[delegate] Falling back to '${agentDirResolution.dir}' as the agent directory: delegate.json will be read from there, and delegate-sessions/, delegate-scratch/, delegate-isolated/ may be created under it. Set DELEGATE_AGENT_DIR to choose an agent directory explicitly. This warning appears once.`,
            );
          }
          const env = hostEnvironment(ctx, () => api.getActiveTools());
          const config = loadDelegateConfig(ctx);
          const tasks = resolveTasks(call.tasks, env, config);
          sessions.validateReuse(tasks);

          if (call.async) {
            const ticket = tickets.create(tasks);
            // The barrier now has its durable name for the shutdown status.
            relabel(`ticket "${ticket.id}"`);
            // The session-tree position at dispatch: delivery may wake the
            // parent only while it is still on this branch with no tree
            // transition or shutdown observed since.
            const origin = {
              leafId: ctx.sessionManager.getLeafId(),
              epoch: navigationEpoch,
            };
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
                  quiescence,
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
                  // The run promise rejected without (or after) handing the
                  // barrier to the task quiescence chain: resolve it so a
                  // later shutdown cannot wait forever on a dead dispatch.
                  quiescence.resolve();
                  tickets.settle(ticket, "failed");
                  console.error(
                    `[delegate] background ticket ${ticket.id} crashed: ${error instanceof Error ? error.message : String(error)}`,
                  );
                });
              // Auto-delivery, armed once the batch is running. It waits for
              // caller settlement AND the finished gate, so the delivered view
              // always carries the safe-to-expose outcome: finalized isolated
              // integrations, retained errors, and (on cancellation) partial
              // results rather than a bare status.
              const deliver = async (): Promise<void> => {
                if (shuttingDown) return;
                const cancelled = ticket.status === "cancelled";
                const message = {
                  customType: "delegate-result",
                  content:
                    ticketView(ticket) +
                    (cancelled
                      ? "\nCancellation is cooperative; worker cleanup may still be pending."
                      : ""),
                  display: true,
                  details: { ticket: ticket.id, originLeafId: origin.leafId },
                };
                // api.sendMessage is fire-and-forget on the stock
                // ExtensionAPI (returns void): async send rejections surface
                // through the host's extension-error channel, never here.
                // Only synchronous throws — e.g. a torn-down runtime failing
                // assertActive — reach the catch below. Either way,
                // settlement stands and the result stays pollable.
                try {
                  // "Same leaf" means same branch: the parent's own turn
                  // appends entries after dispatch, so the current leaf is a
                  // descendant of the origin leaf — the origin must still lie
                  // on the current branch (a null origin is the root, which
                  // every branch descends from). The epoch separately rules
                  // out any observed transition, cancelled or not.
                  const sameLeaf =
                    navigationEpoch === origin.epoch &&
                    (origin.leafId === null ||
                      ctx.sessionManager
                        .getBranch()
                        .some((entry) => entry.id === origin.leafId));
                  if (sameLeaf) {
                    // Same leaf, no transition observed: a follow-up wakes an
                    // idle parent and queues behind a busy one's tool calls.
                    api.sendMessage(message, {
                      deliverAs: "followUp",
                      triggerTurn: true,
                    });
                  } else {
                    // Leaf moved or a transition is in flight: append durably
                    // at the current leaf without triggering a turn — it
                    // enters model context on the next user turn.
                    api.sendMessage(message, { triggerTurn: false });
                    try {
                      ctx.ui.notify(
                        `Delegate ticket "${ticket.id}" settled on a different branch; its result was appended to the current branch for the next turn.`,
                        "info",
                      );
                    } catch {
                      // The UI may already be gone; the append itself landed.
                    }
                  }
                } catch (error) {
                  // Delivery failure never undoes settlement: the ticket stays
                  // terminal and pollable.
                  console.error(
                    `[delegate] delivering ticket ${ticket.id} failed (result remains pollable): ${error instanceof Error ? error.message : String(error)}`,
                  );
                  try {
                    ctx.ui.notify(
                      `Delegate ticket "${ticket.id}" settled but its result could not be delivered; poll it for the result.`,
                      "error",
                    );
                  } catch {
                    // A stale ctx cannot show the notice; the log line stands.
                  }
                }
              };
              void Promise.all([
                ticket.settledGate.promise,
                ticket.finishedGate.promise,
              ])
                .then(deliver)
                .catch((error: unknown) => {
                  console.error(
                    `[delegate] delivering ticket ${ticket.id} crashed (result remains pollable): ${error instanceof Error ? error.message : String(error)}`,
                  );
                });
            } catch (error) {
              // Preparation failed before coordinator.run took over the
              // barrier; the outer catch resolves it after this cleanup.
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
          relabel(`call-${callSeq}`);
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
              quiescence,
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
        } catch (error) {
          // coordinator.run wires the barrier to task quiescence the moment
          // it starts; if execution never got there (or the run promise
          // itself rejected pre-wiring), resolve it here — a leaked
          // barrier would hold every future shutdown forever.
          quiescence.resolve();
          throw error;
        }
      },
    }),
  );
}
