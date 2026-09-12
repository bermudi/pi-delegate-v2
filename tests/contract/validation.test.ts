import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";
import { pendingTest } from "../support/pending.ts";

describe("delegate validation contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  async function call(
    arguments_: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly isError: boolean }> {
    session?.dispose();
    session = await openDelegateBoundary();
    return callDelegate(session, arguments_);
  }

  // ── Schema-level rejections (enforced at the boundary today) ────────────

  test("rejects values outside the closed enums", async () => {
    // v1 regression: glm-5.3 read "none confine access" prose as a fourth
    // workspace value and sent workspace:"none". Closed enums are the contract.
    for (const arguments_ of [
      { tasks: [{ prompt: "x", workspace: "none" }] },
      { tasks: [{ prompt: "x", context: "everything" }] },
      { tasks: [{ prompt: "x", thinking: "ultra" }] },
      { ticketAction: "explode" },
      { sessionAction: "restart" },
    ]) {
      const result = await call(arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Validation failed");
    }
  });

  test("rejects task-level control fields instead of silently degrading", async () => {
    // v1 regression: a task-level `async: true` was silently ignored and the
    // batch ran synchronously. Task-level control keys must be rejected.
    for (const arguments_ of [
      { tasks: [{ prompt: "x", async: true }] },
      { tasks: [{ prompt: "x", sessionAction: "close" }] },
      { tasks: [{ prompt: "x", unsafeSharedWrites: true }] },
      { action: "poll", tasks: [{ prompt: "x" }] },
    ]) {
      const result = await call(arguments_);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Validation failed");
      expect(result.text).not.toContain("dispatch is not implemented");
    }
  });

  test("rejects task ids outside the correlation-key charset", async () => {
    for (const id of ["has space", "bad/slash", "emoji-🚫", "x".repeat(65)]) {
      const result = await call({ tasks: [{ id, prompt: "x" }] });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Validation failed");
    }
  });

  // ── Semantic validation (pending: scaffold has no semantic pass yet) ─────

  pendingTest(
    "rejects duplicate task ids with an actionable error before any task starts",
    async () => {
      // v1 evidence: schema.test.ts task id validation; SPEC batch-before-start.
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [
          { id: "dup", prompt: "a" },
          { id: "dup", prompt: "b" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/dup/i);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  pendingTest(
    "rejects duplicate session ids in one batch before any task starts",
    async () => {
      // v1 evidence: task-resolution validateTasks duplicate-session checks.
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [
          { prompt: "a", sessionId: "shared-one" },
          { prompt: "b", sessionId: "shared-one" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/shared-one|session/i);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  pendingTest("rejects non-positive deadlines with an actionable error", async () => {
    // v1 evidence: schema.test.ts "rejects non-positive deadlineMs".
    session = await openDelegateBoundary();
    for (const deadlineMs of [0, -50]) {
      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", deadlineMs }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/deadline/i);
      expect(result.text).not.toContain("dispatch is not implemented");
    }
  });

  pendingTest(
    "rejects one-shot workspaces combined with session persistence or resume",
    async () => {
      // v1 evidence: schema.test.ts "rejects scratch workspace with persistent
      // sessions or resume" and "allows async isolated workspaces but rejects
      // persistent ones". SPEC: scratch and isolated cannot use sessionId or
      // resumeFrom.
      session = await openDelegateBoundary();
      for (const task of [
        { prompt: "x", workspace: "scratch", sessionId: "s1" },
        { prompt: "x", workspace: "scratch", resumeFrom: "/tmp/x.jsonl" },
        { prompt: "x", workspace: "isolated", sessionId: "s1" },
        { prompt: "x", workspace: "isolated", resumeFrom: "/tmp/x.jsonl" },
      ]) {
        const result = await callDelegate(session, { tasks: [task] });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/workspace|session|resume/i);
        expect(result.text).not.toContain("dispatch is not implemented");
      }
    },
  );

  pendingTest(
    "rejects mixed-mode calls with an error naming the conflict",
    async () => {
      // v1 evidence: schema.test.ts mode matrix (ticket control combined with
      // tasks/sessionId/prompt; session precedence over tasks). SPEC: mixing
      // fields from different modes is an error before any task starts.
      session = await openDelegateBoundary();
      for (const arguments_ of [
        { ticketAction: "poll", tasks: [{ prompt: "x" }] },
        { ticketAction: "wait", ticket: "t1", sessionId: "s1" },
        { sessionAction: "list", tasks: [{ prompt: "x" }] },
        { sessionAction: "close", sessionId: "s1", prompt: "x" },
      ]) {
        const result = await callDelegate(session, arguments_);
        expect(result.isError).toBe(true);
        expect(result.text).not.toContain("not implemented");
        expect(result.text).not.toContain("Delegate Tool Manual");
      }
    },
  );

  test(
    "does not merge flat fields into an explicit non-empty task array",
    async () => {
      // v1 evidence: schema.test.ts "rejects any flat task field mixed with an
      // explicit tasks array". SPEC input-recovery: flat folding only applies
      // when there is no task array.
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [{ prompt: "inside" }],
        prompt: "outside",
      });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  pendingTest("rejects a task with no prompt and no resume intent", async () => {
    // v1 evidence: lifecycle.test.ts "task without prompt (and not
    // close/list/resume) throws". SPEC: prompt is optional only with resumeFrom.
    session = await openDelegateBoundary();
    const result = await callDelegate(session, {
      tasks: [{ agent: "scout" }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/prompt/i);
    expect(result.text).not.toContain("dispatch is not implemented");
  });

  pendingTest(
    "rejects an unknown agent with guidance toward valid profiles",
    async () => {
      // v1 evidence: delegate.test.ts "execute rejects unknown agents and
      // suggests help"; lifecycle.test.ts "unknown agent name produces clear
      // error".
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", agent: "nonexistent-agent" }],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/nonexistent-agent/);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  pendingTest(
    "ticket and session controls report which field they require",
    async () => {
      // v1 evidence: delegate.test.ts "cancel requires ticket ID",
      // "close sessionAction requires sessionId", "wait requires a ticket ID".
      session = await openDelegateBoundary();
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ ticketAction: "cancel" }, /ticket/i],
        [{ ticketAction: "wait" }, /ticket/i],
        [{ ticketAction: "pause" }, /ticket/i],
        [{ ticketAction: "resume" }, /ticket/i],
        [{ sessionAction: "close" }, /sessionId/i],
      ];
      for (const [arguments_, pattern] of cases) {
        const result = await callDelegate(session, arguments_);
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(pattern);
        expect(result.text).not.toContain("not implemented");
      }
    },
  );
});
