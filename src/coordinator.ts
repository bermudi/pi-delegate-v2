import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { AdmissionGrant } from "./admission.ts";
import { modelConcurrencyLimit, type DelegateConfig } from "./config.ts";
import { runTask, type RunControls } from "./execution.ts";
import type { HostEnvironment } from "./host.ts";
import type { SessionPool } from "./sessions.ts";
import { Deferred, Semaphore } from "./types.ts";
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
   *
   * `finalize` runs after every task has a caller-visible outcome but inside
   * the admission-reservation window — isolated reconciliation lives there.
   * `onWorkerQuiesced` runs when a provisionally-recorded worker's true
   * settlement arrives, before its retained reservation is released.
   */
  async run(
    tasks: readonly ResolvedTask[],
    options: {
      env: HostEnvironment;
      config: DelegateConfig;
      grant: AdmissionGrant;
      sessions: SessionPool;
      signal?: AbortSignal;
      ticket?: Ticket;
      finalize?: (
        outcomes: TaskOutcome[],
      ) => Promise<readonly TaskOutcome[]>;
      onWorkerQuiesced?: (taskIndex: number) => Promise<void>;
      /**
       * This batch's shutdown barrier, accepted as part of taking the
       * batch. `run` binds its resolver in the synchronous prefix of the
       * call — before the first await — so the moment the dispatcher
       * invokes `run` the transfer is total: the dispatcher's failure
       * routine can no longer run, and this call resolves the barrier on
       * every path it owns. The barrier resolves once EVERY task's
       * quiescence is confirmed, every worker that settled late through
       * `onWorkerSettled` has finished its deferred cleanup and
       * retained-reservation release, AND the batch itself has finished —
       * `finalize` (isolated reconciliation, scratch finalization) plus
       * the admission-reservation release. Worker quiescence alone is not
       * full quiescence: reconciliation still mutates the source tree
       * after the last worker stops, and shutdown completing in that
       * window would let a replacement session (whose admission
       * controller knows nothing of this batch) start writers into it.
       * The barrier resolves independently of this call's own fate and
       * never while a quarantined worker is unconfirmed — no timeout.
       */
      quiescence: Deferred;
    },
  ): Promise<DispatchOutcome> {
    const outcomes: (TaskOutcome | undefined)[] = new Array(tasks.length);
    // A serialized successor must wait for its predecessor's confirmed
    // quiescence — not merely a recorded outcome. A provisional
    // (quarantined) predecessor may still be mutating the shared root.
    const quiescence = new Map<number, Deferred>();
    // Confirmed quiescence alone is not the full barrier: a late-settled
    // worker still owes deferred cleanup and its retained-reservation
    // release. `fullyQuiesced` resolves only after that tail completes.
    const fullyQuiesced = new Map<number, Deferred>();
    for (const task of tasks) {
      quiescence.set(task.index, new Deferred());
      fullyQuiesced.set(task.index, new Deferred());
    }
    // Resolves once the run body itself has finished: `finalize` (isolated
    // reconciliation applying to or retaining against the source tree,
    // scratch disposal) and the admission-reservation release in the
    // finally below.
    const bodySettled = new Deferred();
    // Accept the batch's shutdown barrier before anything that could
    // throw: this wiring is the synchronous prefix of the call, so from
    // the moment `run` is invoked the coordinator owns the barrier's
    // resolution on every path. The `finally` below always resolves
    // `bodySettled` (even on a finalize failure), and a worker that never
    // settles keeps its `fullyQuiesced` pending — so a batch this call has
    // taken can never leak its barrier, and a worker that may still be
    // mutating holds it.
    void Promise.all([
      ...tasks.map((task) => fullyQuiesced.get(task.index)!.promise),
      bodySettled.promise,
    ]).then(() => options.quiescence.resolve());
    // Nothing between the barrier wiring above and the `try` below may
    // throw. The dispatcher's cancelled-preparation rerun invokes `run`
    // with no fallback catch: a throw in this gap on that path would leak
    // the barrier and hang every future shutdown. `setLimit` cannot throw
    // for a validated numeric config; keep it that way.
    this.semaphore.setLimit(options.config.maxConcurrent);
    const grant = options.grant;
    const loaders = new Map<string, Promise<DefaultResourceLoader>>();

    try {
      await Promise.all(
        tasks.map((task) =>
          this.runOne(
            task,
            options,
            grant,
            loaders,
            outcomes,
            quiescence,
            fullyQuiesced,
          ),
        ),
      );
      // Defensive: runOne is exception-safe and every exit records an
      // outcome, but a silent gap would skip finalization and leak
      // reservations. A missing outcome means the task's state is unknown —
      // quarantine it rather than assume the root is clean. This names the
      // blocker: shutdown will wait on this dispatch's quiescence barrier
      // while the reservation stays held, so the task must be visible.
      for (const task of tasks) {
        if (outcomes[task.index] === undefined) {
          console.error(
            `[delegate] internal dispatch error for task ${task.id} (index ${task.index}): no outcome was recorded; quarantining its write scope and holding shutdown quiescence for this dispatch`,
          );
          const outcome: TaskOutcome = {
            index: task.index,
            id: task.id,
            status: "failed",
            error: "internal dispatch error: no outcome was recorded",
            retries: 0,
            quarantined: true,
          };
          outcomes[task.index] = outcome;
          if (options.ticket) {
            this.tickets.recordOutcome(options.ticket, outcome);
          }
        }
      }
      if (options.finalize) {
        const ticket = options.ticket;
        try {
          await options.finalize(outcomes as TaskOutcome[]);
        } finally {
          if (ticket) {
            // The finalized (integration-annotated) outcomes are the ticket's
            // terminal record; settlement is held until they land.
            for (const outcome of outcomes) {
              if (outcome) this.tickets.recordOutcome(ticket, outcome);
            }
          }
        }
      }
    } finally {
      // Tasks whose sessions could not be confirmed quiescent keep their
      // reservations: their roots may still be mutating.
      const retained = new Set<number>();
      for (const outcome of outcomes) {
        if (outcome?.quarantined) retained.add(outcome.index);
      }
      grant.release(retained);
      options.ticket?.finishedGate.resolve();
      // Only now is the batch fully quiesced for a shutdown barrier:
      // finalization and every admission reservation release have run.
      bodySettled.resolve();
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
      sessions: SessionPool;
      signal?: AbortSignal;
      ticket?: Ticket;
      onWorkerQuiesced?: (taskIndex: number) => Promise<void>;
    },
    grant: AdmissionGrant,
    loaders: Map<string, Promise<DefaultResourceLoader>>,
    outcomes: (TaskOutcome | undefined)[],
    quiescence: Map<number, Deferred>,
    fullyQuiesced: Map<number, Deferred>,
  ): Promise<void> {
    const ticket = options.ticket;
    const signal = combineSignals(
      options.signal,
      ticket?.cancellation.signal,
    );
    const confirmed = quiescence.get(task.index)!;
    const fully = fullyQuiesced.get(task.index)!;
    // True once a worker session may exist; below that point a failure is
    // provably pre-worker and needs no quarantine.
    let workerCreated = false;
    // Once the worker's true outcome has landed it must not be overwritten
    // by a provisional one — worker truth is strictly better information.
    let workerTruthRecorded = false;
    const record = (outcome: TaskOutcome) => {
      if (workerTruthRecorded) return;
      outcomes[task.index] = outcome;
      // A non-quarantined outcome confirms the worker is done (or never
      // started): serialized successors may proceed, and nothing remains
      // owed to a shutdown barrier — no deferred cleanup is pending.
      if (!outcome.quarantined) {
        confirmed.resolve();
        fully.resolve();
      }
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
      // Reconciliation may already have annotated the provisional entry;
      // worker truth replaces the run outcome but keeps its integration.
      const merged: TaskOutcome = {
        ...late,
        integration: outcomes[task.index]?.integration ?? late.integration,
      };
      outcomes[task.index] = merged;
      if (ticket) this.tickets.recordOutcome(ticket, merged);
      // Settled() resolving proves the worker stopped — no background
      // continuations remain — even when an earlier abort threw and marked
      // the outcome quarantined. A thrown abort must not poison quiescence
      // confirmation for the worker's lifetime: confirm now, run the
      // deferred cleanup, and release the retained reservation so shutdown
      // and admission are not held forever by a stopped worker. A worker
      // that never settles never reaches here, so its barrier correctly
      // stays pending while it may still be mutating.
      confirmed.resolve();
      // Confirmed quiescence: deferred workspace cleanup first, then the
      // retained reservation may be released. Only after that tail is the
      // task fully quiesced for a shutdown barrier.
      void (async () => {
        try {
          await options.onWorkerQuiesced?.(task.index);
        } catch (error) {
          console.error(
            `[delegate] deferred cleanup after quiescence of task ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        grant.releaseRetained(task.index);
        fully.resolve();
      })();
    };

    // Queued tasks hold no execution resources: pause first, then wait for a
    // serialized writer predecessor, then acquire a concurrency slot.
    // A throw anywhere below is an infrastructure fault, not a task failure —
    // convert it so Promise.all can never reject while siblings still run.
    try {
      while (true) {
        if (ticket) await this.waitWhilePaused(ticket, signal);
        if (signal.aborted) {
          record({ index: task.index, id: task.id, status: "cancelled", retries: 0 });
          return;
        }
        const predecessor = grant.predecessors.get(task.index);
        if (predecessor !== undefined) {
          // Wait for confirmed quiescence, not caller-visible settlement: a
          // provisional predecessor may still be writing the shared root.
          await Promise.race([
            quiescence.get(predecessor)?.promise ?? Promise.resolve(),
            onAbort(signal),
          ]);
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
              sessions: options.sessions,
              signal,
              stallTimeoutMs: options.config.stallTimeoutMs,
              isAborted: () => signal.aborted,
              waitWhilePaused: (runSignal) =>
                ticket ? this.waitWhilePaused(ticket, runSignal ?? signal) : Promise.resolve(),
            };
            const outcome = await runTask(
              task,
              controls,
              loaders,
              (handle) => {
                workerCreated = true;
                ticket?.executions.set(task.index, handle);
              },
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
    } catch (error) {
      // Unknown task state: quarantine when a worker session may exist so
      // its reservation stays held; otherwise the root is provably clean.
      record({
        index: task.index,
        id: task.id,
        status: "failed",
        error: `internal dispatch error: ${error instanceof Error ? error.message : String(error)}`,
        retries: 0,
        quarantined: workerCreated || undefined,
      });
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
