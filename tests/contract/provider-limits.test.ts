import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { callDelegate, installSubagentModel, openDelegateBoundary } from "../support/pi-boundary.ts";

describe("provider limit guidance (new v2 issue #26 contract)", () => {
  let session: TestSession | undefined;
  afterEach(() => { session?.dispose(); session = undefined; });

  test("a provider reset window is retained; no instant retry or false auto-resume promise", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "429 rate limit; Retry-After: 3600 seconds",
    })]);
    const result = await callDelegate(session, { tasks: [{ prompt: "report" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Retry-After: 3600 seconds");
    expect(result.text).toMatch(/no immediate retry|not.*retry/i);
    expect(result.text).toMatch(/no.*automatic resume/i);
    expect(model.state.callCount).toBe(1);
  });

  test("short rate limit can retry, but exhausted quota is not misreported as temporary", async () => {
    session = await openDelegateBoundary();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 too many requests" }),
      fauxAssistantMessage("RECOVERED"),
    ]);
    const retried = await callDelegate(session, { tasks: [{ prompt: "report" }] });
    expect(retried.text).toContain("RECOVERED");
    expect(model.state.callCount).toBe(2);
    model.respond([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient quota: upgrade your account" }),
    ]);
    const quota = await callDelegate(session, { tasks: [{ prompt: "report" }] });
    expect(quota.text).toMatch(/account|quota/i);
    expect(quota.text).not.toMatch(/temporary provider rate limit/i);
    expect(model.state.callCount).toBe(3);
  });
});
