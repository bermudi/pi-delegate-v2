import { afterEach, describe, expect } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";
import { pendingTest } from "../support/pending.ts";

describe("delegate session contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  pendingTest(
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

  pendingTest(
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

  pendingTest(
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

  pendingTest(
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

  pendingTest(
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
