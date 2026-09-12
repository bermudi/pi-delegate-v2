import type {
  AgentSession,
  AgentSessionEvent,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  createSubagentResourceLoader,
  createSubagentSession,
  type HostEnvironment,
} from "./host.ts";
import {
  isClearlyTransientError,
  isModelAttributableError,
  MAX_TASK_ATTEMPTS,
  MODEL_SWAP_HINT,
  RETRY_DELAY_MS,
  sleep,
} from "./retry.ts";
import type {
  ExecutionHandle,
  ResolvedTask,
  TaskOutcome,
} from "./types.ts";

/** Cooperative controls the coordinator hands to each task run. */
export interface RunControls {
  readonly env: HostEnvironment;
  /** Block while the owning ticket is paused; resolves early on abort. */
  readonly waitWhilePaused: (signal?: AbortSignal) => Promise<void>;
  /** Whether this run's work has been cancelled or its deadline fired. */
  readonly isAborted: () => boolean;
  /** Combined cancellation signal (ticket cancel, parent abort, deadline). */
  readonly signal: AbortSignal;
}

export interface AttemptResult {
  readonly status: "ok" | "failed" | "cancelled";
  readonly output?: string;
  readonly error?: string;
  readonly usage?: Usage;
  readonly hadSideEffects: boolean;
}

function log(context: string, error: unknown): void {
  console.error(
    `[delegate] ${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function usageOf(session: AgentSession): Usage {
  const stats = session.getSessionStats();
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: stats.cost,
    },
  };
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

const SIDE_EFFECT_TOOLS = new Set(["write", "edit", "bash"]);

function lastAssistantText(session: AgentSession): {
  text: string;
  stopReason?: string;
  errorMessage?: string;
} {
  const last = session.messages
    .filter((m): m is AssistantMessage => m.role === "assistant")
    .at(-1);
  if (!last || !Array.isArray(last.content)) {
    return { text: "", stopReason: last?.stopReason, errorMessage: last?.errorMessage };
  }
  const text = last.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { text, stopReason: last.stopReason, errorMessage: last.errorMessage };
}

/**
 * One attempt at one task. Owns the child AgentSession for the attempt's
 * duration and exposes cooperative abort. A run ends when prompt() settles;
 * the child is extension-free, so settlement means no background
 * continuations remain.
 */
export class TaskExecution implements ExecutionHandle {
  private session: AgentSession | undefined;
  private abortReason: string | undefined;
  private finished = false;
  private disposed = false;
  private readonly done: Promise<AttemptResult>;

  constructor(
    private readonly task: ResolvedTask,
    private readonly controls: RunControls,
    loader: DefaultResourceLoader,
  ) {
    this.done = this.run(loader);
  }

  result(): Promise<AttemptResult> {
    return this.done;
  }

  /** Cooperative abort: request cancellation and wait for the session to idle. */
  async abort(reason: string): Promise<void> {
    this.abortReason ??= reason;
    const session = this.session;
    if (!session || this.finished) return;
    try {
      await session.abort();
    } catch (error) {
      // The session may still be mutating; leave it undisposed (quarantined)
      // rather than risk cleanup while work continues.
      log(`abort of task ${this.task.id} failed; session left undisposed`, error);
      return;
    }
    this.disposeSession();
  }

  private disposeSession(): void {
    if (this.disposed || !this.session) return;
    this.disposed = true;
    try {
      this.session.dispose();
    } catch (error) {
      log(`dispose of task ${this.task.id} failed`, error);
    }
  }

  private async run(loader: DefaultResourceLoader): Promise<AttemptResult> {
    let session: AgentSession | undefined;
    try {
      session = await createSubagentSession(this.task, this.controls.env, loader);
      this.session = session;
      // A cancellation that landed during session creation would have found
      // no session to abort; honor it now before the prompt starts.
      if (this.abortReason !== undefined || this.controls.isAborted()) {
        try {
          await session.abort();
        } catch (error) {
          log(`abort during setup of task ${this.task.id} failed`, error);
        }
      }

      // Pause gate between model turns: when the ticket is paused, a turn
      // that produced tool calls parks before the next provider request. A
      // naturally final turn (no tool results) never parks.
      const agent = session.agent;
      const previous = agent.prepareNextTurnWithContext;
      agent.prepareNextTurnWithContext = async (turn, signal) => {
        if (turn.toolResults.length > 0) {
          await this.controls.waitWhilePaused(signal);
        }
        return previous?.(turn, signal);
      };

      // Track tool executions that produced side effects; whole-task retry
      // must never replay them.
      let hadSideEffects = false;
      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        if (
          event.type === "tool_execution_end" &&
          SIDE_EFFECT_TOOLS.has(event.toolName)
        ) {
          hadSideEffects = true;
        }
      });

      const onAbort = () => void this.abort("cancelled");
      this.controls.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await session.prompt(this.task.prompt, {
          expandPromptTemplates: false,
        });
        await session.waitForIdle();
      } finally {
        this.controls.signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }

      const { text, stopReason, errorMessage } = lastAssistantText(session);
      const usage = usageOf(session);
      if (this.abortReason === "deadline") {
        return {
          status: "failed",
          output: text || undefined,
          error: `deadline exceeded after ${this.task.deadlineMs}ms`,
          usage,
          hadSideEffects,
        };
      }
      if (this.abortReason || this.controls.isAborted() || stopReason === "aborted") {
        return {
          status: "cancelled",
          output: text || undefined,
          usage,
          hadSideEffects,
        };
      }
      if (stopReason === "error") {
        const error = errorMessage ?? "the provider returned an error";
        return {
          status: "failed",
          output: text || undefined,
          error: isModelAttributableError(error)
            ? `${error} — ${MODEL_SWAP_HINT}`
            : error,
          usage,
          hadSideEffects,
        };
      }
      return { status: "ok", output: text, usage, hadSideEffects };
    } catch (error) {
      if (this.abortReason === "deadline") {
        return {
          status: "failed",
          error: `deadline exceeded after ${this.task.deadlineMs}ms`,
          hadSideEffects: false,
        };
      }
      if (this.abortReason || this.controls.isAborted()) {
        return { status: "cancelled", hadSideEffects: false };
      }
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        hadSideEffects: false,
      };
    } finally {
      this.finished = true;
      this.disposeSession();
    }
  }
}

function canRetryWholeTask(
  task: ResolvedTask,
  attempt: AttemptResult,
): boolean {
  return (
    !task.sessionId &&
    !task.resumeFrom &&
    !attempt.hadSideEffects &&
    isClearlyTransientError(attempt.error)
  );
}

/**
 * Run a task with the whole-task retry policy: a clearly transient failure
 * gets a bounded number of fresh attempts; model-attributable, cancelled,
 * and side-effecting failures return immediately.
 */
export async function runTask(
  task: ResolvedTask,
  controls: RunControls,
  loaders: Map<string, Promise<DefaultResourceLoader>>,
  onExecution?: (handle: ExecutionHandle) => void,
): Promise<TaskOutcome> {
  let retries = 0;
  let usage: Usage | undefined;
  let last: AttemptResult = {
    status: "failed",
    error: "no attempt ran",
    hadSideEffects: false,
  };

  for (;;) {
    if (controls.isAborted()) {
      last = { status: "cancelled", hadSideEffects: false };
      break;
    }
    const key = `${task.cwd}${task.systemPrompt ?? ""}`;
    let loaderPromise = loaders.get(key);
    if (!loaderPromise) {
      const loader = createSubagentResourceLoader(task, controls.env);
      loaderPromise = loader.reload().then(() => loader);
      loaders.set(key, loaderPromise);
    }
    const loader = await loaderPromise;

    const execution = new TaskExecution(task, controls, loader);
    onExecution?.(execution);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (task.deadlineMs !== undefined) {
      timer = setTimeout(() => void execution.abort("deadline"), task.deadlineMs);
    }
    try {
      last = await execution.result();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    usage = addUsage(usage, last.usage);

    if (last.status !== "failed" || controls.isAborted()) break;
    if (retries + 1 >= MAX_TASK_ATTEMPTS || !canRetryWholeTask(task, last)) break;
    retries += 1;
    try {
      await sleep(RETRY_DELAY_MS, controls.signal);
    } catch {
      last = {
        status: "cancelled",
        output: last.output,
        usage: last.usage,
        hadSideEffects: last.hadSideEffects,
      };
      break;
    }
  }

  return {
    index: task.index,
    id: task.id,
    status:
      controls.isAborted() && last.status !== "ok" ? "cancelled" : last.status,
    output: last.output,
    error: last.error,
    retries,
    usage,
  };
}
