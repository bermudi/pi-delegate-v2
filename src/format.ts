import type { TaskOutcome } from "./types.ts";

function statusWord(outcome: TaskOutcome): string {
  return outcome.status === "ok" ? "completed" : outcome.status;
}

/** Synchronous dispatch result body: one section per task, in input order. */
export function formatDispatchResult(outcomes: readonly TaskOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const head = `### Task ${outcome.id} — ${statusWord(outcome)}`;
      if (outcome.status === "ok") {
        return `${head}\n${outcome.output ?? ""}`;
      }
      const detail = outcome.error ?? "no output";
      const partial = outcome.output ? `\n\nPartial output:\n${outcome.output}` : "";
      return `${head}\n${detail}${partial}`;
    })
    .join("\n\n");
}
