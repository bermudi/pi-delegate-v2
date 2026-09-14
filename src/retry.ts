/**
 * Whole-task retry classification, kept separate from generic failure
 * handling. Two questions are answered independently:
 *
 * - isModelAttributableError: the failure belongs to the resolved
 *   model/account (quota, billing, auth). Same-model retry is pointless; the
 *   caller gets a different-model hint instead.
 * - isClearlyTransientError: the failure looks like a transient transport or
 *   provider blip worth one whole-task retry.
 */

const MODEL_ATTRIBUTABLE = [
  "usage limit",
  "upgrade for higher limits",
  "quota",
  "exceeded your",
  "insufficient credit",
  "insufficient quota",
  "insufficient funds",
  "billing",
  "unauthorized",
  "unauthenticated",
  "authentication",
  "invalid api key",
];

export function isModelAttributableError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  if (e.includes("abort")) return false;
  return (
    MODEL_ATTRIBUTABLE.some((pattern) => e.includes(pattern)) ||
    (e.includes("api key") && e.includes("invalid")) ||
    (e.includes("oauth token") && e.includes("invalid")) ||
    /\b401\b/.test(e) ||
    /\b403\b/.test(e)
  );
}

const TRANSIENT = [
  "temporarily overloaded",
  "temporarily unavailable",
  "overloaded",
  "rate limit",
  "too many requests",
  "timeout",
  "timed out",
  "connection reset",
  "econnreset",
  "connection refused",
  "network error",
];

export function isClearlyTransientError(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  if (e.includes("abort")) return false;
  if (isModelAttributableError(error)) return false;
  return (
    TRANSIENT.some((pattern) => e.includes(pattern)) ||
    /\b429\b/.test(e) ||
    /\b5\d\d\b/.test(e)
  );
}

export const MODEL_SWAP_HINT =
  "This looks like a model/account failure rather than a transient error; retry the task with a different 'model' — one of the alternatives configured in delegate.json.";

export const MAX_TASK_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 150;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
