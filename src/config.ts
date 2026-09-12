import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface DelegateConfig {
  /** Global bound on simultaneously executing tasks. */
  readonly maxConcurrent: number;
}

export const DEFAULT_CONFIG: DelegateConfig = {
  maxConcurrent: 3,
};

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
 * JSON or a non-positive `maxConcurrent` fails loudly — a half-applied
 * concurrency limit is worse than an error.
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
  return { maxConcurrent: (maxConcurrent as number) ?? DEFAULT_CONFIG.maxConcurrent };
}
