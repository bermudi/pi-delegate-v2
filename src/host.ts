import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  canonicalPath,
  DELEGATE_TREES,
  exec,
  gitProbeEnv,
  isWithin,
} from "./fsx.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CHILD_TOOLS,
  expandTools,
  getBuiltinProfile,
  isWriter,
} from "./profiles.ts";
import { configPathOf, configuredModelFor, type DelegateConfig } from "./config.ts";
import type { TaskInput } from "./validation.ts";
import type { ResolvedTask, Workspace } from "./types.ts";

/**
 * The parent session's ModelRuntime. `ExtensionContext` exposes only the
 * ModelRegistry facade; the wrapped runtime is the same object the parent
 * streams through, and subagents must share it so runtime-registered
 * providers (and their auth) apply to child sessions. The field is
 * TypeScript-private; the guard proves the grabbed value is the real
 * `ModelRuntime` class — not merely present — so an upstream reshuffle
 * fails loudly here instead of mis-wiring child sessions. Tracked upstream
 * as earendil-works/pi#8791 (expose the model runtime to extensions); when
 * it lands, delete the grab. Patching pi-coding-agent locally via
 * patchedDependencies was deliberately rejected: patch rot on every Pi
 * release outweighs one loud, contained failure.
 */
export function parentModelRuntime(ctx: ExtensionContext): ModelRuntime {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown })
    .runtime;
  if (!(runtime instanceof ModelRuntime)) {
    throw new Error(
      "delegate cannot reach the parent session's model runtime; subagent dispatch is unavailable.",
    );
  }
  return runtime;
}

/** Everything task resolution and child construction need from the host. */
export interface HostEnvironment {
  readonly ctx: ExtensionContext;
  readonly modelRuntime: ModelRuntime;
  readonly agentDir: string;
  readonly getActiveTools: () => readonly string[];
}

/**
 * Assemble the host environment from an already-resolved agent directory:
 * the dispatch pipeline resolves the agent dir once (its fallback warning
 * needs the provenance) and threads it here, so no path re-derives it.
 */
export function hostEnvironment(
  ctx: ExtensionContext,
  agentDir: string,
  getActiveTools: () => readonly string[],
): HostEnvironment {
  return {
    ctx,
    modelRuntime: parentModelRuntime(ctx),
    agentDir,
    getActiveTools,
  };
}

// Probes fail fast and produce tiny output; the shared exec takes explicit
// limits so the per-use divergence from snapshot-sized traffic stays visible.
const PROBE_EXEC = { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024 } as const;

/** Probe failure carrying Git's stderr for fail-closed classification. */
class GitProbeError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * The scopes a task's writes can reach. Inside a Git worktree the top-level
 * is the reservation root (writes anywhere in it overlap); outside Git the
 * cwd itself is. An external `core.worktree` can put the top-level outside
 * the physical cwd — then the cwd stays reachable and is a second root.
 *
 * Fails closed: only Git's explicit "not a repository" permits the cwd-only
 * fallback. Git being unavailable, erroring, or returning an empty root is
 * ambiguous scope — an error, not a narrower reservation. The probe runs
 * with all `GIT_*` inherited redirects scrubbed so a polluted environment
 * cannot shrink the discovered scope.
 */
export async function writeRootsOf(cwd: string): Promise<readonly string[]> {
  const physicalCwd = canonicalPath(cwd);
  let top: string;
  try {
    top = (
      await exec("git", ["-C", physicalCwd, "rev-parse", "--show-toplevel"], {
        ...PROBE_EXEC,
        env: gitProbeEnv(),
        errorClass: GitProbeError,
      })
    ).stdout.trim();
  } catch (error) {
    const stderr = error instanceof GitProbeError ? error.stderr.trim() : "";
    if (/not a git repository/i.test(stderr)) {
      return [physicalCwd];
    }
    const detail =
      stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(
      `Could not safely determine the Git scope for '${physicalCwd}': ${detail}. ` +
        `Refusing to admit shared-write tasks with an ambiguous write scope.`,
    );
  }
  if (!top) {
    throw new Error(
      `Could not safely determine the Git scope for '${physicalCwd}': git returned an empty repository root. ` +
        `Refusing to admit shared-write tasks with an ambiguous write scope.`,
    );
  }
  const root = canonicalPath(top);
  return isWithin(root, physicalCwd) ? [root] : [root, physicalCwd];
}

const GLOBAL_CONTEXT_FILES = new Set([
  "agents.override.md",
  "agents.md",
  "claude.override.md",
  "claude.md",
]);

/** User-global harness instructions are not inherited by subagents. */
function isGlobalContextFile(filePath: string, agentDir: string): boolean {
  const resolved = resolve(filePath);
  for (const root of [resolve(agentDir), resolve(homedir(), ".agents")]) {
    if (GLOBAL_CONTEXT_FILES.has(relative(root, resolved).toLowerCase()))
      return true;
  }
  return false;
}

function resolveModel(
  spec: string | undefined,
  env: HostEnvironment,
): Model<Api> | undefined {
  if (spec === undefined) return env.ctx.model as Model<Api> | undefined;
  // Lookups go through the public ModelRegistry facade; the private runtime
  // grab (env.modelRuntime) exists solely to hand child sessions the parent's
  // runtime so registered providers and auth carry over.
  const registry = env.ctx.modelRegistry;
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const exact = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (exact) return exact;
  }
  const wanted = spec.toLowerCase();
  for (const model of registry.getAvailable()) {
    if (
      `${model.provider}/${model.id}`.toLowerCase() === wanted ||
      model.id.toLowerCase() === wanted
    ) {
      return model;
    }
  }
  return undefined;
}

const RESUME_DEFAULT_PROMPT =
  "Continue from where you left off. Pick up the task and keep going.";

/**
 * Resolve validated task inputs into executable tasks: agent profile, model,
 * tools, absolute cwd, and the shared-write reservation roots. Everything
 * that can fail is resolved here, before admission and before execution.
 *
 * Model policy: callers never select models. A named agent runs on the
 * model configured for it under "models" in the user-global delegate.json;
 * everything else — inline tasks and the `default` profile — mirrors the
 * parent's model, unconditionally. The model registry knowing a reference
 * is not authorization — only the user's configuration is.
 */
export async function resolveTasks(
  tasks: readonly TaskInput[],
  env: HostEnvironment,
  config: DelegateConfig,
): Promise<ResolvedTask[]> {
  let parentActive: string[] = [];
  if (tasks.some((task) => task.agent === "default" && task.tools === undefined)) {
    try {
      parentActive = env
        .getActiveTools()
        .filter((name) => (CHILD_TOOLS as readonly string[]).includes(name));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message =
        `Cannot resolve default-profile parent tools: ${detail}. ` +
        `Restore the parent tool inventory or supply explicit tools for every default-profile task.`;
      console.error(`[delegate] ${message}`, error);
      throw new Error(message, { cause: error });
    }
  }

  const resolved: ResolvedTask[] = [];
  for (const [index, task] of tasks.entries()) {
    const where = `tasks[${index}]${task.id ? ` (id '${task.id}')` : ""}`;
    const profile = task.agent ? getBuiltinProfile(task.agent) : undefined;
    if (task.agent && !profile) {
      throw new Error(`${where}: unknown agent '${task.agent}'.`);
    }

    let tools: string[] | string;
    if (task.tools !== undefined) {
      tools = expandTools(task.tools);
    } else if (task.agent === "default") {
      tools = parentActive;
    } else if (profile?.tools) {
      tools = [...profile.tools];
    } else {
      tools = expandTools(undefined);
    }
    if (typeof tools === "string") {
      throw new Error(`${where}: ${tools}`);
    }

    // Model selection is user-only and inheritance-first: named agents use
    // their configured entry when one exists; inline/default tasks always
    // mirror the parent. A caller-supplied model field was rejected in
    // validation.
    const agentName = task.agent ?? "default";
    const modelSpec = configuredModelFor(task.agent, config);
    const model = resolveModel(modelSpec, env);
    if (!model) {
      throw new Error(
        modelSpec
          ? `${where}: models.${agentName} is configured as '${modelSpec}' in ${configPathOf(env.agentDir)} but is not available in this session's model registry.`
          : agentName === "default"
            ? `${where}: no parent model is selected — inline/default tasks inherit it and are not configurable otherwise.`
            : `${where}: no model is configured for agent '${agentName}' and no parent model is selected; add models.${agentName} under "models" in ${configPathOf(env.agentDir)}.`,
      );
    }

    const cwd = task.cwd ? resolve(env.ctx.cwd, task.cwd) : env.ctx.cwd;
    if (!existsSync(cwd)) {
      throw new Error(`${where}: cwd does not exist: '${cwd}'.`);
    }

    const workspace: Workspace = task.workspace ?? "shared";
    if (workspace === "scratch" && !isWriter(tools)) {
      throw new Error(
        `${where}: workspace "scratch" copies the tree for a task whose tools are all read-only — the copy buys nothing. Omit workspace to run in the source tree, or add write-capable tools.`,
      );
    }
    const reserves =
      (workspace === "shared" && isWriter(tools)) || workspace === "isolated";

    const prompt = task.prompt ?? (task.resumeFrom ? RESUME_DEFAULT_PROMPT : "");

    resolved.push({
      index,
      id: task.id ?? `task-${index + 1}`,
      prompt,
      agent: task.agent ?? "inline",
      cwd: canonicalPath(cwd),
      model,
      thinking: task.thinking ?? profile?.thinking ?? env.ctx.thinkingLevel,
      tools,
      systemPrompt: task.systemPrompt ?? profile?.systemPrompt,
      sessionId: task.sessionId,
      resumeFrom: task.resumeFrom,
      deadlineMs: task.deadlineMs,
      workspace,
      writeRoots: reserves ? await writeRootsOf(cwd) : undefined,
    } satisfies ResolvedTask);
  }
  return resolved;
}

/**
 * Create a subagent session for one resolved task. Subagents are headless
 * workers: no extensions, no user-global context files. One-shot tasks use
 * an in-memory transcript; a `sessionId` task needs a durable session file
 * to be poolable (a `resumeFrom` transcript already is one), so it gets a
 * file under `<agentDir>/delegate-sessions/`. Evicted or failed sessions
 * leave their transcripts on disk as the recovery record for `resumeFrom`.
 * The session streams through the parent session's model runtime so
 * provider registrations and auth are inherited.
 */
export async function createSubagentSession(
  task: ResolvedTask,
  env: HostEnvironment,
  resourceLoader: DefaultResourceLoader,
): Promise<AgentSession> {
  const sessionManager = task.resumeFrom
    ? SessionManager.open(task.resumeFrom)
    : task.sessionId !== undefined
      ? SessionManager.create(
          task.cwd,
          join(env.agentDir, DELEGATE_TREES.sessions),
        )
      : SessionManager.inMemory(task.cwd);
  const { session } = await createAgentSession({
    cwd: task.cwd,
    agentDir: env.agentDir,
    modelRuntime: env.modelRuntime,
    model: task.model,
    thinkingLevel: task.thinking,
    tools: [...task.tools],
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
    resourceLoader,
  });
  return session;
}

/**
 * A resource loader for one task: no extensions (subagents must not inherit
 * the parent's interactive extension inventory — including this tool), no
 * user-global context files; project context under the task cwd is kept.
 */
export function createSubagentResourceLoader(
  task: ResolvedTask,
  env: HostEnvironment,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: task.cwd,
    agentDir: env.agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    agentsFilesOverride: ({ agentsFiles }) => ({
      agentsFiles: agentsFiles.filter(
        ({ path }) => !isGlobalContextFile(path, env.agentDir),
      ),
    }),
    ...(task.systemPrompt !== undefined
      ? { systemPrompt: task.systemPrompt }
      : {}),
  });
}
