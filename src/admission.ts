import { sep } from "node:path";
import type { ResolvedTask } from "./types.ts";

/** True when canonical root `a` equals, contains, or is contained in `b`. */
export function rootsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * Environment redirects that would make a child `bash` invocation see a
 * different repository than the one admission reserved. The probe in
 * `writeRootsOf` scrubs them, but the child's shell still inherits them, so
 * a bash-capable multi-writer batch cannot be verified safely while they
 * are set.
 */
const GIT_REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"] as const;

interface Reservation {
  readonly root: string;
  readonly owner: string;
  readonly kind: "shared" | "isolated";
  readonly taskIndex: number;
}

export interface AdmissionGrant {
  /**
   * Task index → task index of the predecessor it must wait for. Same-call
   * overlapping shared writers serialize in task order.
   */
  readonly predecessors: ReadonlyMap<number, number>;
  /**
   * Groups of same-call shared writers that serialize, in task order, with
   * the write roots they overlap on — the evidence for advisory notices.
   */
  readonly serialized: readonly {
    tasks: readonly number[];
    roots: readonly string[];
  }[];
  /**
   * Release every reservation taken by this call. Task indexes in `retain`
   * keep their reservations and busy-session marks: those tasks could not
   * be confirmed quiescent, so their roots stay protected until
   * `releaseRetained` observes confirmed quiescence — or for the life of
   * the process if it never comes.
   */
  readonly release: (retain?: ReadonlySet<number>) => void;
  /**
   * Release the reservations retained for one task. Only meaningful after
   * that task's worker has been confirmed quiescent; calling it earlier
   * would un-protect roots that may still be mutating.
   */
  readonly releaseRetained: (taskIndex: number) => void;
}

/**
 * The admission boundary for dispatch. All conflict decisions live here:
 * same-call mixed-workspace overlap, cross-call writer/session conflicts.
 * Reservations are held for the life of a call or ticket — including while
 * cancellation winds down — so conflicting work rejects deterministically
 * instead of partially starting.
 */
export class AdmissionController {
  private readonly reservations: Reservation[] = [];
  private readonly busySessions = new Map<string, { owner: string; taskIndex: number }>();

  /**
   * Check then reserve. Throws an actionable error on any conflict; on
   * success the caller owns the reservations until `release()`.
   */
  admit(tasks: readonly ResolvedTask[], owner: string): AdmissionGrant {
    const reserving = tasks.filter((task) => task.writeRoots !== undefined);

    // Inherited Git redirects: a scrubbed probe can still name the real
    // repository root, but a child bash tool would run under the redirect —
    // and the isolated machinery itself drives Git, so it needs the same
    // protection. Multi-writer batches fail closed rather than trust a
    // narrowed scope.
    const redirects = GIT_REDIRECTS.filter(
      (name) => process.env[name] !== undefined,
    );
    if (
      reserving.length >= 2 &&
      redirects.length > 0 &&
      reserving.some((task) => task.tools.includes("bash"))
    ) {
      throw new Error(
        `Could not safely verify a bash-capable multi-writer batch while ${redirects.join(", ")} redirects Git repository context.`,
      );
    }

    // Within-call: group reserving tasks by root overlap (connected
    // components, union-find). Mixed shared/isolated groups reject.
    const parent = reserving.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    const overlaps = (
      a: readonly string[],
      b: readonly string[],
    ): boolean => a.some((ra) => b.some((rb) => rootsOverlap(ra, rb)));
    for (let i = 0; i < reserving.length; i++) {
      for (let j = i + 1; j < reserving.length; j++) {
        if (overlaps(reserving[i]!.writeRoots!, reserving[j]!.writeRoots!)) {
          parent[find(i)] = find(j);
        }
      }
    }
    const groups = new Map<number, typeof reserving>();
    reserving.forEach((task, i) => {
      const root = find(i);
      groups.set(root, [...(groups.get(root) ?? []), task]);
    });

    const predecessors = new Map<number, number>();
    const serialized: { tasks: readonly number[]; roots: readonly string[] }[] =
      [];
    for (const group of groups.values()) {
      const kinds = new Set(group.map((task) => task.workspace));
      if (kinds.size > 1) {
        const roots = [
          ...new Set(group.flatMap((task) => task.writeRoots!)),
        ].join(", ");
        throw new Error(
          `Conflicting workspaces: shared and isolated tasks in one call overlap at ${roots}. Split them into separate calls.`,
        );
      }
      // Same-call shared writers serialize in task order.
      if (group[0]!.workspace === "shared" && group.length > 1) {
        for (let i = 1; i < group.length; i++) {
          predecessors.set(group[i]!.index, group[i - 1]!.index);
        }
        serialized.push({
          tasks: group.map((task) => task.index),
          roots: [...new Set(group.flatMap((task) => task.writeRoots!))],
        });
      }
    }

    // Cross-call: no reserving task may overlap another owner's reservation.
    for (const task of reserving) {
      for (const reservation of this.reservations) {
        if (task.writeRoots!.some((root) => rootsOverlap(root, reservation.root))) {
          throw new Error(
            `Task ${task.id} conflicts with ${reservation.kind === "isolated" ? "an isolated" : "a shared"} write already running in ${reservation.root} (owner: ${reservation.owner}). Wait for it to finish or use a different cwd.`,
          );
        }
      }
    }

    // Sessions: a sessionId in use by a live call or ticket is busy.
    for (const task of tasks) {
      if (task.sessionId === undefined) continue;
      const holder = this.busySessions.get(task.sessionId);
      if (holder !== undefined && holder.owner !== owner) {
        throw new Error(
          `Session '${task.sessionId}' is busy running work for ${holder.owner}; wait for it to finish or close the session first.`,
        );
      }
    }

    // Reserve.
    const taken: Reservation[] = reserving.flatMap((task) =>
      task.writeRoots!.map((root) => ({
        root,
        owner,
        kind: task.workspace === "isolated" ? ("isolated" as const) : ("shared" as const),
        taskIndex: task.index,
      })),
    );
    this.reservations.push(...taken);
    const heldSessions = tasks
      .filter((task) => task.sessionId !== undefined)
      .map((task) => ({ sessionId: task.sessionId!, taskIndex: task.index }));
    for (const held of heldSessions) {
      this.busySessions.set(held.sessionId, {
        owner,
        taskIndex: held.taskIndex,
      });
    }

    let released = false;
    const allIndexes = new Set(tasks.map((task) => task.index));
    const releaseIndexes = (indexes: ReadonlySet<number>): void => {
      for (const reservation of taken) {
        if (!indexes.has(reservation.taskIndex)) continue;
        const index = this.reservations.indexOf(reservation);
        if (index >= 0) this.reservations.splice(index, 1);
      }
      for (const held of heldSessions) {
        if (!indexes.has(held.taskIndex)) continue;
        const current = this.busySessions.get(held.sessionId);
        if (current?.owner === owner) {
          this.busySessions.delete(held.sessionId);
        }
      }
    };
    return {
      predecessors,
      serialized,
      release: (retain?: ReadonlySet<number>) => {
        if (released) return;
        released = true;
        releaseIndexes(
          retain === undefined
            ? allIndexes
            : new Set([...allIndexes].filter((index) => !retain.has(index))),
        );
      },
      releaseRetained: (taskIndex: number) => {
        releaseIndexes(new Set([taskIndex]));
      },
    };
  }
}
