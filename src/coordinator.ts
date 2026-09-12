import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { AdmissionGrant } from "./admission.ts";
import { modelConcurrencyLimit, type DelegateConfig } from "./config.ts";
import { runTask, type RunControls } from "./execution.ts";
import type { HostEnvironment } from "./host.ts";
import { Semaphore } from "./types.ts";
import type { TicketStore } from "./tickets.ts";
import type {
  ExecutionHandle,
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
  private readonly modelSemaphores = new Map<string, Semaphore>();

  constructor(private readonly tickets: TicketStore) {}

  /** Per-model bound, keyed `provider/id`; created once, re-limited per call. */
  private modelSemaphore(task: ResolvedTask, config: DelegateConfig): Semaphore {
    const key = `${task.model.provider}/${task.model.id}`;
    let semaphore = this.modelSemaphores.get(key);
    if (!semaphore) {
      semaphore = new Semaphore(modelConcurrencyLimit(key, config));
      this.modelSemaphores.set(key, semaphore);
    } else {
      semaphore.setLimit(modelConcurrencyLimit(key, config));
    }
    return semaphore;
  }

  /**
   * Acquire a semaphore slot with abort wake-up: a grant resolving after the
   * abort is handed straight back, and undefined signals cancellation.
   */
  private async acquireOrAborted(
    semaphore: Semaphore,
    signal: AbortSignal,
  ): Promise<(() => void) | undefined> {
    const acquire = semaphore.acquire();
    const release = await Promise.race([
      acquire,
      onAbort(signal).then(() => undefined),
    ]);
    if (release === undefined) {
      void acquire.then((late) => late());
      return undefined;
    }
    return release;
  }

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
      // Tasks whose sessions could not be confirmed quiescent keep their
      // reservations: their roots may still be mutating.
      const retained = new Set<number>();
      for (const outcome of outcomes) {
        if (outcome?.quarantined) retained.add(outcome.index);
      }
      grant.release(retained);
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
      config: DelegateConfig;
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
    // Once the worker's true outcome has landed it must not be overwritten
    // by a provisional one — worker truth is strictly better information.
    let workerTruthRecorded = false;
    const record = (outcome: TaskOutcome) => {
      if (workerTruthRecorded) return;
      outcomes[task.index] = outcome;
      if (ticket) {
        // The store owns lifecycle; recording can settle the ticket but
        // never un-settles it.
        this.tickets.recordOutcome(ticket, outcome);
      }
    };
    /**
     * The worker's true settlement, independent of the caller-visible one.
     * The live handle is dropped at real quiescence — a provisional
     * (cancelled-before-confirmed) outcome leaves the worker reachable for
     * a later, stronger abort. When the true outcome differs from what was
     * recorded, it replaces it for visibility — never the ticket status —
     * and confirmed quiescence releases the retained reservation.
     */
    const onWorkerSettled = (
      handle: ExecutionHandle,
      late: TaskOutcome | undefined,
    ) => {
      if (ticket?.executions.get(task.index) === handle) {
        ticket.executions.delete(task.index);
      }
      if (late === undefined) return;
      workerTruthRecorded = true;
      outcomes[task.index] = late;
      if (ticket) this.tickets.recordOutcome(ticket, late);
      if (!late.quarantined) grant.releaseRetained(task.index);
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
      // Queued tasks need both a per-model slot and a global slot; abort
      // wakes them without waiting for either.
      const modelRelease = await this.acquireOrAborted(
        this.modelSemaphore(task, options.config),
        signal,
      );
      if (modelRelease === undefined) {
        record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
        return;
      }
      const release = await this.acquireOrAborted(this.semaphore, signal);
      if (release === undefined) {
        modelRelease();
        record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
        return;
      }
      const releaseBoth = () => {
        release();
        modelRelease();
      };
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
          const outcome = await runTask(
            task,
            controls,
            loaders,
            (handle) => ticket?.executions.set(task.index, handle),
            onWorkerSettled,
          );
          record(outcome);
          return;
        } finally {
          releaseBoth();
        }
      }
      // Paused between acquire and start: give the slots back and re-park.
      releaseBoth();
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
