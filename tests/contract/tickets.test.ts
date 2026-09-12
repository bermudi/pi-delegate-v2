import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/** A scripted subagent stream that blocks until `release` is invoked. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage("OUTPUT-RELEASED");
  };
  return { release, step };
}

describe("delegate ticket contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("poll with no tickets reports an empty roster", async () => {
    // v1 evidence: delegate.test.ts "poll with no tickets returns empty
    // message" and "includes a discovery hint".
    session = await openDelegateBoundary();
    const result = await callDelegate(session, { ticketAction: "poll" });
    expect(result.isError).toBe(false);
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.text).toMatch(/no|none|empty/i);
  });

  test(
    "poll, wait, cancel, pause, and resume report unknown tickets as not found",
    async () => {
      // v1 evidence: delegate.test.ts "poll with unknown ticket returns not
      // found", "wait on unknown ticket returns not found"; tickets.ts
      // `Ticket '<id>' not found.`
      session = await openDelegateBoundary();
      for (const arguments_ of [
        { ticketAction: "poll", ticket: "nope-1" },
        { ticketAction: "wait", ticket: "nope-1", timeoutMs: 50 },
        { ticketAction: "cancel", ticket: "nope-1", force: true },
        { ticketAction: "pause", ticket: "nope-1" },
        { ticketAction: "resume", ticket: "nope-1" },
      ]) {
        const result = await callDelegate(session, arguments_);
        expect(result.isError).toBe(false);
        expect(result.text).toMatch(/nope-1/);
        expect(result.text).toMatch(/not found/i);
      }
    },
  );

  test(
    "wait returns the settled result and the ticket stays pollable",
    async () => {
      // v1 evidence: delegate.test.ts "wait resolves when ticket completes",
      // "wait resolves with terminal result"; SPEC: tickets remain pollable
      // after settlement.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg", model: subagents.spec }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const waiting = callDelegate(session, {
        ticketAction: "wait",
        ticket,
        timeoutMs: 5000,
      });
      release();
      const waited = await waiting;
      expect(waited.isError).toBe(false);
      expect(waited.text).toContain("OUTPUT-RELEASED");
      expect(waited.text).toMatch(/done|complet/i);

      const polled = await callDelegate(session, {
        ticketAction: "poll",
        ticket,
      });
      expect(polled.isError).toBe(false);
      expect(polled.text).toContain("OUTPUT-RELEASED");
    },
  );

  test(
    "a wait timeout detaches the waiter without cancelling background work",
    async () => {
      // v1 evidence: delegate.test.ts "wait timeout returns running status and
      // does not cancel ticket"; INVARIANTS: wait timeout or caller abort
      // detaches only that waiter.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg", model: subagents.spec }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const timedOut = await callDelegate(session, {
        ticketAction: "wait",
        ticket,
        timeoutMs: 30,
      });
      expect(timedOut.isError).toBe(false);
      expect(timedOut.text).toMatch(/running|timeout|pending/i);

      // The ticket is still alive and finishes once the work unblocks.
      release();
      const settled = await callDelegate(session, {
        ticketAction: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toContain("OUTPUT-RELEASED");
    },
  );

  test(
    "cancel without force previews and leaves the ticket running",
    async () => {
      // v1 evidence: delegate.test.ts "cancel without force returns a
      // non-destructive preview". SPEC: cancel previews unless force:true.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg", model: subagents.spec }],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const preview = await callDelegate(session, {
        ticketAction: "cancel",
        ticket,
      });
      expect(preview.isError).toBe(false);
      expect(preview.text).toMatch(/cancel|force/i);

      const polled = await callDelegate(session, {
        ticketAction: "poll",
        ticket,
      });
      expect(polled.text).toMatch(/running|cancelling/i);

      release();
    },
  );

  test(
    "forced cancellation settles the ticket and retains completed results",
    async () => {
      // v1 evidence: delegate.test.ts "cancel with force aborts a running
      // ticket and transitions to cancelling", "formatCompletedTicket
      // preserves index alignment for cancelled ticket with partial results";
      // INVARIANTS: after forced cancellation begins, later worker completion
      // must not turn the ticket into a success.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([fauxAssistantMessage("OUTPUT-DONE-EARLY"), step]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { prompt: "quick", model: subagents.spec },
          { prompt: "slow", model: subagents.spec },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const cancelled = await callDelegate(session, {
        ticketAction: "cancel",
        ticket,
        force: true,
      });
      expect(cancelled.isError).toBe(false);
      expect(cancelled.text).toMatch(/cancel/i);

      // A late worker finishing must not resurrect the ticket into "done".
      release();
      const polled = await callDelegate(session, {
        ticketAction: "poll",
        ticket,
      });
      expect(polled.text).toMatch(/cancelled/i);
      expect(polled.text).toContain("OUTPUT-DONE-EARLY");
    },
  );

  test(
    "pause holds queued work, resume continues the same ticket",
    async () => {
      // v1 evidence: pause.test.ts "queued work parks without becoming active
      // and cancel unblocks it"; SPEC: pause cooperatively stops queued tasks
      // and future model turns. INVARIANTS: a paused ticket remains running.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const { release, step } = gate();
      subagents.respond([step, fauxAssistantMessage("OUTPUT-QUEUED")]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { prompt: "first", model: subagents.spec },
          { prompt: "second", model: subagents.spec },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);

      const paused = await callDelegate(session, {
        ticketAction: "pause",
        ticket,
      });
      expect(paused.isError).toBe(false);
      expect(paused.text).toMatch(/paus/i);

      // While paused the ticket is still live, not terminal.
      const polled = await callDelegate(session, {
        ticketAction: "poll",
        ticket,
      });
      expect(polled.text).toMatch(/running|paused/i);
      expect(polled.text).not.toMatch(/done|cancelled|failed/i);

      const resumed = await callDelegate(session, {
        ticketAction: "resume",
        ticket,
      });
      expect(resumed.isError).toBe(false);
      release();

      const settled = await callDelegate(session, {
        ticketAction: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(settled.text).toMatch(/done|complet/i);
    },
  );
});
