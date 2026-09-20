import { join } from "node:path";
import {
  prepareIsolated,
  type IsolatedPlan,
  type IsolatedReconcileOptions,
} from "./isolated.ts";
import { prepareScratch } from "./scratch.ts";
import type { ResolvedTask, TaskOutcome } from "./types.ts";

export interface WorkspacePlan {
  readonly tasks: readonly ResolvedTask[];
  finalize(
    outcomes: TaskOutcome[],
    options: IsolatedReconcileOptions,
  ): Promise<readonly TaskOutcome[]>;
  cleanupWorker(taskIndex: number): Promise<void>;
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
  // Scratch before isolated: file copies are cheaper than Git
  // setup, and a later preparation failure can dispose() them.
  const scratchPlan = await prepareScratch(
    tasks,
    join(agentDir, "delegate-scratch"),
    signal,
  );
  let isolatedPlan: IsolatedPlan | undefined;
  try {
    isolatedPlan = await prepareIsolated(
      scratchPlan?.tasks ?? tasks,
      join(agentDir, "delegate-isolated"),
      signal,
      excludedPaths,
    );
  } catch (error) {
    await scratchPlan?.dispose();
    throw error;
  }

  return {
    tasks: isolatedPlan?.tasks ?? scratchPlan?.tasks ?? tasks,
    finalize: async (outcomes, options) => {
      if (isolatedPlan) await isolatedPlan.reconcile(outcomes, options);
      if (scratchPlan) await scratchPlan.finalize(outcomes);
      return outcomes;
    },
    cleanupWorker: async (taskIndex) => {
      const task = tasks[taskIndex];
      if (task?.workspace === "isolated") {
        await isolatedPlan?.cleanupWorker(taskIndex);
      } else if (task?.workspace === "scratch") {
        await scratchPlan?.cleanupWorker(taskIndex);
      }
    },
    dispose: async () => {
      await Promise.all([isolatedPlan?.dispose(), scratchPlan?.dispose()]);
    },
  };
}
