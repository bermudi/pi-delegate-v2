import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  callDelegate, configureDelegate, installSubagentModel, openDelegateBoundary, ticketIdOf,
} from "../support/pi-boundary.ts";

// New #17 contract, not migrated from a v1 helper: exercise the registered
// parent tool and a real (provider-free) child ask_parent tool together.
async function untilQuestion(session: TestSession, ticket: string): Promise<string> {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    const view = await callDelegate(session, { ticketAction: "poll", ticket });
    const match = view.text.match(/Waiting for parent answer: task \S+, question (q-\d+):/);
    if (match) return match[1]!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Worker did not ask a question on ticket ${ticket}`);
}

describe("async worker questions (#17)", () => {
  let session: TestSession | undefined;
  afterEach(() => { session?.dispose(); session = undefined; });

  test("worker waits visibly, another ticket uses its freed capacity, and the correlated answer resumes it", async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, { maxConcurrent: 1, stallTimeoutMs: 80 });
    const model = await installSubagentModel(session);
    const respond: FauxResponseFactory = (context) => {
      const transcript = JSON.stringify(context.messages);
      if (transcript.includes("SECOND-TASK")) return fauxAssistantMessage("SECOND-DONE");
      if (transcript.includes("PARENT-ANSWER")) return fauxAssistantMessage("USED-PARENT-ANSWER");
      return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Which path?" })]);
    };
    model.respond([respond, respond, respond]);
    const first = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "first", prompt: "FIRST-TASK", tools: ["read"] }], async: true,
    })).text);
    const questionId = await untilQuestion(session, first);
    const roster = await callDelegate(session, { ticketAction: "poll" });
    expect(roster.text).toContain("Which path?");
    // The idle capacity is released; the first worker's question must not
    // monopolize the global or per-model slot.
    const second = ticketIdOf((await callDelegate(session, {
      tasks: [{ prompt: "SECOND-TASK", tools: ["read"] }], async: true,
    })).text);
    const finished = await callDelegate(session, { ticketAction: "wait", ticket: second, timeoutMs: 2000 });
    expect(finished.text).toContain("SECOND-DONE");
    const wrongTask = await callDelegate(session, {
      ticketAction: "answer", ticket: first, taskId: "wrong", questionId, answer: "PARENT-ANSWER",
    });
    expect(wrongTask.isError).toBe(true);
    const answered = await callDelegate(session, {
      ticketAction: "answer", ticket: first, taskId: "first", questionId, answer: "PARENT-ANSWER",
    });
    expect(answered.isError).toBe(false);
    expect((await callDelegate(session, {
      ticketAction: "answer", ticket: first, taskId: "first", questionId, answer: "DIFFERENT",
    })).isError).toBe(true);
    const result = await callDelegate(session, { ticketAction: "wait", ticket: first, timeoutMs: 2000 });
    expect(result.text).toContain("USED-PARENT-ANSWER");
    expect(result.text).not.toContain("Waiting for parent answer");
    expect((await callDelegate(session, {
      ticketAction: "answer", ticket: first, taskId: "first", questionId, answer: "PARENT-ANSWER",
    })).isError).toBe(true);
  });

  test("deadline keeps running while a question waits, and late answers fail", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Still there?" })])]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "deadline", prompt: "ASK", deadlineMs: 250 }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    await new Promise((resolve) => setTimeout(resolve, 330));
    const settled = await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 2500 });
    expect(settled.text).toMatch(/deadline exceeded/i);
    expect((await callDelegate(session, {
      ticketAction: "answer", ticket, taskId: "deadline", questionId, answer: "too late",
    })).isError).toBe(true);
  });

  test("forced cancellation invalidates the pending question and does not unblock a worker", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Proceed?" })])]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "cancel", prompt: "ASK" }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    await callDelegate(session, { ticketAction: "cancel", ticket, force: true });
    expect((await callDelegate(session, {
      ticketAction: "answer", ticket, taskId: "cancel", questionId, answer: "yes",
    })).isError).toBe(true);
    const result = await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 2000 });
    expect(result.text).toContain("cancelled");
  });

  test("question wait retains the shared-write reservation even though capacity is free", async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, { maxConcurrent: 1 });
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Should I edit?" })]),
      fauxAssistantMessage("FINISHED"),
    ]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "writer", prompt: "ask", tools: ["write"] }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    const conflicting = await callDelegate(session, {
      tasks: [{ prompt: "same tree", tools: ["write"] }], async: true,
    });
    expect(conflicting.isError).toBe(true);
    expect(conflicting.text).toMatch(/overlap|conflict|reserved|active/i);
    expect(model.state.callCount).toBe(1);
    await callDelegate(session, { ticketAction: "answer", ticket, taskId: "writer", questionId, answer: "do it" });
    expect((await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 2000 })).text).toContain("FINISHED");
  });

  test("an answer while paused is recorded once; another answer cannot replace it", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Choice?" })]),
      fauxAssistantMessage("ANSWERED"),
    ]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "paused", prompt: "ask" }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    await callDelegate(session, { ticketAction: "pause", ticket });
    const reply = { ticketAction: "answer", ticket, taskId: "paused", questionId, answer: "original" };
    expect((await callDelegate(session, reply)).isError).toBe(false);
    expect((await callDelegate(session, reply)).isError).toBe(false);
    expect((await callDelegate(session, { ...reply, answer: "changed" })).isError).toBe(true);
    expect(model.state.callCount).toBe(1);
    await callDelegate(session, { ticketAction: "resume", ticket });
    expect((await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 2000 })).text).toContain("ANSWERED");
  });

  test("answer RPC fields are ticket-only and validated before any worker starts", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    for (const args of [
      { ticketAction: "answer", ticket: "missing", taskId: "t", questionId: "q" },
      { ticketAction: "poll", ticket: "missing", answer: "oops" },
      { tasks: [{ prompt: "no start" }], answer: "oops" },
      { ticketAction: "answer", ticket: "missing", taskId: "t", questionId: "q", answer: "" },
    ]) {
      expect((await callDelegate(session, args)).isError).toBe(true);
    }
    expect(model.state.callCount).toBe(0);
  });

  test("a parent already waiting on a ticket is released when its worker asks", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ask: FauxResponseFactory = async () => {
      await gate;
      return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Unblock parent?" })]);
    };
    model.respond([ask, fauxAssistantMessage("done")]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "block", prompt: "ask" }], async: true,
    })).text);
    const waiting = callDelegate(session, { ticketAction: "wait", ticket });
    release();
    const result = await Promise.race([
      waiting,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("parent wait deadlocked")), 1500)),
    ]);
    expect(result.text).toContain("Unblock parent?");
    expect(result.text).toContain("Wait detached");
    const match = result.text.match(/question (q-\d+):/);
    expect(match).not.toBeNull();
    await callDelegate(session, {
      ticketAction: "answer", ticket, taskId: "block", questionId: match![1], answer: "yes",
    });
    expect((await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 2000 })).text).toContain("done");
  });

  test("a question beside another tool call is rejected rather than parking a still-active worker", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("ask_parent", { question: "Unsafe to park?" }),
        fauxToolCall("read", { path: "AGENTS.md" }),
      ]),
      fauxAssistantMessage("TURN-COMPLETED"),
    ]);
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ prompt: "ask and read", tools: ["read"] }], async: true,
    })).text);
    const settled = await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 2000 });
    expect(settled.text).toContain("TURN-COMPLETED");
    expect((await callDelegate(session, { ticketAction: "poll", ticket })).text).not.toContain("Waiting for parent answer");
  });

  test("a pooled worker can ask on a later async run after a synchronous run", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage("FIRST-DONE"),
      fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Next step?" })]),
      fauxAssistantMessage("SECOND-DONE"),
    ]);
    const first = await callDelegate(session, {
      tasks: [{ prompt: "first", sessionId: "reuse", tools: ["read"] }],
    });
    expect(first.text).toContain("FIRST-DONE");
    const ticket = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "again", prompt: "second", sessionId: "reuse", tools: ["read"] }], async: true,
    })).text);
    const questionId = await untilQuestion(session, ticket);
    await callDelegate(session, {
      ticketAction: "answer", ticket, taskId: "again", questionId, answer: "continue",
    });
    expect((await callDelegate(session, { ticketAction: "wait", ticket, timeoutMs: 2000 })).text).toContain("SECOND-DONE");
  });

  test("cancelling an answered worker queued to reacquire capacity cannot restart it", async () => {
    session = await openDelegateBoundary();
    configureDelegate(session, { maxConcurrent: 1 });
    const model = await installSubagentModel(session);
    let releaseOccupier!: () => void;
    const occupierGate = new Promise<void>((resolve) => { releaseOccupier = resolve; });
    let startedOccupier!: () => void;
    const occupierStarted = new Promise<void>((resolve) => { startedOccupier = resolve; });
    const respond: FauxResponseFactory = async (context) => {
      if (JSON.stringify(context.messages).includes("OCCUPY")) {
        startedOccupier();
        await occupierGate;
        return fauxAssistantMessage("OCCUPIER-FINISHED");
      }
      if (context.messages.some((message) => message.role === "toolResult")) {
        return fauxAssistantMessage("MUST-NOT-CONTINUE");
      }
      return fauxAssistantMessage([fauxToolCall("ask_parent", { question: "Can I resume?" })]);
    };
    model.respond([respond, respond, respond]);
    const first = ticketIdOf((await callDelegate(session, {
      tasks: [{ id: "waiting", prompt: "ASK FIRST", tools: ["read"] }], async: true,
    })).text);
    const questionId = await untilQuestion(session, first);
    const second = ticketIdOf((await callDelegate(session, {
      tasks: [{ prompt: "OCCUPY", tools: ["read"] }], async: true,
    })).text);
    let startTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        occupierStarted,
        new Promise<never>((_, reject) => {
          startTimeout = setTimeout(() => {
            releaseOccupier();
            reject(new Error("occupying worker did not start"));
          }, 2000);
        }),
      ]);
    } finally {
      if (startTimeout !== undefined) clearTimeout(startTimeout);
    }
    await callDelegate(session, {
      ticketAction: "answer", ticket: first, taskId: "waiting", questionId, answer: "yes",
    });
    await callDelegate(session, { ticketAction: "cancel", ticket: first, force: true });
    releaseOccupier();
    expect((await callDelegate(session, { ticketAction: "wait", ticket: second, timeoutMs: 2000 })).text).toContain("OCCUPIER-FINISHED");
    const cancelled = await callDelegate(session, { ticketAction: "poll", ticket: first });
    expect(cancelled.text).toContain("cancelled");
    expect(cancelled.text).not.toContain("MUST-NOT-CONTINUE");
    expect(model.state.callCount).toBe(2);
  });
});
