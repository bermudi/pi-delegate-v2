import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

describe("delegate dispatch contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test(
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

  test(
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

  test(
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

  test(
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

  test(
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

  test(
    "the configured concurrency bound limits simultaneous subagent work",
    async () => {
      // v1 evidence: concurrency.test.ts mapConcurrentByModel bound tests.
      // The session agent dir is the test cwd, so delegate.json there is the
      // user-global config a real Pi process would read. Read-only tools keep
      // the tasks out of shared-write serialization so the concurrency
      // limiter is what is actually measured.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { maxConcurrent: 1 });

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
          tools: ["read"],
        })),
      });

      expect(result.isError).toBe(false);
      expect(maxActive).toBe(1);
    },
  );

  test(
    "a later call re-reads the configured bound, both lower and higher",
    async () => {
      // The limit is per-call configuration: a coordinator must honour a
      // bound that changes between calls, in either direction, regardless of
      // how many permits are active or queued when it is applied.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { maxConcurrent: 1 });

      let active = 0;
      let maxActive = 0;
      const gated: FauxResponseFactory = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return fauxAssistantMessage("done");
      };

      subagents.respond([gated, gated, gated]);
      await callDelegate(session, {
        tasks: [0, 1, 2].map((n) => ({
          prompt: `low ${n}`,
          model: subagents.spec,
          tools: ["read"],
        })),
      });
      expect(maxActive).toBe(1);

      configureDelegate(session, { maxConcurrent: 2 });
      active = 0;
      maxActive = 0;
      subagents.respond([gated, gated, gated, gated]);
      await callDelegate(session, {
        tasks: [0, 1, 2, 3].map((n) => ({
          prompt: `high ${n}`,
          model: subagents.spec,
          tools: ["read"],
        })),
      });
      expect(maxActive).toBe(2);
    },
  );

  test(
    "a per-model concurrency bound serializes tasks on that model",
    async () => {
      // SPEC: concurrency limits are global and per-model. A model-scoped
      // bound of 1 must hold even when the global bound allows more.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        maxConcurrent: 3,
        concurrency: { models: { "delegate-faux/faux-1": 1 } },
      });

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
          tools: ["read"],
        })),
      });
      expect(result.isError).toBe(false);
      expect(maxActive).toBe(1);
      expect(subagents.state.callCount).toBe(3);
    },
  );

  test(
    "a model reference outside the configured alternatives rejects the whole call",
    async () => {
      // SPEC: a task model must name an alternative configured under
      // "models" in delegate.json; subagents otherwise run on the parent's
      // model. A model the caller can merely name is not authorized — the
      // rejection must happen before any task starts and must teach the
      // configured set so the caller can self-correct.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "nope", model: "delegate-faux/typo-9" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("not configured");
      expect(result.text).toContain("delegate-faux/faux-1"); // configured set listed
      expect(subagents.state.callCount).toBe(0); // nothing started
    },
  );

  test(
    "a registry-resolvable model is still rejected unless configured",
    async () => {
      // The faux model is registered on the parent runtime and resolves in
      // the registry, but resolution is gated on the configured allowlist:
      // remove the entry and the same reference must fail; restore it and
      // the task runs. Registry knowledge is not permission.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, { models: ["some-other/model-1"] });
      subagents.respond([fauxAssistantMessage("SHOULD-NOT-RUN")]);

      const rejected = await callDelegate(session, {
        tasks: [{ prompt: "x", model: subagents.spec }],
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain("some-other/model-1");
      expect(subagents.state.callCount).toBe(0);

      configureDelegate(session, { models: [subagents.spec] });
      subagents.respond([fauxAssistantMessage("ALLOWED-RUNS")]);
      const allowed = await callDelegate(session, {
        tasks: [{ prompt: "x", model: subagents.spec }],
      });
      expect(allowed.isError).toBe(false);
      expect(allowed.text).toContain("ALLOWED-RUNS");
    },
  );

  test(
    "a configured reference that does not resolve in the registry rejects the call",
    async () => {
      // SPEC: a configured reference that cannot resolve in the session's
      // model registry fails the whole call identically. The error names the
      // configured entry so the human fixes delegate.json, not the caller.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      configureDelegate(session, {
        models: [subagents.spec, "ghost-provider/model-x"],
      });
      subagents.respond([fauxAssistantMessage("NEVER-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", model: "ghost-provider/model-x" }],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("ghost-provider/model-x");
      expect(result.text).toContain("not available");
      expect(result.text).toContain("delegate.json");
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "model references match configured alternatives case-insensitively",
    async () => {
      // Callers echo model strings in whatever casing they last saw; the
      // gate tolerates that without widening the configured set — the
      // canonical configured entry is what gets resolved, never the
      // caller's casing of it.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("CASE-TOLERANT-RUNS")]);

      const result = await callDelegate(session, {
        tasks: [{ prompt: "x", model: "DELEGATE-FAUX/FAUX-1" }],
      });

      expect(result.isError).toBe(false);
      expect(result.text).toContain("CASE-TOLERANT-RUNS");
      expect(subagents.state.callCount).toBe(1);
    },
  );

  test(
    "with-parent-transcript prepends the parent conversation to the task context",
    async () => {
      // SPEC: context "with-parent-transcript" gives the subagent the parent
      // conversation as context. The transcript must contain this session's
      // own user/assistant text, without parent tools or extensions.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);

      let sawParentTranscript = false;
      const inspect: FauxResponseFactory = async (context) => {
        const firstUser = context.messages.find(
          (m) => m.role === "user",
        );
        const text = JSON.stringify(firstUser);
        sawParentTranscript =
          text.includes("parent-session") &&
          text.includes("delegate contract call");
        return fauxAssistantMessage("CONTEXT-SEEN");
      };
      subagents.respond([inspect]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "look back",
            model: subagents.spec,
            context: "with-parent-transcript",
          },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("CONTEXT-SEEN");
      expect(sawParentTranscript).toBe(true);
    },
  );
});
