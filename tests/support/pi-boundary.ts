import { resolve } from "node:path";
import {
  calls,
  createTestSession,
  says,
  when,
  type TestSession,
  type ToolResultRecord,
} from "@marcfargas/pi-test-harness";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const extensionPath = resolve(import.meta.dirname, "../../delegate.ts");

export interface PublicTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
}

export async function openDelegateBoundary(): Promise<TestSession> {
  return createTestSession({
    extensions: [extensionPath],
    propagateErrors: false,
  });
}

export function delegateTool(session: TestSession): PublicTool {
  const definition = (session.session as AgentSession).extensionRunner
    .getToolDefinition("delegate");
  if (!definition) throw new Error("delegate tool was not registered");
  return definition as unknown as PublicTool;
}

let callSequence = 0;

export async function callDelegate(
  session: TestSession,
  arguments_: Record<string, unknown>,
): Promise<ToolResultRecord> {
  const previousResults = session.events.toolResultsFor("delegate").length;
  callSequence += 1;

  await session.run(
    when(`delegate contract call ${callSequence}`, [
      calls("delegate", arguments_),
      says("done"),
    ]),
  );

  const result = session.events.toolResultsFor("delegate")[previousResults];
  if (!result) throw new Error("delegate call produced no tool result");
  return result;
}

export function objectOf(
  value: unknown,
  description = "value",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} is not an object`);
  }
  return value as Record<string, unknown>;
}
