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

/**
 * Operator-visibility signals (issue #24): footer status and the settle
 * warning via the recorded mock-UI stream. v1 evidence: status.ts footer
 * formats, settle-warning wording and once-per-ticket dedupe, pause/settle
 * footer transitions. The replacement and tree-navigation guards fire on
 * host events (session_before_switch/fork/before_tree) the harness cannot
 * emit — verified by typecheck and review; the browser's TUI surface is
 * likewise not
 * boundary-testable (see TEST-MIGRATION.md "Operator-visibility signals").
 */

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

interface UiCall {
  readonly method?: string;
  readonly args?: readonly unknown[];
}

function statusTexts(session: TestSession): (string | undefined)[] {
  return session.events.ui
    .map((entry) => entry as UiCall)
    .filter(
      (entry) => entry.method === "setStatus" && entry.args?.[0] === "delegate",
    )
    .map((entry) => entry.args?.[1] as string | undefined);
}

function notifies(session: TestSession): { message: string; type?: string }[] {
  return session.events.ui
    .map((entry) => entry as UiCall)
    .filter((entry) => entry.method === "notify")
    .map((entry) => ({
      message: entry.args?.[0] as string,
      type: entry.args?.[1] as string | undefined,
    }));
}

describe("delegate visibility signals", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("sync dispatches never touch the footer", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    subagents.respond([fauxAssistantMessage("DONE")]);

    const result = await callDelegate(session, {
      tasks: [{ prompt: "quick" }],
    });
    expect(result.isError).toBe(false);
    expect(statusTexts(session).filter((t) => t !== undefined)).toHaveLength(0);
  });

  test("settle warning fires once per ticket activation", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    // Each turn settling with the ticket live must warn exactly once total.
    await callDelegate(session, { ticketAction: "poll", ticket });
    const warnings = notifies(session).filter((n) =>
      /still running/.test(n.message),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain(ticket);
    expect(warnings[0]!.type).toBe("warning");

    release();
    await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 5000 });
    expect(
      notifies(session).filter((n) => /still running/.test(n.message)),
    ).toHaveLength(1);
  });

  test("footer merges multiple tickets and survives partial settlement", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const g1 = gate();
    const g2 = gate();
    subagents.respond([g1.step, g2.step]);

    const first = await callDelegate(session, {
      tasks: [{ prompt: "one" }],
      async: true,
    });
    const t1 = ticketIdOf(first.text);
    const second = await callDelegate(session, {
      // Read-only: an inline writer in the same cwd would correctly be
      // rejected by shared-write admission against ticket one.
      tasks: [{ prompt: "two", tools: "ro" }],
      async: true,
    });
    const t2 = ticketIdOf(second.text);

    const texts = statusTexts(session);
    expect(texts.some((t) => t === `⏳ 2 subagent(s) · 2 tickets · /subagents`)).toBe(
      true,
    );

    g1.release();
    await callDelegate(session, { ticketAction: "wait", ticket: t1, timeoutMs: 5000 });
    expect(
      statusTexts(session).some((t) => t === `⏳ 1 subagent(s) · ${t2} · /subagents`),
    ).toBe(true);

    g2.release();
    await callDelegate(session, { ticketAction: "wait", ticket: t2, timeoutMs: 5000 });
    expect(statusTexts(session).at(-1)).toBeUndefined();
  });

  test("footer shows the running ticket and clears when it settles", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const texts = statusTexts(session);
    const running = texts.find((t) => t?.includes(ticket));
    expect(running).toBeDefined();
    expect(running).toMatch(/⏳ 1 subagent\(s\) · /);
    expect(running).toContain("/subagents");

    release();
    const waited = await callDelegate(session, {
      ticketAction: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(waited.isError).toBe(false);

    const after = statusTexts(session);
    expect(after[after.length - 1]).toBeUndefined();
  });

  test("footer reflects pause and resume of a live ticket", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const { release, step } = gate();
    subagents.respond([step]);

    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "bg" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);

    const paused = await callDelegate(session, {
      ticketAction: "pause",
      ticket,
    });
    expect(paused.isError).toBe(false);
    const texts = statusTexts(session);
    expect(
      texts.some((t) => t?.includes("Ⅱ") && t.includes(ticket) && t.includes("paused")),
    ).toBe(true);

    const resumed = await callDelegate(session, {
      ticketAction: "resume",
      ticket,
    });
    expect(resumed.isError).toBe(false);
    expect(
      statusTexts(session).some((t) => t === `⏳ 1 subagent(s) · ${ticket} · /subagents`),
    ).toBe(true);

    release();
    await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 5000 });
  });
});
