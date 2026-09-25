/**
 * Whole-task retry classification, kept separate from generic failure
 * handling. Two questions are answered independently:
 *
 * - isModelAttributableError: the failure belongs to the resolved
 *   model/account (quota, billing, auth) or a timed provider window. An
 *   immediate same-model retry will not help; do not guess a reset time.
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

/** A reset hint is advisory provider text, not a clock we control. */
function hasResetWindow(error: string): boolean {
  return /\b(?:retry.after|reset(?:s|ting)?\s+(?:in|at)|try again (?:in|after)|wait\s+\d+\s*(?:s|sec|seconds?|m|min|minutes?|h|hours?))\b/i.test(error);
}

export function limitHint(error: string): string | undefined {
  if (/\b(?:401|403|unauthorized|unauthenticated|authentication|invalid api key|invalid oauth token|billing|insufficient (?:funds|credit))\b/i.test(error)) {
    return "Account or authentication problem; check the provider account or user-side delegate.json configuration. Delegate will not automatically resume this task.";
  }
  if (/\b(?:usage limit|quota|rate.?limit|too many requests|429)\b/i.test(error)) {
    if (hasResetWindow(error)) {
      return "Provider limit with a reported reset window; the provider's hint is above. No immediate retry or automatic resume is scheduled.";
    }
    if (/\b(?:usage limit|quota)\b/i.test(error)) {
      return "Provider usage/quota limit; check when the account's limit resets or whether it needs attention. No automatic resume is scheduled.";
    }
    return "Temporary provider rate limit; a short retry may have been attempted before side effects. No automatic resume is scheduled.";
  }
  return undefined;
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
  if (isModelAttributableError(error) || hasResetWindow(error)) return false;
  return (
    TRANSIENT.some((pattern) => e.includes(pattern)) ||
    /\b429\b/.test(e) ||
    /\b5\d\d\b/.test(e)
  );
}

export const MODEL_SWAP_HINT =
  "This looks like a model/account failure rather than a transient error; no same-model retry applies. The model comes from delegate.json (or the parent session) — the user may need to reconfigure it.";

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
