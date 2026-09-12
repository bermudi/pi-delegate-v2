/**
 * Cancellation/quiescence regressions (v1 evidence: cancellation.test.ts,
 * controller-races.test.ts, pause.test.ts).
 *
 * Determinism notes: `callCount` is incremented synchronously inside the faux
 * provider's streamFunction, before any yields, so `callCount === N` is a hard
 * proof that no further model turn started. Gated factories plus the
 * `maxConcurrent: 1` bound let tests place tasks at exact lifecycle points.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.js";

let session: TestSession | undefined;

afterEach(() => {
  session?.dispose();
  session = undefined;
});

function writeConcurrency(maxConcurrent: number): void {
  if (!session) throw new Error("session not open");
  writeFileSync(
    join(session.cwd, "delegate.json"),
    JSON.stringify({ maxConcurrent }),
  );
}

test(
  "a task cancelled while queued behind the concurrency bound never reaches the provider",
  async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    writeConcurrency(1);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("leader done");
    };
    subagents.respond([gated]);

    const dispatched = await callDelegate(session, {
      tasks: [0, 1].map((n) => ({
        prompt: `queued ${n}`,
        model: subagents.spec,
        tools: ["read"],
      })),
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const cancelled = await callDelegate(session, {
      ticketAction: "cancel",
      ticket,
      force: true,
    });
    expect(cancelled.text).toMatch(/cancel/i);

    // The queued task was cancelled before its turn: exactly one provider
    // call ever happened (the leader's gated stream).
    expect(subagents.state.callCount).toBe(1);

    release();
    const waited = await callDelegate(session, {
      ticketAction: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(waited.text).toMatch(/cancelled/i);
    expect(subagents.state.callCount).toBe(1);
  },
);

test(
  "a task cancelled while paused between model turns does not start another provider call",
  async () => {
    // v1 evidence: "forcing cancellation resolves paused listeners and does
    // not start another model request".
    //
    // Deterministic placement:
    //   1. Turn 1's stream is gated, so the pause lands while the turn cannot
    //      complete — the task is guaranteed paused when its turn ends.
    //   2. The tool call writes a marker file; once the marker exists the tool
    //      is finishing and the next thing the task does is park in
    //      `waitWhilePaused` between turns (a short barrier lets the microtask
    //      cascade to the park complete before cancel lands).
    //   3. Cancel resolves the park; the run must stop at the turn boundary
    //      instead of invoking the provider again with a dead signal.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    const marker = join(session.cwd, "tooldone");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const turnOne: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage([
        fauxToolCall("bash", {
          command: `printf done > "${marker}"`,
        }),
      ]);
    };
    subagents.respond([turnOne]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "park me", model: subagents.spec, tools: ["bash"] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    await callDelegate(session, { ticketAction: "pause", ticket });
    release();

    // Barrier: wait until the tool call has completed, then let the
    // post-tool cascade reach the between-turns park.
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(existsSync(marker)).toBe(true);
    await new Promise((r) => setTimeout(r, 30));

    const cancelled = await callDelegate(session, {
      ticketAction: "cancel",
      ticket,
      force: true,
    });
    expect(cancelled.text).toMatch(/cancel/i);

    const waited = await callDelegate(session, {
      ticketAction: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(waited.text).toMatch(/cancelled/i);
    expect(subagents.state.callCount).toBe(1);
  },
);

test(
  "aborting mid-stream is a cancellation, not an error, and no extra turn starts",
  async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("late output");
    };
    subagents.respond([gated]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "streaming", model: subagents.spec, tools: ["read"] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const cancelled = await callDelegate(session, {
      ticketAction: "cancel",
      ticket,
      force: true,
    });
    expect(cancelled.text).toMatch(/cancel/i);

    release();
    const waited = await callDelegate(session, {
      ticketAction: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(waited.text).toMatch(/cancelled/i);
    expect(subagents.state.callCount).toBe(1);
  },
);
