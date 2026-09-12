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
  /** Canonical shared-write root when this task can mutate, else undefined. */
  readonly writeRoot: string | undefined;
}

export type TaskStatus = "ok" | "failed" | "cancelled";

export interface TaskOutcome {
  readonly index: number;
  readonly id: string;
  readonly status: TaskStatus;
  /** Final assistant text, when one was produced. */
  readonly output?: string;
  readonly error?: string;
  readonly retries: number;
  readonly usage?: Usage;
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
  /** Resolves when the ticket reaches a terminal status. */
  readonly settledGate: Deferred;
  /** Resolves when all task work (incl. post-cancel stragglers) has wound down. */
  readonly finishedGate: Deferred;
  readonly waiters: Set<() => void>;
  /** Live executions by task index, for cooperative abort. */
  readonly executions: Map<number, ExecutionHandle>;
}

export interface ExecutionHandle {
  /** Cooperative abort of in-flight model/tool work. Resolves when quiescent. */
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

/** Minimal counting semaphore with a mutable limit. */
export class Semaphore {
  private available: number;
  private readonly queue: (() => void)[] = [];
  constructor(private limit: number) {
    this.available = limit;
  }
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
    this.drain();
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(this.releaser()));
    });
  }
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available += 1;
      this.drain();
    };
  }
  private drain(): void {
    while (this.available > 0 && this.queue.length > 0) {
      this.available -= 1;
      this.queue.shift()!();
    }
  }
}
