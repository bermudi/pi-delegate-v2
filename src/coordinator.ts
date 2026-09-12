import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { AdmissionGrant } from "./admission.ts";
import type { DelegateConfig } from "./config.ts";
import { runTask, type RunControls } from "./execution.ts";
import type { HostEnvironment } from "./host.ts";
import { Semaphore } from "./types.ts";
import type { TicketStore } from "./tickets.ts";
import type {
  ResolvedTask,
  TaskOutcome,
  Ticket,
} from "./types.ts";

function onAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export interface DispatchOutcome {
  readonly outcomes: readonly TaskOutcome[];
  readonly usage: Usage | undefined;
}

/**
 * Schedules tasks for one call or ticket: pause gates, same-call writer
 * serialization, the global concurrency semaphore, then execution. Task
 * outcomes land index-aligned; lifecycle state lives in the ticket, not here.
 */
export class DispatchCoordinator {
  private readonly semaphore = new Semaphore(3);

  constructor(private readonly tickets: TicketStore) {}

  /**
   * Run a batch to completion. Resolves with index-aligned outcomes; a task
   * failure never rejects the batch and never destroys sibling results.
   */
  async run(
    tasks: readonly ResolvedTask[],
    options: {
      env: HostEnvironment;
      config: DelegateConfig;
      grant: AdmissionGrant;
      signal?: AbortSignal;
      ticket?: Ticket;
    },
  ): Promise<DispatchOutcome> {
    this.semaphore.setLimit(options.config.maxConcurrent);
    const grant = options.grant;
    const loaders = new Map<string, Promise<DefaultResourceLoader>>();
    const outcomes: (TaskOutcome | undefined)[] = new Array(tasks.length);
    const completion = new Map<number, Promise<void>>();

    try {
      await Promise.all(
        tasks.map((task) => {
          const done = this.runOne(task, options, grant, loaders, outcomes, completion);
          completion.set(task.index, done);
          return done;
        }),
      );
    } finally {
      grant.release();
      options.ticket?.finishedGate.resolve();
    }

    return {
      outcomes: outcomes as TaskOutcome[],
      usage: outcomes.reduce<Usage | undefined>(
        (total, outcome) => addUsage(total, outcome?.usage),
        undefined,
      ),
    };
  }

  private async runOne(
    task: ResolvedTask,
    options: {
      env: HostEnvironment;
      signal?: AbortSignal;
      ticket?: Ticket;
    },
    grant: AdmissionGrant,
    loaders: Map<string, Promise<DefaultResourceLoader>>,
    outcomes: (TaskOutcome | undefined)[],
    completion: Map<number, Promise<void>>,
  ): Promise<void> {
    const ticket = options.ticket;
    const signal = combineSignals(
      options.signal,
      ticket?.cancellation.signal,
    );
    const record = (outcome: TaskOutcome) => {
      outcomes[task.index] = outcome;
      ticket?.executions.delete(task.index);
      if (ticket) {
        // The store owns lifecycle; recording can settle the ticket but
        // never un-settles it.
        this.tickets.recordOutcome(ticket, outcome);
      }
    };

    // Queued tasks hold no execution resources: pause first, then wait for a
    // serialized writer predecessor, then acquire a concurrency slot.
    while (true) {
      if (ticket) await this.waitWhilePaused(ticket, signal);
      if (signal.aborted) {
        record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
        return;
      }
      const predecessor = grant.predecessors.get(task.index);
      if (predecessor !== undefined) {
        await Promise.race([completion.get(predecessor), onAbort(signal)]);
      }
      if (signal.aborted) {
        record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
        return;
      }
      // Abort wakes a queued task without waiting for a slot; a grant that
      // resolves after the abort is handed straight back.
      const acquire = this.semaphore.acquire();
      const release = await Promise.race([
        acquire,
        onAbort(signal).then(() => undefined),
      ]);
      if (release === undefined) {
        void acquire.then((late) => late());
        record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
        return;
      }
      if (!ticket?.paused || signal.aborted) {
        try {
          if (signal.aborted) {
            record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
            return;
          }
          const controls: RunControls = {
            env: options.env,
            signal,
            isAborted: () => signal.aborted,
            waitWhilePaused: (runSignal) =>
              ticket ? this.waitWhilePaused(ticket, runSignal ?? signal) : Promise.resolve(),
          };
          const outcome = await runTask(task, controls, loaders, (handle) =>
            ticket?.executions.set(task.index, handle),
          );
          record(outcome);
          return;
        } finally {
          release();
        }
      }
      // Paused between acquire and start: give the slot back and re-park.
      release();
    }
  }

  private waitWhilePaused(
    ticket: Ticket,
    signal: AbortSignal,
  ): Promise<void> {
    return (async () => {
      while (ticket.paused && ticket.status === "running" && !signal.aborted) {
        const gate = ticket.pauseGate;
        if (!gate) break;
        await Promise.race([gate.promise, onAbort(signal)]);
      }
    })();
  }
}

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}
