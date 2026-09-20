import { join } from "node:path";
import { DELEGATE_TREES } from "./fsx.ts";
import { prepareIsolated, type IsolatedPlan } from "./isolated.ts";
import { prepareScratch } from "./scratch.ts";
import type { ResolvedTask, TaskOutcome } from "./types.ts";

/**
 * Dispatch-level facts a finalize stage may consult, assembled by the
 * pipeline from what the batch actually has — the batch's signal, whether
 * source application may still proceed, and why retained artifacts were
 * kept. Deliberately mode-neutral: plans consume what applies to them, so a
 * workspace mode that needs different finalize facts extends this only with
 * genuinely dispatch-level fields (see also the deferred workspace policy
 * object in issue #2).
 */
export interface FinalizeContext {
  /** The batch's cancellation signal; consulted around source applies. */
  readonly signal?: AbortSignal;
  /** Whether worker output may still be applied to source trees. */
  readonly shouldApplySource: () => boolean;
  /** Caller-facing explanation when application is refused and artifacts retained. */
  readonly retainedReason?: string;
}

/**
 * The one workspace plan per call. Routes every task by its `workspace` and
 * owns the batch's whole workspace lifecycle — the prepared task list,
 * finalize, retained-worker cleanup, and disposal. Callers never see (and
 * so never hand-chain) the per-mode sub-plans; those stay internal to
 * `prepareWorkspaces`.
 */
export interface WorkspacePlan {
  /** The task list with each scratch/isolated task's cwd remapped into its copy/worktree. */
  readonly tasks: readonly ResolvedTask[];
  /**
   * Finalize every workspace in the batch: isolated reconciliation first —
   * it applies worker output into source trees and must complete inside
   * the admission-reservation window — then scratch discards the copies
   * of confirmed-quiescent workers. Both run for any batch containing
   * their mode's tasks. Sub-plans consume the context they need: only
   * isolated reconciliation reads it; scratch finalization consults the
   * outcomes alone.
   */
  finalize(
    outcomes: TaskOutcome[],
    context: FinalizeContext,
  ): Promise<readonly TaskOutcome[]>;
  /** Discard a retained scratch copy / worktree once quiescence is confirmed. */
  cleanupWorker(taskIndex: number): Promise<void>;
  /** Preparation succeeded but a later stage failed before anything ran. */
  dispose(): Promise<void>;
}

export function workspaceNeedsSettlementHold(
  tasks: readonly ResolvedTask[],
): boolean {
  return tasks.some((task) => task.workspace === "isolated");
}

export async function prepareWorkspaces(
  tasks: readonly ResolvedTask[],
  agentDir: string,
  signal?: AbortSignal,
  excludedPaths: readonly string[] = [],
): Promise<WorkspacePlan> {
  // Scratch before isolated: file copies are cheaper than Git setup, and
  // a later preparation failure can dispose() them. Each stage refines the
  // task list in place — isolated receives scratch's remapped cwds and its
  // own translation layers on top.
  let prepared = tasks;
  const scratchPlan = await prepareScratch(
    tasks,
    join(agentDir, DELEGATE_TREES.scratch),
    signal,
  );
  if (scratchPlan) prepared = scratchPlan.tasks;
  let isolatedPlan: IsolatedPlan | undefined;
  try {
    isolatedPlan = await prepareIsolated(
      prepared,
      join(agentDir, DELEGATE_TREES.isolated),
      signal,
      excludedPaths,
    );
    if (isolatedPlan) prepared = isolatedPlan.tasks;
  } catch (error) {
    try {
      await scratchPlan?.dispose();
    } catch (cleanupError) {
      console.error(
        `[delegate] scratch disposal after isolated preparation failure failed (root cause preserved): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        cleanupError,
      );
    }
    throw error;
  }

  return {
    tasks: prepared,
    finalize: async (outcomes, context) => {
      // The one adaptation site between dispatch-level facts and the
      // isolated sub-plan's reconcile options: field-picked explicitly, so
      // a context field can never leak into reconcile unnoticed, and a new
      // required reconcile option surfaces here at compile time.
      if (isolatedPlan) {
        await isolatedPlan.reconcile(outcomes, {
          shouldApplySource: context.shouldApplySource,
          retainedReason: context.retainedReason,
          signal: context.signal,
        });
      }
      if (scratchPlan) await scratchPlan.finalize(outcomes);
      return outcomes;
    },
    cleanupWorker: async (taskIndex) => {
      // A task has exactly one workspace; its own routing decision alone
      // decides which sub-plan holds its retained artifacts.
      const task = tasks[taskIndex];
      if (task?.workspace === "isolated") {
        await isolatedPlan?.cleanupWorker(taskIndex);
      } else if (task?.workspace === "scratch") {
        await scratchPlan?.cleanupWorker(taskIndex);
      }
    },
    dispose: async () => {
      // A disposal failure must never erase the other plan's failure:
      // collect both, log them, and throw the first so the root cause
      // survives with its sibling visible.
      const settled = await Promise.allSettled([
        isolatedPlan?.dispose(),
        scratchPlan?.dispose(),
      ]);
      const failures = settled.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      for (const failure of failures) {
        console.error(
          `[delegate] workspace dispose failed: ${failure instanceof Error ? failure.message : String(failure)}`,
          failure,
        );
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}
