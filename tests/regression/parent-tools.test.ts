import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { callDelegate, installSubagentModel, openDelegateBoundary } from "../support/pi-boundary.ts";

// Issue #13 regression (v2 evidence, not a migrated v1 helper test): a
// degraded host tool probe must not silently give a restricted parent writers.
describe("regression: parent tool mirroring", () => {
  let session: TestSession | undefined;
  const restores: (() => void)[] = [];

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    session?.dispose();
    session = undefined;
  });

  function unavailableTools() {
    const probe = spyOn(session!.session as AgentSession, "getActiveToolNames")
      .mockImplementation(() => { throw new Error("parent tool inventory unavailable"); });
    restores.push(() => probe.mockRestore());
    return probe;
  }

  for (const async of [false, true]) {
    test(`mixed batch rejects before any child starts when parent tools throw (${async ? "async" : "sync"})`, async () => {
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      subagents.respond([fauxAssistantMessage("UNEXPECTED-CHILD"), fauxAssistantMessage("UNEXPECTED-CHILD")]);
      unavailableTools();
      const logged = spyOn(console, "error").mockImplementation(() => {});
      restores.push(() => logged.mockRestore());

      const result = await callDelegate(session, {
        async,
        tasks: [
          { prompt: "valid sibling must not start", agent: "scout" },
          { prompt: "requires parent tools", agent: "default" },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/default.*parent.*tools/i);
      expect(result.text).toContain("parent tool inventory unavailable");
      expect(result.text).toMatch(/explicit.*tools|restore.*parent/i);
      expect(subagents.state.callCount).toBe(0);
      expect(logged.mock.calls.flat().join(" ")).toContain("parent tool inventory unavailable");
      const roster = await callDelegate(session, { ticketAction: "poll" });
      expect(roster.text).not.toContain("running");
    });
  }

  test("independent tool choices bypass unavailable parent tools", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const probe = unavailableTools();
    const cases = [
      { task: { agent: "default", tools: ["read"] }, tools: ["read"] },
      { task: { agent: "default", tools: [] }, tools: [] },
      { task: { agent: "scout" }, tools: ["read", "grep", "find", "ls"] },
      { task: { agent: "coder" }, tools: ["read", "bash", "edit", "write"] },
      { task: { agent: "reviewer" }, tools: ["read", "grep", "find", "ls"] },
      { task: {}, tools: ["read", "bash", "edit", "write"] },
    ];
    for (const { task, tools } of cases) {
      let observed: string[] | undefined;
      subagents.respond([(context) => {
        observed = (context.tools ?? []).map((tool) => tool.name).sort();
        return fauxAssistantMessage("EXPECTED-CHILD");
      }]);
      const result = await callDelegate(session, { tasks: [{ prompt: "inspect capabilities", ...task }] });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("EXPECTED-CHILD");
      expect(observed).toEqual([...tools].sort());
    }
    expect(subagents.state.callCount).toBe(cases.length);
    expect(probe).not.toHaveBeenCalled();
  });

  test("default profile mirrors restricted parent tools", async () => {
    session = await openDelegateBoundary();
    const subagents = await installSubagentModel(session);
    const probe = spyOn(session.session as AgentSession, "getActiveToolNames")
      .mockReturnValue(["read", "delegate"]);
    restores.push(() => probe.mockRestore());
    let observed: string[] | undefined;
    subagents.respond([(context) => {
      observed = (context.tools ?? []).map((tool) => tool.name);
      return fauxAssistantMessage("READ-ONLY-CHILD");
    }]);
    const result = await callDelegate(session, { tasks: [{ prompt: "inspect", agent: "default" }] });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("READ-ONLY-CHILD");
    expect(observed).toEqual(["read"]);
    expect(subagents.state.callCount).toBe(1);
  });
});
