import { afterEach, describe, expect, test } from "bun:test";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  delegateTool,
  objectOf,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

describe("delegate public tool contract", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  test("registers one callable named delegate with human-facing metadata", async () => {
    session = await openDelegateBoundary();
    const tool = delegateTool(session);

    expect(tool.name).toBe("delegate");
    expect(tool.label.trim().length).toBeGreaterThan(0);
    expect(tool.description.trim().length).toBeGreaterThan(0);
  });

  test("publishes the canonical operation and task fields", async () => {
    session = await openDelegateBoundary();
    const schema = objectOf(delegateTool(session).parameters, "tool schema");
    const top = objectOf(schema.properties, "top-level properties");
    const tasks = objectOf(top.tasks, "tasks schema");
    const task = objectOf(tasks.items, "task schema");
    const taskFields = objectOf(task.properties, "task properties");

    expect(Object.keys(top).sort()).toEqual(
      [
        "async",
        "force",
        "sessionAction",
        "sessionId",
        "tasks",
        "ticket",
        "ticketAction",
        "timeoutMs",
        "workspace",
      ].sort(),
    );
    expect(Object.keys(taskFields).sort()).toEqual(
      [
        "agent",
        "context",
        "cwd",
        "deadlineMs",
        "id",
        "model",
        "prompt",
        "resumeFrom",
        "sessionId",
        "systemPrompt",
        "thinking",
        "tools",
        "workspace",
      ].sort(),
    );
  });

  test("publishes closed control and workspace values", async () => {
    session = await openDelegateBoundary();
    const schema = objectOf(delegateTool(session).parameters);
    const top = objectOf(schema.properties);
    const tasks = objectOf(top.tasks);
    const task = objectOf(tasks.items);
    const fields = objectOf(task.properties);

    expect(objectOf(top.ticketAction).enum).toEqual([
      "poll",
      "cancel",
      "wait",
      "pause",
      "resume",
    ]);
    expect(objectOf(top.sessionAction).enum).toEqual(["close", "list"]);
    expect(objectOf(fields.workspace).enum).toEqual([
      "shared",
      "scratch",
      "isolated",
    ]);
    expect(objectOf(top.workspace).enum).toEqual([
      "shared",
      "scratch",
      "isolated",
    ]);
    expect(objectOf(fields.context).enum).toEqual([
      "fresh",
      "with-parent-transcript",
    ]);
  });

  test("keeps removed controls outside the public schema", async () => {
    session = await openDelegateBoundary();
    const schema = objectOf(delegateTool(session).parameters);
    const top = objectOf(schema.properties);
    const tasks = objectOf(top.tasks);
    const task = objectOf(tasks.items);
    const taskFields = objectOf(task.properties);

    expect(top.action).toBeUndefined();
    expect(top.unsafeSharedWrites).toBeUndefined();
    expect(taskFields.async).toBeUndefined();
    expect(taskFields.sessionAction).toBeUndefined();
    expect(taskFields.unsafeSharedWrites).toBeUndefined();
  });

  test("returns help for both omitted and empty tasks", async () => {
    for (const arguments_ of [{}, { tasks: [] }]) {
      session?.dispose();
      session = await openDelegateBoundary();
      const result = await callDelegate(session, arguments_);
      expect(result.isError).toBe(false);
      expect(result.text).toContain("Delegate Tool Manual");
      expect(result.text).toContain("ticketAction");
      expect(result.text).toContain("sessionAction");
    }
  });

  test("rejects orphaned operation fields instead of falling into help", async () => {
    const invalidCalls: Record<string, unknown>[] = [
      { async: true },
      { tasks: [], async: true },
      { ticket: "ticket-1" },
      { force: true },
      { timeoutMs: 1 },
      { ticketAction: "poll", workspace: "isolated" },
      { sessionAction: "list", workspace: "isolated" },
      { tasks: [{ prompt: "x" }], sessionId: "s" },
    ];

    for (const arguments_ of invalidCalls) {
      session?.dispose();
      session = await openDelegateBoundary();
      const result = await callDelegate(session, arguments_);

      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("Delegate Tool Manual");
    }
  });

  test("does not misclassify selected ticket or session operations as help", async () => {
    // Ticket operations are implemented: a bare poll answers with the empty
    // roster rather than the manual or an error.
    session = await openDelegateBoundary();
    const polled = await callDelegate(session, { ticketAction: "poll" });
    expect(polled.isError).toBe(false);
    expect(polled.text).not.toContain("Delegate Tool Manual");

    // Session operations are implemented too: list answers with the empty
    // session roster rather than the manual or an error.
    session?.dispose();
    session = await openDelegateBoundary();
    const listed = await callDelegate(session, { sessionAction: "list" });
    expect(listed.isError).toBe(false);
    expect(listed.text).not.toContain("Delegate Tool Manual");
  });
});
