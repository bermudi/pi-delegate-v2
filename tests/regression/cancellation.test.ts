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
import type {
  TestSession,
  ToolResultRecord,
} from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  callDelegate,
  callDelegateDetached,
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

/**
 * Probe admission until a dispatch is accepted or the budget expires.
 * Rejection for a still-retained (quarantined) reservation fails inside
 * admission before any task starts, so only an admitted attempt consumes a
 * scripted provider response — making this the public-boundary witness for
 * "the abandoned worker wound down and its reservation was released".
 */
async function dispatchUntilAdmitted(
  session: TestSession,
  arguments_: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<ToolResultRecord> {
  const deadline = Date.now() + timeoutMs;
  let result = await callDelegate(session, arguments_);
  while (result.isError && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    result = await callDelegate(session, arguments_);
  }
  return result;
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
  "forced cancel settles while worker cleanup is blocked; the reservation releases only after confirmed quiescence",
  async () => {
    // v1 evidence: quiescence-barrier regressions — cancellation must be
    // caller-visible even when worker termination cannot be confirmed, and
    // quarantined resources stay reserved until safety is proven.
    //
    // The faux provider's gated factory ignores the abort signal while it
    // waits: session.abort()'s waitForIdle cannot settle until release().
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    };
    subagents.respond([gated, fauxAssistantMessage("AFTER-QUARANTINE")]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "hold", model: subagents.spec, tools: ["write"] }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    // Wait until the provider call is definitely in flight: callCount is
    // bumped synchronously inside the faux stream function.
    const deadline = Date.now() + 5000;
    while (subagents.state.callCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(1);

    const cancelled = await callDelegate(session, {
      ticketAction: "cancel",
      ticket,
      force: true,
    });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.text).toMatch(/cancel/i);

    // While the worker may still mutate, conflicting work rejects.
    const rejected = await callDelegate(session, {
      tasks: [{ prompt: "conflict", model: subagents.spec, tools: ["write"] }],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/conflict|running|overlap|active/i);

    // Confirmed quiescence: the gate releases, the provider sees the abort,
    // the run winds down, and the reservation is released — proven by the
    // same dispatch now being admitted. The intervening wait round-trip
    // drains the worker's microtask cascade before this call is admitted.
    release();
    const settled = await callDelegate(session, {
      ticketAction: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(settled.text).toMatch(/cancelled/i);
    // The late worker outcome can never turn cancellation into success.
    expect(settled.text).not.toMatch(/— (completed|ok)/i);

    const admitted = await callDelegate(session, {
      tasks: [{ prompt: "after", model: subagents.spec, tools: ["write"] }],
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("AFTER-QUARANTINE");
  },
);

test(
  "a sync call returns a structured outcome instead of hanging when the worker cannot be confirmed stopped",
  async () => {
    // v1 evidence: unwind-budget regressions — a synchronous dispatch must
    // not wait forever on unconfirmed worker termination. The task's own
    // deadline is the deterministic trigger (the harness cannot interrupt an
    // in-flight tool call); the gated factory keeps session.abort() pending.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("TOO-LATE");
    };
    subagents.respond([
      gated,
      // Spares: the admission-retry probe below only consumes a script on
      // an admitted attempt, but a mid-flight failure would too.
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage("AFTER-QUARANTINE"),
      ),
    ]);

    const result = await callDelegate(session, {
      tasks: [
        {
          prompt: "hang",
          model: subagents.spec,
          tools: ["write"],
          deadlineMs: 500,
        },
      ],
    });
    // The call returned at all: settlement did not wait for cleanup. The
    // provider call is still gated (callCount proves it was in flight), so
    // the worker's termination is genuinely unconfirmed.
    expect(result.text).toMatch(/deadline|cancel/i);
    expect(subagents.state.callCount).toBe(1);

    // The abandoned worker may still mutate: conflicting work rejects.
    const rejected = await callDelegate(session, {
      tasks: [{ prompt: "conflict", model: subagents.spec, tools: ["write"] }],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/conflict|running|overlap|active/i);

    // Releasing the gate lets the worker wind down; only then is the
    // retained reservation released. Wind-down is asynchronous and there is
    // no ticket to wait on, so probe admission until the quarantine is
    // provably gone.
    release();
    const admitted = await dispatchUntilAdmitted(session, {
      tasks: [{ prompt: "after", model: subagents.spec, tools: ["write"] }],
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("AFTER-QUARANTINE");
  },
);

test(
  "a parent abort during an in-flight sync dispatch settles as a cancellation, not a deadline or a hang",
  async () => {
    // v1 evidence: caller-abort regressions — the parent's abort reaches the
    // tool through its execute signal and must settle with the parent-abort
    // cause, which outranks deadline and stall.
    //
    // The harness's awaited run() cannot express an interruption, but it
    // exposes the raw AgentSession: fire the call detached and abort() the
    // session once the subagent's provider call is demonstrably in flight.
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage("TOO-LATE");
    };
    subagents.respond([
      gated,
      ...Array.from({ length: 4 }, () =>
        fauxAssistantMessage("AFTER-QUARANTINE"),
      ),
    ]);

    const pending = callDelegateDetached(session, {
      tasks: [
        {
          prompt: "hang",
          model: subagents.spec,
          tools: ["write"],
          deadlineMs: 60_000,
        },
      ],
    });

    const deadline = Date.now() + 5000;
    while (subagents.state.callCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(subagents.state.callCount).toBe(1);

    await (session.session as AgentSession).abort();

    const result = await pending;
    // The abort outranks the (unfired) deadline: a structured cancellation,
    // never the deadline path, and settlement did not wait on the still-
    // gated worker.
    expect(result.text).toMatch(/cancel/i);
    expect(result.text).not.toMatch(/deadline/i);
    expect(subagents.state.callCount).toBe(1);

    // The worker's termination is still unconfirmed: its scope stays
    // reserved until the gate releases and quiescence is proven.
    const rejected = await callDelegate(session, {
      tasks: [{ prompt: "conflict", model: subagents.spec, tools: ["write"] }],
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/conflict|running|overlap|active/i);

    release();
    const admitted = await dispatchUntilAdmitted(session, {
      tasks: [{ prompt: "after", model: subagents.spec, tools: ["write"] }],
    });
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("AFTER-QUARANTINE");
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
