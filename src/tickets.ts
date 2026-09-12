import type { TaskOutcome, Ticket, TicketStatus } from "./types.ts";
import { Deferred } from "./types.ts";
import type { ResolvedTask } from "./types.ts";

function isTerminal(status: TicketStatus): boolean {
  return status !== "running";
}

function statusWord(ticket: Ticket): string {
  return ticket.status === "running" && ticket.paused ? "paused" : ticket.status;
}

function completedCount(ticket: Ticket): number {
  return ticket.outcomes.filter((outcome) => outcome !== undefined).length;
}

function taskSection(outcome: TaskOutcome): string {
  const head = `### Task ${outcome.id} — ${outcome.status === "ok" ? "completed" : outcome.status}`;
  const quarantined = outcome.quarantined
    ? "\n(worker termination unconfirmed — its write scope stays reserved)"
    : "";
  if (outcome.status === "ok") {
    return `${head}\n${outcome.output ?? ""}${quarantined}`;
  }
  const detail = outcome.error ?? "no output";
  const partial = outcome.output ? `\n${outcome.output}` : "";
  return `${head}\n${detail}${partial}${quarantined}`;
}

/** Poll/wait view of one ticket. Poll is observational — never mutates. */
export function ticketView(ticket: Ticket): string {
  const lines = [
    `Ticket "${ticket.id}": ${statusWord(ticket)} — ${completedCount(ticket)}/${ticket.totalTasks} tasks completed.`,
  ];
  for (const outcome of ticket.outcomes) {
    if (outcome) lines.push("", taskSection(outcome));
  }
  return lines.join("\n");
}

function rosterView(tickets: readonly Ticket[]): string {
  if (tickets.length === 0) {
    return "No tickets. Dispatch tasks with async: true to create one.";
  }
  const lines = tickets.map(
    (ticket) =>
      `- "${ticket.id}" ${statusWord(ticket)} — ${completedCount(ticket)}/${ticket.totalTasks} tasks completed`,
  );
  return `Tickets:\n${lines.join("\n")}`;
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/**
 * The ticket registry and lifecycle state machine. Ticket status moves
 * running → terminal exactly once; pause is orthogonal. Worker completion
 * arriving after a terminal transition is recorded for visibility but can
 * never change the status.
 */
export class TicketStore {
  private readonly tickets = new Map<string, Ticket>();
  private seq = 0;

  private newTicketId(): string {
    this.seq += 1;
    return `t-${this.seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  create(tasks: readonly ResolvedTask[]): Ticket {
    const ticket: Ticket = {
      id: this.newTicketId(),
      status: "running",
      paused: false,
      pauseGate: undefined,
      totalTasks: tasks.length,
      outcomes: new Array<TaskOutcome | undefined>(tasks.length).fill(undefined),
      tasks,
      createdAt: Date.now(),
      cancellation: new AbortController(),
      settledGate: new Deferred(),
      finishedGate: new Deferred(),
      waiters: new Set(),
      executions: new Map(),
    };
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  get(id: string): Ticket | undefined {
    return this.tickets.get(id);
  }

  /** Drop a ticket that never started (e.g. admission failed after create). */
  remove(id: string): void {
    this.tickets.delete(id);
  }

  list(): Ticket[] {
    return [...this.tickets.values()];
  }

  /** Record a task outcome. Never changes a terminal ticket's status. */
  recordOutcome(ticket: Ticket, outcome: TaskOutcome): void {
    ticket.outcomes[outcome.index] = outcome;
    if (ticket.status !== "running") return;
    if (ticket.outcomes.every((recorded) => recorded !== undefined)) {
      this.settle(
        ticket,
        ticket.outcomes.every((o) => o!.status === "ok")
          ? "completed"
          : ticket.outcomes.every((o) => o!.status === "cancelled")
            ? "cancelled"
            : ticket.outcomes.some((o) => o!.status === "ok")
              ? "completed"
              : "failed",
      );
    }
  }

  /** The single owner of the terminal transition; idempotent. */
  settle(ticket: Ticket, status: TicketStatus): boolean {
    if (isTerminal(ticket.status) || status === "running") return false;
    ticket.status = status;
    ticket.paused = false;
    ticket.pauseGate?.resolve();
    ticket.settledGate.resolve();
    for (const notify of [...ticket.waiters]) notify();
    return true;
  }

  pause(ticket: Ticket): string {
    if (isTerminal(ticket.status)) {
      throw new Error(
        `Ticket '${ticket.id}' is already ${ticket.status}; it cannot be paused.`,
      );
    }
    if (!ticket.paused) {
      ticket.paused = true;
      ticket.pauseGate = new Deferred();
    }
    return `Ticket "${ticket.id}" paused. Queued tasks and upcoming model turns are held; in-flight work continues.`;
  }

  resume(ticket: Ticket): string {
    if (isTerminal(ticket.status)) {
      throw new Error(
        `Ticket '${ticket.id}' is already ${ticket.status}; it cannot be resumed.`,
      );
    }
    if (!ticket.paused) {
      return `Ticket "${ticket.id}" is already running.`;
    }
    ticket.paused = false;
    ticket.pauseGate?.resolve();
    ticket.pauseGate = undefined;
    return `Ticket "${ticket.id}" resumed.`;
  }

  /**
   * `force: false` previews. Forced cancellation is terminal immediately —
   * the ticket is authoritative — while in-flight executions are aborted
   * cooperatively in the background. Their late outcomes stay visible.
   */
  cancel(ticket: Ticket, force: boolean): string {
    if (isTerminal(ticket.status)) {
      return `Ticket "${ticket.id}" is already ${ticket.status}.`;
    }
    if (!force) {
      const inFlight = ticket.executions.size;
      return (
        `Ticket "${ticket.id}" is ${statusWord(ticket)} with ${inFlight} task(s) in flight. ` +
        `Cancellation is cooperative: in-flight work is asked to stop and queued tasks are dropped; ` +
        `completed writes and commands are not rolled back. Re-run with force: true to cancel.`
      );
    }
    ticket.cancellation.abort();
    this.settle(ticket, "cancelled");
    for (const handle of [...ticket.executions.values()]) {
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
   * waiter — the ticket and its work are untouched.
   */
  async wait(
    ticket: Ticket,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ timedOut: boolean }> {
    if (isTerminal(ticket.status)) return { timedOut: false };
    let notify!: () => void;
    const onSettled = new Promise<void>((resolve) => {
      notify = () => {
        ticket.waiters.delete(notify);
        resolve();
      };
      ticket.waiters.add(notify);
    });
    const races: Promise<unknown>[] = [onSettled];
    if (timeoutMs !== undefined) {
      races.push(
        new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
      );
    }
    if (signal) races.push(aborted(signal));
    try {
      await Promise.race(races);
    } finally {
      ticket.waiters.delete(notify);
    }
    return { timedOut: !isTerminal(ticket.status) };
  }
}

export interface TicketRpcResult {
  readonly text: string;
  readonly isError: boolean;
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
      isError: false,
    };
  }
  switch (call.action) {
    case "poll":
      return { text: ticketView(ticket), isError: false };
    case "wait": {
      const { timedOut } = await store.wait(ticket, call.timeoutMs, signal);
      const text = timedOut
        ? `${ticketView(ticket)}\n\nWait timed out; the ticket is still ${statusWord(ticket)}.`
        : ticketView(ticket);
      return { text, isError: false };
    }
    case "cancel":
      return { text: store.cancel(ticket, call.force), isError: false };
    case "pause":
      return { text: store.pause(ticket), isError: false };
    case "resume":
      return { text: store.resume(ticket), isError: false };
  }
}
