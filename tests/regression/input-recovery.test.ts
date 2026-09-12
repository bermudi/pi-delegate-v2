import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

describe("regression: malformed provider calls recover at the public boundary", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  async function call(
    arguments_: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly isError: boolean }> {
    // Harness playbooks restart their generated tool-call IDs on each run.
    // A fresh Pi session ensures a repeated ID is never mistaken for a replay.
    session?.dispose();
    session = await openDelegateBoundary();
    return callDelegate(session, arguments_);
  }

  test("recovers a JSON-stringified task array", async () => {
    const result = await call({
      tasks: '[{"prompt":"inspect"}]',
      async: true,
    });
    expect(result.text).not.toContain("Validation failed");
  });

  test("accepts flat task fields after boundary recovery", async () => {
    const result = await call({
      prompt: "inspect",
      tools: '["read","grep"]',
      async: true,
    });
    expect(result.text).not.toContain("Validation failed");
  });

  test("accepts a bare tool group after boundary recovery", async () => {
    const result = await call({
      tasks: [{ prompt: "inspect", tools: "ro" }],
    });
    expect(result.text).not.toContain("Validation failed");
  });

  test("does not reinterpret explicit ticket or session control as work", async () => {
    const ticket = await call({
      ticketAction: "poll",
      prompt: "stray",
    });
    expect(ticket.isError).toBe(true);
    expect(ticket.text).toContain("Validation failed");
    expect(ticket.text).not.toContain("dispatch is not implemented");

    const sessionControl = await call({
      sessionAction: "close",
      sessionId: "review",
      prompt: "stray",
    });
    expect(sessionControl.isError).toBe(true);
    expect(sessionControl.text).toContain("Validation failed");
    expect(sessionControl.text).not.toContain("dispatch is not implemented");
  });

  test("treats a bare sessionId as task reuse intent", async () => {
    const result = await call({
      sessionId: "review",
      prompt: "continue",
    });
    expect(result.text).not.toContain("Validation failed");
  });

  test("leaves ambiguous malformed strings for schema rejection", async () => {
    const invalidTasks = await call({
      tasks: "not json",
    });
    expect(invalidTasks.isError).toBe(true);
    expect(invalidTasks.text).toContain("Validation failed");
    expect(invalidTasks.text).not.toContain("dispatch is not implemented");

    const invalidTools = await call({
      tasks: [{ prompt: "inspect", tools: "read, write" }],
    });
    expect(invalidTools.isError).toBe(true);
    expect(invalidTools.text).toContain("Validation failed");
    expect(invalidTools.text).not.toContain("dispatch is not implemented");
  });
});
