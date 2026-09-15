import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { knownAgentNames } from "./profiles.ts";

export interface ConcurrencyConfig {
  /** Per-model-key bound when no more specific entry applies. */
  readonly default: number | undefined;
  /** Provider id → bound (e.g. "anthropic": 2). */
  readonly providers: Readonly<Record<string, number>>;
  /** "provider/model-id" → bound; wins over providers and default. */
  readonly models: Readonly<Record<string, number>>;
}

export interface DelegateConfig {
  /** Global bound on simultaneously executing tasks. */
  readonly maxConcurrent: number;
  readonly concurrency: ConcurrencyConfig;
  /**
   * Per-agent model assignment: named agent (scout, coder, ...) → model
   * reference. There is deliberately no "default" entry: inline tasks and
   * the `default` profile always mirror the parent's model. Callers never
   * select models; entries here are the only override, user-authored.
   */
  readonly models: Readonly<Record<string, string>>;
  /**
   * Inactivity watchdog: a task whose session emits no events for this long
   * is cooperatively aborted as stalled. 0 disables it.
   */
  readonly stallTimeoutMs: number;
}

export const DEFAULT_CONFIG: DelegateConfig = {
  maxConcurrent: 3,
  concurrency: { default: undefined, providers: {}, models: {} },
  models: {},
  stallTimeoutMs: 15 * 60 * 1000,
};

/**
 * Model reference for one task: the named agent's configured entry, or
 * undefined (= the parent's model). Inline tasks and the `default` profile
 * never get an entry — mirroring the parent is the invariant, not a
 * configurable.
 */
export function configuredModelFor(
  agent: string | undefined,
  config: DelegateConfig,
): string | undefined {
  if (agent === undefined || agent === "default") return undefined;
  return config.models[agent];
};

/** Effective per-model bound: model key, then provider, then default, then global. */
export function modelConcurrencyLimit(
  modelKey: string,
  config: DelegateConfig,
): number {
  const perModel = config.concurrency.models[modelKey];
  if (perModel !== undefined) return perModel;
  const provider = modelKey.split("/")[0] ?? modelKey;
  const perProvider = config.concurrency.providers[provider];
  if (perProvider !== undefined) return perProvider;
  return config.concurrency.default ?? config.maxConcurrent;
}

const CONFIG_FILE = "delegate.json";

/** Where a resolved agent directory came from. */
export type AgentDirSource = "env" | "session" | "cwd";

export interface AgentDirResolution {
  readonly dir: string;
  readonly source: AgentDirSource;
}

const AGENT_DIR_ENV_VAR = "DELEGATE_AGENT_DIR";

/**
 * Resolve the user-global agent directory, with provenance, from three
 * sources in order:
 *
 * 1. `DELEGATE_AGENT_DIR` — explicit operator intent; never warned about.
 * 2. The session-store layout (`<agentDir>/sessions/<cwd-slug>`), which is
 *    how the Pi CLI lays sessions out.
 * 3. `ctx.cwd` — the fallback for embedded hosts running in-memory
 *    sessions, which have no session dir.
 *
 * Pi 0.84.2 does not expose `agentDir` on `ExtensionContext` (tracked
 * upstream as earendil-works/pi#4807). The cwd fallback is warned about
 * once at dispatch (see the extension in `delegate.ts`) rather than thrown,
 * because embedded hosts — including our test harness — legitimately run
 * without a session dir and would otherwise be unusable. When `ctx.agentDir`
 * lands upstream, delete the inference and the fallback and read it
 * directly.
 */
export function resolveAgentDir(ctx: ExtensionContext): AgentDirResolution {
  const fromEnv = process.env[AGENT_DIR_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { dir: fromEnv.trim(), source: "env" };
  }
  const sessionDir = ctx.sessionManager.getSessionDir();
  if (sessionDir && basename(dirname(sessionDir)) === "sessions") {
    return { dir: dirname(dirname(sessionDir)), source: "session" };
  }
  return { dir: ctx.cwd, source: "cwd" };
}

/** The resolved agent directory (see `resolveAgentDir` for provenance). */
export function agentDirOf(ctx: ExtensionContext): string {
  return resolveAgentDir(ctx).dir;
}

export function configPathOf(ctx: ExtensionContext): string {
  return join(agentDirOf(ctx), CONFIG_FILE);
}

/**
 * Load `<agentDir>/delegate.json`. A missing file yields defaults; malformed
 * JSON, a non-positive `maxConcurrent`, or a negative `stallTimeoutMs` fails
 * loudly — a half-applied limit is worse than an error.
 */
export function loadDelegateConfig(ctx: ExtensionContext): DelegateConfig {
  const path = configPathOf(ctx);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object.`);
  }
  const config = raw as Record<string, unknown>;
  const maxConcurrent = config.maxConcurrent;
  if (
    maxConcurrent !== undefined &&
    (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) <= 0)
  ) {
    throw new Error(
      `${path}: maxConcurrent must be a positive integer; got ${JSON.stringify(maxConcurrent)}.`,
    );
  }
  const stallTimeoutMs = config.stallTimeoutMs;
  if (
    stallTimeoutMs !== undefined &&
    (!Number.isInteger(stallTimeoutMs) || (stallTimeoutMs as number) < 0)
  ) {
    throw new Error(
      `${path}: stallTimeoutMs must be a non-negative integer; got ${JSON.stringify(stallTimeoutMs)}.`,
    );
  }
  return {
    maxConcurrent: (maxConcurrent as number) ?? DEFAULT_CONFIG.maxConcurrent,
    concurrency: parseConcurrency(config.concurrency, path),
    models: parseModels(config.models, path),
    stallTimeoutMs:
      (stallTimeoutMs as number) ?? DEFAULT_CONFIG.stallTimeoutMs,
  };
}

/**
 * Parse the `models` map: named agent → model reference. Keys must name a
 * known non-default agent (a typo fails at load instead of silently never
 * matching); a "default" key is rejected explicitly — inline/default tasks
 * inherit the parent's model, full stop. Values must be non-empty strings,
 * stored trimmed. A malformed entry fails loudly — a silently dropped
 * assignment would surface later as a confusing per-task failure.
 */
function parseModels(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${path}: models must be an object mapping a named agent to a model reference.`,
    );
  }
  const known = knownAgentNames().filter((name) => name !== "default");
  const out: Record<string, string> = {};
  for (const [agent, entry] of Object.entries(value as Record<string, unknown>)) {
    if (agent === "default") {
      throw new Error(
        `${path}: models.default is rejected — inline/default tasks always run on the parent's model. ` +
          `Configure named agents only: ${known.join(", ")}.`,
      );
    }
    if (!known.includes(agent)) {
      throw new Error(
        `${path}: models key '${agent}' is not a known agent; known agents: ${known.join(", ")}.`,
      );
    }
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(
        `${path}: models.${agent} must be a non-empty model reference; got ${JSON.stringify(entry)}.`,
      );
    }
    out[agent] = entry.trim();
  }
  return out;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Parse the optional `concurrency` block: `{ default?, providers?, models? }`
 * with positive-integer bounds. Malformed shapes fail loudly — a silently
 * ignored limit is worse than an error.
 */
function parseConcurrency(value: unknown, path: string): ConcurrencyConfig {
  if (value === undefined) return DEFAULT_CONFIG.concurrency;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: concurrency must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const bound = (name: string, v: unknown): number => {
    if (!isPositiveInteger(v)) {
      throw new Error(
        `${path}: concurrency.${name} must be a positive integer; got ${JSON.stringify(v)}.`,
      );
    }
    return v;
  };
  const table = (name: string, v: unknown): Record<string, number> => {
    if (v === undefined) return {};
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new Error(`${path}: concurrency.${name} must be an object.`);
    }
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([key, entry]) => [
        key,
        bound(`${name}.${key}`, entry),
      ]),
    );
  };
  return {
    default:
      raw.default === undefined
        ? undefined
        : bound("default", raw.default),
    providers: table("providers", raw.providers),
    models: table("models", raw.models),
  };
}
