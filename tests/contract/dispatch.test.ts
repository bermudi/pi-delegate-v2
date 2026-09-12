import { afterEach, describe, expect } from "bun:test";
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
import { pendingTest } from "../support/pending.ts";

describe("delegate dispatch contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  pendingTest(
    "synchronous dispatch returns per-task results in task input order",
    async () => {
      // v1 evidence: lifecycle.test.ts "multiple fresh tasks run in parallel
      // and all succeed"; SPEC: synchronous results preserve task input order.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("OUTPUT-ALPHA"),
        fauxAssistantMessage("OUTPUT-BETA"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "first", model: subagents.spec },
          { prompt: "second", model: subagents.spec },
        ],
      });

      expect(result.isError).toBe(false);
      const alpha = result.text.indexOf("OUTPUT-ALPHA");
      const beta = result.text.indexOf("OUTPUT-BETA");
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(beta).toBeGreaterThan(alpha);
    },
  );

  pendingTest(
    "a failed task reports its own failure without failing its siblings",
    async () => {
      // v1 evidence: delegate.test.ts resolveFinalTicketStatus matrix;
      // failure is a per-task outcome, not a whole-call throw.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([
        fauxAssistantMessage("OUTPUT-OK"),
        fauxAssistantMessage("boom", {
          stopReason: "error",
          errorMessage: "provider exploded",
        }),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "fine", model: subagents.spec },
          { prompt: "doomed", model: subagents.spec },
        ],
      });

      // The call itself completes; the failing task is reported as failed and
      // the sibling's output is still returned.
      expect(result.text).toContain("OUTPUT-OK");
      expect(result.text).toMatch(/fail|error|exploded/i);
    },
  );

  pendingTest(
    "caller-provided task ids appear on results for correlation",
    async () => {
      // v1 evidence: dispatch.test.ts "carries caller-provided task id onto
      // result and progress".
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("OUTPUT-ID")]);

      const result = await callDelegate(session, {
        tasks: [{ id: "corr-1", prompt: "x", model: subagents.spec }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("corr-1");
      expect(result.text).toContain("OUTPUT-ID");
    },
  );

  pendingTest(
    "synchronous results carry aggregate usage when the host supports it",
    async () => {
      // v1 evidence: usage.test.ts nested usage accounting; SPEC: synchronous
      // results include aggregate usage. Pi 0.81+ persists usage on the
      // toolResult message, so read it off the session event.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("done")]);

      await callDelegate(session, {
        tasks: [{ prompt: "x", model: subagents.spec }],
      });

      const end = session.events.all
        .filter(
          (e) => e.type === "tool_execution_end" && e.toolName === "delegate",
        )
        .at(-1);
      const result = (end as { result?: Record<string, unknown> } | undefined)
        ?.result;
      expect(result).toBeDefined();
      // Usage may live on the result or its details; either is the contract.
      const serialized = JSON.stringify(result);
      expect(serialized).toMatch(/usage|tokens/i);
    },
  );

  pendingTest(
    "async dispatch returns a ticket and the batch completes in background",
    async () => {
      // v1 evidence: delegate.test.ts async delegate integration; SPEC:
      // async:true returns a ticket immediately and auto-delivers the result.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("OUTPUT-ASYNC")]);

      const dispatched = await callDelegate(session, {
        tasks: [{ prompt: "bg", model: subagents.spec }],
        async: true,
      });
      expect(dispatched.isError).toBe(false);
      const ticket = ticketIdOf(dispatched.text);

      const polled = await callDelegate(session, {
        ticketAction: "wait",
        ticket,
        timeoutMs: 5000,
      });
      expect(polled.isError).toBe(false);
      expect(polled.text).toContain("OUTPUT-ASYNC");
    },
  );

  pendingTest(
    "the configured concurrency bound limits simultaneous subagent work",
    async () => {
      // v1 evidence: concurrency.test.ts mapConcurrentByModel bound tests.
      // The session agent dir is the test cwd, so delegate.json there is the
      // user-global config a real Pi process would read.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      writeFileSync(
        join(session.cwd, "delegate.json"),
        JSON.stringify({ maxConcurrent: 1 }),
      );

      let active = 0;
      let maxActive = 0;
      const gated: FauxResponseFactory = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        return fauxAssistantMessage("done");
      };
      subagents.respond([gated, gated, gated]);

      const result = await callDelegate(session, {
        tasks: [0, 1, 2].map((n) => ({
          prompt: `task ${n}`,
          model: subagents.spec,
        })),
      });

      expect(result.isError).toBe(false);
      expect(maxActive).toBe(1);
    },
  );
});
