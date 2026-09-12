import { sep } from "node:path";
import type { ResolvedTask } from "./types.ts";

/** True when canonical root `a` equals, contains, or is contained in `b`. */
export function rootsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b + sep) || b.startsWith(a + sep);
}

interface Reservation {
  readonly root: string;
  readonly owner: string;
  readonly kind: "shared" | "isolated";
}

export interface AdmissionGrant {
  /**
   * Task index → task index of the predecessor it must wait for. Same-call
   * overlapping shared writers serialize in task order.
   */
  readonly predecessors: ReadonlyMap<number, number>;
  /** Release every reservation taken by this call. */
  readonly release: () => void;
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
  private readonly busySessions = new Map<string, string>();

  /**
   * Check then reserve. Throws an actionable error on any conflict; on
   * success the caller owns the reservations until `release()`.
   */
  admit(tasks: readonly ResolvedTask[], owner: string): AdmissionGrant {
    const reserving = tasks.filter((task) => task.writeRoot !== undefined);

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
    for (let i = 0; i < reserving.length; i++) {
      for (let j = i + 1; j < reserving.length; j++) {
        if (rootsOverlap(reserving[i]!.writeRoot!, reserving[j]!.writeRoot!)) {
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
    for (const group of groups.values()) {
      const kinds = new Set(group.map((task) => task.workspace));
      if (kinds.size > 1) {
        const roots = [...new Set(group.map((task) => task.writeRoot))].join(
          ", ",
        );
        throw new Error(
          `Conflicting workspaces: shared and isolated tasks in one call overlap at ${roots}. Split them into separate calls.`,
        );
      }
      // Same-call shared writers serialize in task order.
      if (group[0]!.workspace === "shared" && group.length > 1) {
        for (let i = 1; i < group.length; i++) {
          predecessors.set(group[i]!.index, group[i - 1]!.index);
        }
      }
    }

    // Cross-call: no reserving task may overlap another owner's reservation.
    for (const task of reserving) {
      for (const reservation of this.reservations) {
        if (rootsOverlap(task.writeRoot!, reservation.root)) {
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
      if (holder !== undefined && holder !== owner) {
        throw new Error(
          `Session '${task.sessionId}' is busy running work for ${holder}; wait for it to finish or close the session first.`,
        );
      }
    }

    // Reserve.
    const taken: Reservation[] = reserving.map((task) => ({
      root: task.writeRoot!,
      owner,
      kind: task.workspace === "isolated" ? ("isolated" as const) : ("shared" as const),
    }));
    this.reservations.push(...taken);
    const heldSessions = tasks
      .filter((task) => task.sessionId !== undefined)
      .map((task) => task.sessionId!);
    for (const sessionId of heldSessions) {
      this.busySessions.set(sessionId, owner);
    }

    let released = false;
    return {
      predecessors,
      release: () => {
        if (released) return;
        released = true;
        for (const reservation of taken) {
          const index = this.reservations.indexOf(reservation);
          if (index >= 0) this.reservations.splice(index, 1);
        }
        for (const sessionId of heldSessions) {
          if (this.busySessions.get(sessionId) === owner) {
            this.busySessions.delete(sessionId);
          }
        }
      },
    };
  }
}
