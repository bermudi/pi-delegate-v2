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
   * Per-agent model assignment: agent name (or "default" for every task
   * without a more specific entry — inline tasks included) → model
   * reference. Callers never select models; entries here and the parent's
   * model are the only sources.
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
 * Model reference for one task: the agent's configured entry, else the
 * "default" entry, else undefined (= the parent's model). Config is the
 * only source of overrides — tasks carry no model field.
 */
export function configuredModelFor(
  agent: string,
  config: DelegateConfig,
): string | undefined {
  return config.models[agent] ?? config.models.default;
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

/**
 * The user-global config directory for the running session. Pi does not expose
 * `agentDir` on the extension context, so derive it from the session store
 * location (`<agentDir>/sessions/<cwd-slug>`). In-memory sessions (tests) have
 * no session dir; there the harness's agentDir is the session cwd.
 */
export function agentDirOf(ctx: ExtensionContext): string {
  const sessionDir = ctx.sessionManager.getSessionDir();
  if (sessionDir && basename(dirname(sessionDir)) === "sessions") {
    return dirname(dirname(sessionDir));
  }
  return ctx.cwd;
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
 * Parse the `models` map: agent name (or "default") → model reference.
 * Keys must name a known agent (or "default") so a typo fails at load
 * instead of silently never matching; values must be non-empty strings,
 * stored trimmed. A malformed entry fails loudly — a silently dropped
 * assignment would surface later as a confusing per-task failure.
 */
function parseModels(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${path}: models must be an object mapping agent name (or "default") to a model reference.`,
    );
  }
  const known = new Set(["default", ...knownAgentNames()]);
  const out: Record<string, string> = {};
  for (const [agent, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(agent)) {
      throw new Error(
        `${path}: models key '${agent}' is not a known agent; known agents: ${[...known].join(", ")}.`,
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
