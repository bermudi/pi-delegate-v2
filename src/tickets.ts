import { integrationLines } from "./format.ts";
import { renderOutputForLLM, renderOutputForPoll } from "./spill.ts";
import type {
  ExecutionHandle,
  OutputBounds,
  TaskOutcome,
  Ticket,
  TicketStatus,
} from "./types.ts";
import { Deferred } from "./types.ts";
import type { ResolvedTask } from "./types.ts";

/** The store-private, writable form of the caller-visible record. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Live machinery for one ticket: cancellation, settlement gates, waiters,
 * and in-flight executions. Owned by the store and never exposed — callers
 * reach it only through the store's methods, so the caller-visible `Ticket`
 * stays free of it.
 */
interface TicketRuntime {
  /** Aborts in-flight executions when force-cancelled. */
  readonly cancellation: AbortController;
  /**
   * When true, recorded outcomes never settle the ticket — an explicit
   * `releaseSettlement` is required after post-run reconciliation lands, so
   * the terminal view includes integration results.
   */
  holdSettlement: boolean;
  pauseGate: Deferred | undefined;
  /** Resolves when the ticket reaches a terminal status. */
  readonly settledGate: Deferred;
  /**
   * Resolves when every task has a caller-visible outcome. Quarantined
   * workers may still be winding down — this is caller settlement, not
   * confirmed quiescence.
   */
  readonly finishedGate: Deferred;
  readonly waiters: Set<() => void>;
  /** Live executions by task index, for cooperative abort. */
  readonly executions: Map<number, ExecutionHandle>;
  /**
   * Memoized terminal view, populated by `view` once the ticket's record
   * can no longer change — every task has a caller-visible outcome and no
   * execution remains live. Settled rendering can write spill files; the
   * freeze keeps repeated polls pointing at one stable path instead of
   * writing a fresh file per render.
   */
  settledView: string | undefined;
}

interface TicketEntry {
  readonly record: Writable<Ticket>;
  readonly rt: TicketRuntime;
}

function isTerminal(status: TicketStatus): boolean {
  return status !== "running";
}

function statusWord(ticket: Ticket): string {
  return ticket.status === "running" && ticket.paused ? "paused" : ticket.status;
}

function completedCount(ticket: Ticket): number {
  return ticket.outcomes.filter((outcome) => outcome !== undefined).length;
}

function taskSection(ticket: Ticket, outcome: TaskOutcome): string {
  const head = `### Task ${outcome.id} — ${outcome.status === "ok" ? "completed" : outcome.status}`;
  const quarantined = outcome.quarantined
    ? "\n(worker termination unconfirmed — its write scope stays reserved)"
    : "";
  const integration = outcome.integration
    ? `\n${integrationLines(outcome.integration).join("\n")}`
    : "";
  // The ticket's lifecycle decides the renderer, not the outcome's: while
  // the ticket runs, even a finished task's output is bounded to a tail —
  // a poll never writes a spill file. On a terminal ticket every recorded
  // outcome renders through the spill boundary under the bounds snapshotted
  // at creation. `outcome.output` itself stays complete either way.
  const bounds = ticket.outputBounds;
  const label = ticket.tasks[outcome.index]?.agent ?? outcome.id;
  const render = isTerminal(ticket.status)
    ? (output: string) => renderOutputForLLM(output, label, bounds)
    : (output: string) => renderOutputForPoll(output, bounds);
  if (outcome.status === "ok") {
    return `${head}\n${render(outcome.output ?? "")}${quarantined}${integration}`;
  }
  const detail = outcome.error ?? "no output";
  const partial = outcome.output ? `\n${render(outcome.output)}` : "";
  return `${head}\n${detail}${partial}${quarantined}${integration}`;
}

/** Poll/wait view of one ticket. Poll is observational — never mutates. */
function ticketView(ticket: Ticket): string {
  const lines = [
    `Ticket "${ticket.id}": ${statusWord(ticket)} — ${completedCount(ticket)}/${ticket.totalTasks} tasks finished.`,
    ...ticket.notices,
  ];
  for (const outcome of ticket.outcomes) {
    if (outcome) lines.push("", taskSection(ticket, outcome));
  }
  return lines.join("\n");
}

function rosterView(tickets: readonly Ticket[]): string {
  if (tickets.length === 0) {
    return "No tickets. Dispatch tasks with async: true to create one.";
  }
  const lines = tickets.map(
    (ticket) =>
      `- "${ticket.id}" ${statusWord(ticket)} — ${completedCount(ticket)}/${ticket.totalTasks} tasks finished`,
  );
  return `Tickets:\n${lines.join("\n")}`;
}

/**
 * The ticket registry and lifecycle state machine, and the sole writer of
 * both ticket halves: the caller-visible record (returned as `Ticket`) and
 * the store-private runtime half reached through the methods below. Ticket
 * status moves running → terminal exactly once; pause is orthogonal. Worker
 * completion arriving after a terminal transition is recorded for visibility
 * but can never change the status.
 */
export class TicketStore {
  private readonly tickets = new Map<string, TicketEntry>();
  private seq = 0;

  /**
   * Optional lifecycle observer (extension-owned): fired after every
   * caller-visible mutation so visibility signals can resync. The store
   * never reads it beyond the call.
   */
  constructor(private readonly onChange?: () => void) {}

  private changed(): void {
    this.onChange?.();
  }

  private newTicketId(): string {
    this.seq += 1;
    return `t-${this.seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Live machinery for `ticket`; entries share the record's lifetime. */
  private entry(ticket: Ticket): TicketEntry {
    const entry = this.tickets.get(ticket.id);
    if (entry === undefined) {
      throw new Error(`internal: unknown ticket '${ticket.id}'`);
    }
    return entry;
  }

  create(
    tasks: readonly ResolvedTask[],
    options: {
      readonly holdSettlement: boolean;
      readonly outputBounds: OutputBounds;
    },
  ): Ticket {
    const record: Writable<Ticket> = {
      id: this.newTicketId(),
      status: "running",
      paused: false,
      totalTasks: tasks.length,
      outcomes: new Array<TaskOutcome | undefined>(tasks.length).fill(undefined),
      tasks,
      outputBounds: options.outputBounds,
      createdAt: Date.now(),
      notices: [],
    };
    // Isolated batches settle only after reconciliation has annotated the
    // outcomes — a terminal ticket must already show applied/conflict state.
    const rt: TicketRuntime = {
      cancellation: new AbortController(),
      holdSettlement: options.holdSettlement,
      pauseGate: undefined,
      settledGate: new Deferred(),
      finishedGate: new Deferred(),
      waiters: new Set(),
      executions: new Map(),
      settledView: undefined,
    };
    this.tickets.set(record.id, { record, rt });
    this.changed();
    return record;
  }

  get(id: string): Ticket | undefined {
    return this.tickets.get(id)?.record;
  }

  /**
   * The poll/wait/delivery view. Running tickets bound every recorded
   * outcome to a tail-only projection — a poll never writes a spill file;
   * terminal tickets render settled output through the spill boundary under
   * the bounds snapshotted at creation. A terminal view is memoized once it
   * can no longer change — the finished gate has resolved and no execution
   * remains live — so repeated polls of a settled ticket keep pointing at
   * the same spill file rather than writing a new one per render.
   */
  view(ticket: Ticket): string {
    const { record, rt } = this.entry(ticket);
    if (
      isTerminal(record.status) &&
      rt.finishedGate.resolved &&
      rt.executions.size === 0
    ) {
      rt.settledView ??= ticketView(record);
      return rt.settledView;
    }
    return ticketView(record);
  }

  /** Drop a ticket that never started (e.g. admission failed after create). */
  remove(id: string): void {
    this.tickets.delete(id);
    this.changed();
  }

  list(): Ticket[] {
    return [...this.tickets.values()].map((entry) => entry.record);
  }

  /** Record a task outcome. Never changes a terminal ticket's status. */
  recordOutcome(ticket: Ticket, outcome: TaskOutcome): void {
    // Sole-writer cast: the exposed type is readonly, but it is the same
    // mutable array instance callers see — the store owns the one legal
    // write path (no freeze, no copy-on-write).
    const outcomes = this.entry(ticket).record
      .outcomes as (TaskOutcome | undefined)[];
    outcomes[outcome.index] = outcome;
    this.changed();
    this.maybeSettle(ticket);
  }

  /**
   * Replace the dispatch notices (e.g. same-call shared writers
   * serializing). The sole write path for the ticket's notices.
   */
  setNotices(ticket: Ticket, notices: readonly string[]): void {
    this.entry(ticket).record.notices = [...notices];
  }

  /**
   * Record the session-tree origin at dispatch: the leaf id (null for the
   * root) and the navigation epoch, captured by the dispatcher right after
   * creation so delivery diagnostics can be reconstructed from the ticket
   * alone. The sole write path for the origin fields.
   */
  recordOrigin(
    ticket: Ticket,
    origin: { readonly leafId: string | null; readonly epoch: number },
  ): void {
    const record = this.entry(ticket).record;
    record.originLeafId = origin.leafId;
    record.originEpoch = origin.epoch;
  }

  private maybeSettle(ticket: Ticket): void {
    const { record, rt } = this.entry(ticket);
    if (record.status !== "running" || rt.holdSettlement) return;
    if (!record.outcomes.every((recorded) => recorded !== undefined)) return;
    this.settle(
      ticket,
      record.outcomes.every((o) => o!.status === "ok")
        ? "completed"
        : record.outcomes.every((o) => o!.status === "cancelled")
          ? "cancelled"
          : record.outcomes.some((o) => o!.status === "ok")
            ? "partial"
            : "failed",
    );
  }

  /**
   * Lift the settlement hold after post-run reconciliation: the ticket can
   * now reach its terminal status with the finalized outcomes on record.
   * A ticket already settled by cancellation is unaffected.
   */
  releaseSettlement(ticket: Ticket): void {
    this.entry(ticket).rt.holdSettlement = false;
    this.maybeSettle(ticket);
  }

  /** The single owner of the terminal transition; idempotent. */
  settle(ticket: Ticket, status: TicketStatus): boolean {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status) || status === "running") return false;
    record.status = status;
    record.paused = false;
    this.changed();
    rt.pauseGate?.resolve();
    rt.settledGate.resolve();
    for (const notify of [...rt.waiters]) notify();
    return true;
  }

  pause(ticket: Ticket): string {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status)) {
      throw new Error(
        `Ticket '${ticket.id}' is already ${record.status}; it cannot be paused.`,
      );
    }
    if (!record.paused) {
      record.paused = true;
      rt.pauseGate = new Deferred();
      this.changed();
    }
    return `Ticket "${ticket.id}" paused. Queued tasks and upcoming model turns are held; in-flight work continues.`;
  }

  resume(ticket: Ticket): string {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status)) {
      throw new Error(
        `Ticket '${ticket.id}' is already ${record.status}; it cannot be resumed.`,
      );
    }
    if (!record.paused) {
      return `Ticket "${ticket.id}" is already running.`;
    }
    record.paused = false;
    rt.pauseGate?.resolve();
    rt.pauseGate = undefined;
    this.changed();
    return `Ticket "${ticket.id}" resumed.`;
  }

  /**
   * `force: false` previews. Forced cancellation is terminal immediately —
   * the ticket is authoritative — while in-flight executions are aborted
   * cooperatively in the background. Their late outcomes stay visible.
   */
  cancel(ticket: Ticket, force: boolean): string {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status)) {
      return `Ticket "${ticket.id}" is already ${record.status}.`;
    }
    if (!force) {
      const inFlight = rt.executions.size;
      return (
        `Ticket "${ticket.id}" is ${statusWord(record)} with ${inFlight} task(s) in flight. ` +
        `Cancellation is cooperative: in-flight work is asked to stop and queued tasks are dropped; ` +
        `completed writes and commands are not rolled back. Re-run with force: true to cancel.`
      );
    }
    rt.cancellation.abort();
    this.settle(ticket, "cancelled");
    for (const handle of [...rt.executions.values()]) {
      void handle.abort("cancelled").catch((error) => {
        console.error(
          `[delegate] aborting task on ticket ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return (
      `Ticket "${ticket.id}" cancelled. In-flight tasks were asked to stop and queued tasks were dropped; ` +
      `work already completed is retained on the ticket.`
    );
  }

  /**
   * Wait for settlement. A timeout or caller abort detaches only this
   * waiter — the ticket and its work are untouched. Timeout and abort are
   * distinct: only a timeout is a timeout.
   */
  async wait(
    ticket: Ticket,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ timedOut: boolean; aborted: boolean }> {
    const { record, rt } = this.entry(ticket);
    if (isTerminal(record.status)) return { timedOut: false, aborted: false };
    if (signal?.aborted === true) return { timedOut: false, aborted: true };
    let notify!: () => void;
    const onSettled = new Promise<void>((resolve) => {
      notify = () => {
        rt.waiters.delete(notify);
        resolve();
      };
      rt.waiters.add(notify);
    });
    const races: Promise<unknown>[] = [onSettled];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      races.push(
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      );
    }
    let onAbort: (() => void) | undefined;
    if (signal !== undefined) {
      races.push(
        new Promise((resolve) => {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort);
        }),
      );
    }
    let outcome: unknown;
    try {
      outcome = await Promise.race(races);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) {
        signal?.removeEventListener("abort", onAbort);
      }
      rt.waiters.delete(notify);
    }
    if (isTerminal(record.status)) return { timedOut: false, aborted: false };
    if (outcome === "aborted" || signal?.aborted) {
      return { timedOut: false, aborted: true };
    }
    return { timedOut: true, aborted: false };
  }

  /**
   * The ticket's cancellation signal: aborts when the ticket is
   * force-cancelled (including shutdown). Long-lived — it outlives any one
   * task — so listeners attached to it must be removed by their owner once
   * the task is fully done.
   */
  cancellationSignal(ticket: Ticket): AbortSignal {
    return this.entry(ticket).rt.cancellation.signal;
  }

  /**
   * The active pause gate's promise while the ticket is paused, else
   * undefined. Schedulers park on it and race it against their own abort;
   * only the store resolves or replaces it (pause/resume/settle).
   */
  pauseGatePromise(ticket: Ticket): Promise<void> | undefined {
    return this.entry(ticket).rt.pauseGate?.promise;
  }

  /** Register a live execution for a task, for cooperative abort. */
  registerExecution(
    ticket: Ticket,
    taskIndex: number,
    handle: ExecutionHandle,
  ): void {
    this.entry(ticket).rt.executions.set(taskIndex, handle);
  }

  /**
   * Drop a task's live execution at its true settlement — but only if it is
   * still the registered handle: a replacement (retry attempt) registered in
   * the meantime stays live.
   */
  dropExecution(
    ticket: Ticket,
    taskIndex: number,
    handle: ExecutionHandle,
  ): void {
    const executions = this.entry(ticket).rt.executions;
    if (executions.get(taskIndex) === handle) {
      executions.delete(taskIndex);
    }
  }

  /**
   * Resolve the finished gate: every task has a caller-visible outcome.
   * Quarantined workers may still be winding down — this is caller
   * settlement, not confirmed quiescence. Idempotent.
   */
  finishBatch(ticket: Ticket): void {
    this.entry(ticket).rt.finishedGate.resolve();
  }

  /** Resolves when the ticket reaches a terminal status. */
  settledPromise(ticket: Ticket): Promise<void> {
    return this.entry(ticket).rt.settledGate.promise;
  }

  /** Resolves when every task has a caller-visible outcome. */
  finishedPromise(ticket: Ticket): Promise<void> {
    return this.entry(ticket).rt.finishedGate.promise;
  }
}

export interface TicketRpcResult {
  readonly text: string;
  readonly isError: boolean;
  /**
   * The resolved ticket when the call named a known one — lets the caller
   * attach its complete (unbounded) outcomes to result details.
   */
  readonly ticket?: Ticket;
}

/** ticketAction RPCs against the store. */
export async function handleTicketRpc(
  call: {
    action: "poll" | "wait" | "cancel" | "pause" | "resume";
    ticket: string | undefined;
    force: boolean;
    timeoutMs: number | undefined;
  },
  store: TicketStore,
  signal: AbortSignal | undefined,
): Promise<TicketRpcResult> {
  if (call.action === "poll" && call.ticket === undefined) {
    return { text: rosterView(store.list()), isError: false };
  }
  const ticket = call.ticket !== undefined ? store.get(call.ticket) : undefined;
  if (!ticket) {
    return {
      text: `Ticket '${call.ticket ?? ""}' not found.`,
      isError: true,
    };
  }
  switch (call.action) {
    case "poll":
      return { text: store.view(ticket), isError: false, ticket };
    case "wait": {
      const { timedOut, aborted } = await store.wait(
        ticket,
        call.timeoutMs,
        signal,
      );
      const view = store.view(ticket);
      const text = timedOut
        ? `${view}\n\nWait timed out; the ticket is still ${statusWord(ticket)}.`
        : aborted
          ? `${view}\n\nWait detached; the caller aborted the wait. The ticket is still ${statusWord(ticket)}.`
          : view;
      return { text, isError: false, ticket };
    }
    case "cancel":
      return { text: store.cancel(ticket, call.force), isError: false, ticket };
    case "pause":
      return { text: store.pause(ticket), isError: false, ticket };
    case "resume":
      return { text: store.resume(ticket), isError: false, ticket };
  }
}
