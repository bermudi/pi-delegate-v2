import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe("delegate session contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
    "a sessionId task pools a live session, lists it, and continues it on reuse",
    async () => {
      // v1 evidence: lifecycle.test.ts "task with sessionId creates pooled
      // session on first use" / "reuses pooled session on second call";
      // SPEC: a successful task with sessionId keeps a live conversation.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("FIRST-TURN")]);
      const first = await callDelegate(session, {
        tasks: [
          { prompt: "remember ALPHA-MARKER", sessionId: "conv", model: subagents.spec },
        ],
      });
      expect(first.isError).toBe(false);

      const listed = await callDelegate(session, { sessionAction: "list" });
      expect(listed.isError).toBe(false);
      expect(listed.text).toContain("conv");

      // On reuse the subagent sees the prior conversation: its context
      // contains the first prompt and reply.
      const sawHistory: FauxResponseFactory = (context) => {
        const transcript = JSON.stringify(context);
        const saw = transcript.includes("ALPHA-MARKER");
        return fauxAssistantMessage(saw ? "CONTINUED" : "FRESH-SESSION");
      };
      subagents.respond([sawHistory]);
      const second = await callDelegate(session, {
        tasks: [{ prompt: "again", sessionId: "conv", model: subagents.spec }],
      });
      expect(second.isError).toBe(false);
      expect(second.text).toContain("CONTINUED");
    },
  );

  test(
    "close removes the named session and a later call starts fresh",
    async () => {
      // v1 evidence: lifecycle.test.ts "close action tears down pooled
      // session"; SPEC: close aborts, disposes, and removes the session.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("SESQUIPEDALIAN")]);
      await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "conv", model: subagents.spec }],
      });

      const closed = await callDelegate(session, {
        sessionAction: "close",
        sessionId: "conv",
      });
      expect(closed.isError).toBe(false);

      const listed = await callDelegate(session, { sessionAction: "list" });
      expect(listed.text).not.toContain("conv");

      const fresh: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          JSON.stringify(context).includes("SESQUIPEDALIAN")
            ? "CONTINUED"
            : "FRESH",
        );
      subagents.respond([fresh]);
      const reopened = await callDelegate(session, {
        tasks: [{ prompt: "x", sessionId: "conv", model: subagents.spec }],
      });
      expect(reopened.text).toContain("FRESH");
    },
  );

  test(
    "reusing a sessionId with incompatible frozen configuration is rejected",
    async () => {
      // v1 evidence: lifecycle.test.ts "session config mismatch rejects with
      // actionable message"; pool.test checkout frozen-field rejections;
      // INVARIANTS: cwd, tools, thinking, model, base prompt are frozen.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("hi")]);
      await callDelegate(session, {
        tasks: [
          { prompt: "x", sessionId: "conv", model: subagents.spec, tools: ["read"] },
        ],
      });

      const mismatched = await callDelegate(session, {
        tasks: [
          {
            prompt: "x",
            sessionId: "conv",
            model: subagents.spec,
            tools: ["read", "bash"],
          },
        ],
      });
      // The incompatible reuse must fail with an actionable explanation
      // naming what froze; whether the call or only the task is marked as the
      // error is a v2 formatting choice.
      expect(mismatched.text).toMatch(/conv|session/i);
      expect(mismatched.text).toMatch(/frozen|mismatch|incompatible|tools/i);
    },
  );

  test(
    "a cancelled run evicts the pooled session and a later call starts fresh",
    async () => {
      // INVARIANTS: a pooled session cancelled after prompting MUST be
      // evicted; reuse must not observe its conversation. v1 evidence:
      // pool.test eviction after cancelled runs.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      subagents.respond([fauxAssistantMessage("POOLED")]);
      const first = await callDelegate(session, {
        tasks: [
          {
            prompt: "remember EVICT-MARKER",
            sessionId: "conv",
            model: subagents.spec,
          },
        ],
      });
      expect(first.isError).toBe(false);

      // Reuse the pooled session with a gated provider; cancel only once the
      // second stream has demonstrably started (callCount is incremented at
      // stream entry), so the eviction under test is a prompted run.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      subagents.respond([
        async () => {
          await gate;
          return fauxAssistantMessage("never");
        },
      ]);
      const created = await callDelegate(session, {
        tasks: [
          { prompt: "more work", sessionId: "conv", model: subagents.spec },
        ],
        async: true,
      });
      for (let i = 0; i < 200 && subagents.state.callCount < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(subagents.state.callCount).toBe(2);

      // A live session mid-run is busy: close must refuse to race it.
      const closedBusy = await callDelegate(session, {
        sessionAction: "close",
        sessionId: "conv",
      });
      expect(closedBusy.isError).toBe(true);
      expect(closedBusy.text).toMatch(/conv|running|busy/i);

      const ticket = ticketIdOf(created.text);
      const cancelled = await callDelegate(session, {
        ticketAction: "cancel",
        ticket,
        force: true,
      });
      expect(cancelled.text).toMatch(/cancel/i);

      // Let the gated worker wind down; the busy mark frees and the pool
      // entry clears only on confirmed quiescence (the provisional outcome
      // is replaced once "unconfirmed" disappears from the ticket view).
      release();
      for (let i = 0; i < 200; i++) {
        const view = await callDelegate(session, {
          ticketAction: "poll",
          ticket,
        });
        if (view.text.includes("### Task") && !view.text.includes("unconfirmed")) {
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      const listed = await callDelegate(session, { sessionAction: "list" });
      expect(listed.text).not.toContain("conv");

      const inspect: FauxResponseFactory = (context) =>
        fauxAssistantMessage(
          JSON.stringify(context).includes("EVICT-MARKER")
            ? "CONTINUED"
            : "FRESH",
        );
      subagents.respond([inspect]);
      const reused = await callDelegate(session, {
        tasks: [
          { prompt: "again", sessionId: "conv", model: subagents.spec },
        ],
      });
      expect(reused.isError).toBe(false);
      expect(reused.text).toContain("FRESH");
    },
  );

  test(
    "close on an unknown session reports the miss",
    async () => {
      // SPEC: close removes the named session; a nonexistent one is an
      // actionable error, not a silent no-op.
      session = await openDelegateBoundary();
      const result = await callDelegate(session, {
        sessionAction: "close",
        sessionId: "ghost",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/ghost|no live session/i);
    },
  );

  test(
    "resumeFrom with a nonexistent transcript fails with an actionable error",
    async () => {
      // v1 evidence: lifecycle.test.ts "resumeFrom with nonexistent file
      // returns error" and "placeholder string returns invalid path error".
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "continue",
            resumeFrom: "/nonexistent/definitely-missing.jsonl",
            model: subagents.spec,
          },
        ],
      });
      expect(result.text).toMatch(/resume|transcript|jsonl|exist/i);
      expect(result.text).not.toContain("dispatch is not implemented");
    },
  );

  test(
    "resumeFrom without a prompt continues the transcript with a default instruction",
    async () => {
      // SPEC: prompt is optional only with resumeFrom; a bare resumeFrom must
      // not send an empty message — it continues with a default prompt.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      const transcript = join(session.cwd, "prior-session.jsonl");
      const now = new Date().toISOString();
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: "fixture-1",
            timestamp: now,
            cwd: session.cwd,
          }),
          JSON.stringify({
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: now,
            message: {
              role: "user",
              content: [{ type: "text", text: "PRIOR-INSTRUCTION" }],
              timestamp: Date.now(),
            },
          }),
        ].join("\n") + "\n",
      );

      let sawPrior = false;
      let sawDefaultPrompt = false;
      const inspect: FauxResponseFactory = (context) => {
        const serialized = JSON.stringify(context);
        sawPrior = serialized.includes("PRIOR-INSTRUCTION");
        const users = context.messages.filter((m) => m.role === "user");
        sawDefaultPrompt = JSON.stringify(users.at(-1)).includes(
          "Continue from where you left off",
        );
        return fauxAssistantMessage("RESUMED");
      };
      subagents.respond([inspect]);

      const result = await callDelegate(session, {
        tasks: [{ resumeFrom: transcript, model: subagents.spec }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("RESUMED");
      expect(sawPrior).toBe(true);
      expect(sawDefaultPrompt).toBe(true);
    },
  );

  test(
    "a sessionId held by a running ticket rejects conflicting reuse",
    async () => {
      // v1 evidence: delegate.test.ts isSessionBusy tests (cancelling tickets
      // count as busy); task-resolution validateTasks busy conflicts.
      // SPEC: busy sessions fail the whole call with an actionable error.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const hanging: FauxResponseFactory = async () => {
        await gate;
        return fauxAssistantMessage("done");
      };
      subagents.respond([hanging, fauxAssistantMessage("later")]);

      await callDelegate(session, {
        tasks: [{ prompt: "bg", sessionId: "busy-one", model: subagents.spec }],
        async: true,
      });

      const conflict = await callDelegate(session, {
        tasks: [
          { prompt: "now", sessionId: "busy-one", model: subagents.spec },
        ],
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.text).toMatch(/busy-one|busy|running/i);

      release();
    },
  );
});
