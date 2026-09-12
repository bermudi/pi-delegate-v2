import type { Model, Api, Usage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type Workspace = "shared" | "scratch" | "isolated";
export type ContextMode = "fresh" | "with-parent-transcript";

/** A task after semantic validation and agent/model/tool resolution. */
export interface ResolvedTask {
  readonly index: number;
  /** Caller-provided correlation id, or `task-<n>`. */
  readonly id: string;
  readonly prompt: string;
  readonly agent: string;
  /** Absolute, canonicalized working directory for the task. */
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly thinking: ThinkingLevel | undefined;
  /** Expanded built-in tool names for the child session. */
  readonly tools: readonly string[];
  readonly systemPrompt: string | undefined;
  readonly context: ContextMode;
  readonly sessionId: string | undefined;
  readonly resumeFrom: string | undefined;
  readonly deadlineMs: number | undefined;
  readonly workspace: Workspace;
  /**
   * Canonical write-scope roots when this task can mutate, else undefined.
   * Usually a single root; an external `core.worktree` keeps the physical
   * cwd reachable beside the Git top-level, so both are listed.
   */
  readonly writeRoots: readonly string[] | undefined;
}

export type TaskStatus = "ok" | "failed" | "cancelled";

/** How an isolated task's proposal ended up relative to the source tree. */
export type IntegrationStatus =
  | "applied_unverified"
  | "conflict"
  | "retained"
  | "no_changes"
  | "discarded"
  | "apply_failed";

export interface TaskIntegration {
  readonly status: IntegrationStatus;
  /** Why a proposal was retained or discarded, when not obvious. */
  readonly reason?: string;
  readonly proposedFiles: readonly string[];
  readonly appliedFiles: readonly string[];
  readonly conflicts?: readonly { path: string; reason: string }[];
  /** Recovery pointers for proposals that were not cleanly applied. */
  readonly baselineRef?: string;
  readonly proposalRef?: string;
  readonly patchPath?: string;
  readonly worktreePath?: string;
}

export interface TaskOutcome {
  readonly index: number;
  readonly id: string;
  readonly status: TaskStatus;
  /** Final assistant text, when one was produced. */
  readonly output?: string;
  readonly error?: string;
  readonly retries: number;
  readonly usage?: Usage;
  /** Isolated-workspace reconciliation result, when the task ran isolated. */
  readonly integration?: TaskIntegration;
  /**
   * True when the task's session could not be confirmed quiescent and was
   * left undisposed. Callers must keep its reservations alive — work may
   * still be mutating shared roots.
   */
  readonly quarantined?: boolean;
}

export type TicketStatus = "running" | "completed" | "failed" | "cancelled";

/** Guarded ticket record. `status` only moves running → terminal, once. */
export interface Ticket {
  readonly id: string;
  status: TicketStatus;
  /** Orthogonal to lifecycle: a paused ticket remains `running`. */
  paused: boolean;
  pauseGate: Deferred | undefined;
  readonly totalTasks: number;
  /** Index-aligned per-task outcomes; entries appear as tasks finish. */
  readonly outcomes: (TaskOutcome | undefined)[];
  readonly tasks: readonly ResolvedTask[];
  readonly createdAt: number;
  /** Aborts in-flight executions when force-cancelled. */
  readonly cancellation: AbortController;
  /**
   * When true, recorded outcomes never settle the ticket — an explicit
   * `releaseSettlement` is required after post-run reconciliation lands, so
   * the terminal view includes integration results.
   */
  holdSettlement: boolean;
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
}

export interface ExecutionHandle {
  /**
   * Cooperative abort of in-flight model/tool work. The promise resolves
   * only if the worker confirms quiescence — it may never resolve when a
   * provider or tool ignores cancellation, so nothing caller-visible may
   * block on it.
   */
  abort(reason: string): Promise<void>;
}

export class Deferred {
  readonly promise: Promise<void>;
  private resolveFn!: () => void;
  private done = false;
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolveFn = resolve;
    });
  }
  get resolved(): boolean {
    return this.done;
  }
  resolve(): void {
    if (!this.done) {
      this.done = true;
      this.resolveFn();
    }
  }
}

/**
 * Minimal counting semaphore with a mutable limit. `active` counts granted
 * permits; grants are issued only while `active < limit`, so raising the
 * limit wakes queued waiters and lowering it simply stops new grants until
 * releases bring usage under the new bound.
 */
export class Semaphore {
  private active = 0;
  private limit: number;
  private readonly queue: (() => void)[] = [];
  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.drain();
  }
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(this.releaser());
      });
    });
  }
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }
  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      this.queue.shift()!();
    }
  }
}
