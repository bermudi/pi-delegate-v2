import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { callDelegate, installSubagentModel, openDelegateBoundary, ticketIdOf } from "../support/pi-boundary.ts";

describe("saved async ticket results (new v2 restart contract, issue #26)", () => {
  const sessions: TestSession[] = [];
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); });

  async function openAt(agentDir?: string): Promise<TestSession> {
    const session = await openDelegateBoundary();
    sessions.push(session);
    if (agentDir) {
      (session.session as AgentSession).sessionManager.getSessionDir =
        () => join(agentDir, "sessions", "--test--");
    }
    return session;
  }

  test("a new instance can poll and wait on a settled result without replay or delivery", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    provider.respond([fauxAssistantMessage("SAVED-OUTPUT")]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "provide a report" }], async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegate(first, { ticketAction: "wait", ticket, timeoutMs: 5000 });

    const next = await openAt(first.cwd);
    const polled = await callDelegate(next, { ticketAction: "poll", ticket });
    expect(polled.isError).toBe(false);
    expect(polled.text).toContain("completed");
    expect(polled.text).toContain("SAVED-OUTPUT");
    expect((await callDelegate(next, { ticketAction: "wait", ticket, timeoutMs: 10 })).text)
      .toContain("SAVED-OUTPUT");
    expect((await callDelegate(next, { ticketAction: "poll" })).text).toContain(ticket);
    expect((await callDelegate(next, { ticketAction: "resume", ticket })).isError).toBe(true);
    expect((await callDelegate(next, { ticketAction: "answer", ticket, taskId: "task-1", questionId: "q-1", answer: "x" })).isError).toBe(true);
    const disk = statSync(join(first.cwd, "delegate-tickets", `${ticket}.json`));
    expect(disk.mode & 0o077).toBe(0);
    expect(statSync(join(first.cwd, "delegate-tickets")).mode & 0o077).toBe(0);
  });

  test("unfinished work reappears interrupted, never restarted by poll", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const blocked: FauxResponseFactory = async () => {
      started();
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    };
    provider.respond([fauxAssistantMessage("COMPLETED-FIRST"), blocked]);
    try {
      const dispatched = await callDelegate(first, {
        tasks: [
          { id: "first", prompt: "completed task" },
          { id: "later", prompt: "long task" },
        ],
        async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await entered;
      // A fresh extension reading the on-disk snapshot models a cold start.
      // It cannot adopt the old instance's live worker.
      const next = await openAt(first.cwd);
      const poll = await callDelegate(next, { ticketAction: "poll", ticket });
      expect(poll.text).toContain("interrupted");
      expect(poll.text).toContain("COMPLETED-FIRST");
      expect(poll.text).not.toContain("LATE-OUTPUT");
      expect(poll.text).toMatch(/unknown|may have changed/i);
      const again = await callDelegate(next, { ticketAction: "wait", ticket, timeoutMs: 10 });
      expect(again.text).toContain("interrupted");
      const cancel = await callDelegate(next, { ticketAction: "cancel", ticket, force: true });
      expect(cancel.isError).toBe(true);
      expect(cancel.text).toMatch(/recovered interrupted/i);
    } finally {
      release?.();
    }
  });

  test("insecure or malformed storage fails visibly before workers start", async () => {
    const first = await openAt();
    const provider = await installSubagentModel(first);
    provider.respond([fauxAssistantMessage("SHOULD-NOT-RUN")]);
    const dir = join(first.cwd, "delegate-tickets");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o755);
    try {
      expect((await callDelegate(first, { sessionAction: "list" })).isError).toBe(false);
      const sync = await callDelegate(first, { tasks: [{ prompt: "sync works" }] });
      expect(sync.isError).toBe(false);
      expect(sync.text).toContain("SHOULD-NOT-RUN");
      expect(provider.state.callCount).toBe(1);
      const denied = await callDelegate(first, { tasks: [{ prompt: "do not start" }], async: true });
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/owner-only|ticket/i);
      expect(provider.state.callCount).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
    }
    writeFileSync(join(dir, "t-00000000-0000-4000-8000-000000000000.json"), "{}", { mode: 0o600 });
    const next = await openAt(first.cwd);
    const nextModel = await installSubagentModel(next);
    nextModel.respond([fauxAssistantMessage("SYNC-AFTER-CORRUPTION")]);
    expect((await callDelegate(next, { sessionAction: "list" })).isError).toBe(false);
    const sync = await callDelegate(next, { tasks: [{ prompt: "sync despite corrupt journal" }] });
    expect(sync.isError).toBe(false);
    expect(sync.text).toContain("SYNC-AFTER-CORRUPTION");
    const corrupt = await callDelegate(next, { ticketAction: "poll" });
    expect(corrupt.isError).toBe(true);
    expect(corrupt.text).toMatch(/recover ticket|invalid or unsupported/i);
    const asyncCall = await callDelegate(next, { tasks: [{ prompt: "do not run" }], async: true });
    expect(asyncCall.isError).toBe(true);
    expect(nextModel.state.callCount).toBe(1);
  });

  test("cold terminal cancellation with missing outcomes warns of unknown effects", async () => {
    const first = await openAt();
    const model = await installSubagentModel(first);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => { started = r; });
    const gate = new Promise<void>((r) => { release = r; });
    model.respond([async () => {
      started();
      await gate;
      return fauxAssistantMessage("LATE-OUTPUT");
    }]);
    try {
      const dispatched = await callDelegate(first, {
        tasks: [{ prompt: "possibly change files" }], async: true,
      });
      const ticket = ticketIdOf(dispatched.text);
      await entered;
      const cancelled = await callDelegate(first, { ticketAction: "cancel", ticket, force: true });
      expect(cancelled.isError).toBe(false);
      // Model a crash after the terminal status was saved but before the
      // provisional outcome: the live coordinator can race to record it.
      const path = join(first.cwd, "delegate-tickets", `${ticket}.json`);
      const saved = JSON.parse(readFileSync(path, "utf8")) as { status: string; outcomes: unknown[] };
      expect(saved.status).toBe("cancelled");
      saved.outcomes[0] = null;
      writeFileSync(path, JSON.stringify(saved));
      const next = await openAt(first.cwd);
      const polled = await callDelegate(next, { ticketAction: "poll", ticket });
      expect(polled.text).toContain(`Ticket "${ticket}": cancelled`);
      expect(polled.text).toMatch(/effects are unknown|may have changed/i);
      expect((await callDelegate(next, { ticketAction: "wait", ticket })).text)
        .toMatch(/effects are unknown|may have changed/i);
      expect((await callDelegate(next, { ticketAction: "poll" })).text)
        .toMatch(/effects are unknown|may have changed/i);
    } finally {
      release?.();
    }
  });

  test("a save failure after launch is disclosed; a cold reader never invents completion", async () => {
    const first = await openAt();
    const model = await installSubagentModel(first);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    model.respond([async () => { await gate; return fauxAssistantMessage("LIVE-ONLY-OUTPUT"); }]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "finish after the disk stops accepting writes" }], async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const dir = join(first.cwd, "delegate-tickets");
    chmodSync(dir, 0o500);
    try {
      release();
      const live = await callDelegate(first, { ticketAction: "wait", ticket, timeoutMs: 5000 });
      expect(live.text).toContain("LIVE-ONLY-OUTPUT");
      expect(live.text).toMatch(/recovery save failed/i);
    } finally {
      chmodSync(dir, 0o700);
    }
    const next = await openAt(first.cwd);
    const recovered = await callDelegate(next, { ticketAction: "poll", ticket });
    expect(recovered.text).toContain("interrupted");
    expect(recovered.text).not.toContain("LIVE-ONLY-OUTPUT");
  });

  test("orderly shutdown saves cancellation rather than an interrupted snapshot", async () => {
    const first = await openAt();
    const model = await installSubagentModel(first);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    model.respond([async () => { await gate; return fauxAssistantMessage("TOO-LATE"); }]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "cancel on shutdown" }], async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      const shutdown = (first.session as AgentSession).extensionRunner.emit({
        type: "session_shutdown", reason: "quit",
      });
      release();
      await shutdown;
      const next = await openAt(first.cwd);
      const poll = await callDelegate(next, { ticketAction: "poll", ticket });
      expect(poll.text).toContain(`Ticket "${ticket}": cancelled`);
      expect(poll.text).not.toContain(`Ticket "${ticket}": interrupted`);
    } finally {
      release?.();
    }
  });
});
