import type { ResolvedTask, TaskIntegration, TaskOutcome } from "./types.ts";

/**
 * One advisory line per serialized shared-writer group: which tasks, which
 * write scope, and the isolated-workspace remedy. The notice exists so the
 * caller learns that independent same-repo work can run in parallel — a
 * serialized batch is the expensive way to discover that.
 */
export function serializedNotices(
  tasks: readonly ResolvedTask[],
  groups: readonly { tasks: readonly number[]; roots: readonly string[] }[],
): string[] {
  return groups.map((group) => {
    const names = group.tasks
      .map((index) => `'${tasks[index]?.id ?? `task-${index + 1}`}'`)
      .join(", ");
    const roots = group.roots.join(", ");
    return (
      `Notice — serialized writers: ${names} share write scope '${roots}' and ` +
      `will run one at a time in this order. If they are independent edits, ` +
      `workspace "isolated" runs them in parallel and merges in task order.`
    );
  });
}

function statusWord(outcome: TaskOutcome): string {
  return outcome.status === "ok" ? "completed" : outcome.status;
}

/**
 * The isolated-workspace reconciliation line(s) for one task: status, file
 * counts, recovery pointers, and the applied_unverified disclaimer. A clean
 * apply is never presented as verified or tested.
 */
export function integrationLines(integration: TaskIntegration): string[] {
  const lines = [
    `[INTEGRATION: ${integration.status} · proposed ${integration.proposedFiles.length} file(s) · applied ${integration.appliedFiles.length} file(s)]`,
  ];
  if (integration.proposedFiles.length > 0) {
    lines.push(`proposed: ${integration.proposedFiles.join(", ")}`);
  }
  if (
    integration.appliedFiles.length > 0 &&
    integration.appliedFiles.join("\0") !== integration.proposedFiles.join("\0")
  ) {
    lines.push(`applied: ${integration.appliedFiles.join(", ")}`);
  }
  if (integration.baselineRef) {
    lines.push(`baseline ref: ${integration.baselineRef}`);
  }
  if (integration.proposalRef) {
    lines.push(`proposal ref: ${integration.proposalRef}`);
  }
  if (integration.patchPath) {
    lines.push(`full patch: ${integration.patchPath}`);
  }
  if (integration.worktreePath) {
    lines.push(`recovery worktree: ${integration.worktreePath}`);
  }
  if (
    (integration.status === "retained" || integration.status === "discarded") &&
    integration.reason
  ) {
    lines.push(`not applied: ${integration.reason}`);
  }
  for (const conflict of integration.conflicts ?? []) {
    lines.push(`conflict: ${conflict.path}: ${conflict.reason}`);
  }
  if (integration.status === "applied_unverified") {
    lines.push(
      "Changes were applied but not verified; review or test them before relying on them.",
    );
  }
  return lines;
}

/** Synchronous dispatch result body: one section per task, in input order. */
export function formatDispatchResult(outcomes: readonly TaskOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const head = `### Task ${outcome.id} — ${statusWord(outcome)}`;
      const quarantined = outcome.quarantined
        ? "\nWorker termination is unconfirmed; its write scope stays reserved."
        : "";
      const integration = outcome.integration
        ? `\n${integrationLines(outcome.integration).join("\n")}`
        : "";
      if (outcome.status === "ok") {
        return `${head}\n${outcome.output ?? ""}${quarantined}${integration}`;
      }
      const detail = outcome.error ?? "no output";
      const partial = outcome.output ? `\n\nPartial output:\n${outcome.output}` : "";
      return `${head}\n${detail}${partial}${quarantined}${integration}`;
    })
    .join("\n\n");
}
