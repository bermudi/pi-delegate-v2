import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CHILD_TOOLS,
  expandTools,
  getBuiltinProfile,
  isWriter,
} from "./profiles.ts";
import { agentDirOf } from "./config.ts";
import type { TaskInput } from "./validation.ts";
import type { ResolvedTask, Workspace } from "./types.ts";

/**
 * The parent session's ModelRuntime. `ExtensionContext` exposes only the
 * ModelRegistry facade; the wrapped runtime is the same object the parent
 * streams through, and subagents must share it so runtime-registered
 * providers (and their auth) apply to child sessions. The field is
 * TypeScript-private but present at runtime; fail loudly if that changes.
 */
export function parentModelRuntime(ctx: ExtensionContext): ModelRuntime {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime })
    .runtime;
  if (!runtime) {
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

export function hostEnvironment(
  ctx: ExtensionContext,
  getActiveTools: () => readonly string[],
): HostEnvironment {
  return {
    ctx,
    modelRuntime: parentModelRuntime(ctx),
    agentDir: agentDirOf(ctx),
    getActiveTools,
  };
}

/** Canonical path for admission comparisons (resolves symlinks). */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The scope a task's writes can reach. Inside a Git worktree the top-level is
 * the reservation root (writes anywhere in it overlap); outside Git the cwd
 * itself is. Git discovery failure falls back to the physical cwd.
 */
export function writeRootOf(cwd: string): string {
  try {
    const top = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (top) return canonicalPath(top);
  } catch {
    // Not a repository (or git unavailable): the physical cwd is the scope.
  }
  return canonicalPath(cwd);
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
  const runtime = env.modelRuntime;
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const exact = runtime.getModel(spec.slice(0, slash), spec.slice(slash + 1));
    if (exact) return exact;
  }
  const wanted = spec.toLowerCase();
  for (const model of runtime.getModels()) {
    if (
      `${model.provider}/${model.id}`.toLowerCase() === wanted ||
      model.id.toLowerCase() === wanted
    ) {
      return model;
    }
  }
  return undefined;
}

/**
 * Resolve validated task inputs into executable tasks: agent profile, model,
 * tools, absolute cwd, and the shared-write reservation root. Everything
 * that can fail is resolved here, before admission and before execution.
 */
export function resolveTasks(
  tasks: readonly TaskInput[],
  env: HostEnvironment,
): ResolvedTask[] {
  let parentActive: string[] = [];
  try {
    parentActive = env
      .getActiveTools()
      .filter((name) => (CHILD_TOOLS as readonly string[]).includes(name));
  } catch {
    // The host may not expose its active tool list; the default profile
    // then falls back to the standard writer set below.
  }

  return tasks.map((task, index) => {
    const where = `tasks[${index}]${task.id ? ` (id '${task.id}')` : ""}`;
    const profile = task.agent ? getBuiltinProfile(task.agent) : undefined;
    if (task.agent && !profile) {
      throw new Error(`${where}: unknown agent '${task.agent}'.`);
    }

    let tools: string[] | string;
    if (task.tools) {
      tools = expandTools(task.tools);
    } else if (task.agent === "default") {
      tools = parentActive.length > 0 ? parentActive : expandTools(undefined);
    } else if (profile?.tools) {
      tools = [...profile.tools];
    } else {
      tools = expandTools(undefined);
    }
    if (typeof tools === "string") {
      throw new Error(`${where}: ${tools}`);
    }

    const model = resolveModel(task.model, env);
    if (!model) {
      throw new Error(
        task.model
          ? `${where}: unknown or unavailable model '${task.model}'.`
          : `${where}: no parent model is selected; set an explicit task model.`,
      );
    }

    const cwd = task.cwd ? resolve(env.ctx.cwd, task.cwd) : env.ctx.cwd;
    if (!existsSync(cwd)) {
      throw new Error(`${where}: cwd does not exist: '${cwd}'.`);
    }

    const workspace: Workspace = task.workspace ?? "shared";
    const reserves =
      (workspace === "shared" && isWriter(tools)) || workspace === "isolated";

    return {
      index,
      id: task.id ?? `task-${index + 1}`,
      prompt: task.prompt ?? "",
      agent: task.agent ?? "inline",
      cwd: canonicalPath(cwd),
      model,
      thinking: task.thinking ?? profile?.thinking ?? env.ctx.thinkingLevel,
      tools,
      systemPrompt: task.systemPrompt ?? profile?.systemPrompt,
      context: task.context ?? "fresh",
      sessionId: task.sessionId,
      resumeFrom: task.resumeFrom,
      deadlineMs: task.deadlineMs,
      workspace,
      writeRoot: reserves ? writeRootOf(cwd) : undefined,
    } satisfies ResolvedTask;
  });
}

/**
 * Create a subagent session for one resolved task. Subagents are headless
 * workers: no extensions, no user-global context files, in-memory transcript.
 * The session streams through the parent session's model runtime so provider
 * registrations and auth are inherited.
 */
export async function createSubagentSession(
  task: ResolvedTask,
  env: HostEnvironment,
  resourceLoader: DefaultResourceLoader,
): Promise<AgentSession> {
  const sessionManager = task.resumeFrom
    ? SessionManager.open(task.resumeFrom)
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
