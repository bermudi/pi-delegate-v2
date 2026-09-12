import { afterEach, describe, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";
import { pendingTest } from "../support/pending.ts";

function gitInit(dir: string): void {
  execSync("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
  });
}

describe("delegate workspace and shared-write contract", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "delegate-v2-ws-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    session?.dispose();
    session = undefined;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  pendingTest(
    "overlapping shared writers in one call serialize in task order",
    async () => {
      // v1 evidence: dispatch.test.ts "serialized successor still runs after a
      // failed predecessor" and ordering chain tests; INVARIANTS: same-call
      // overlapping shared writers serialize in task order.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();

      const timeline: string[] = [];
      const timed = (tag: string, text: string): FauxResponseFactory =>
        async () => {
          timeline.push(`start:${tag}`);
          await new Promise((r) => setTimeout(r, 30));
          timeline.push(`end:${tag}`);
          return fauxAssistantMessage(text);
        };
      subagents.respond([
        timed("first", "W1-DONE"),
        timed("second", "W2-DONE"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          { prompt: "w1", cwd: dir, model: subagents.spec, tools: ["write"] },
          { prompt: "w2", cwd: dir, model: subagents.spec, tools: ["write"] },
        ],
      });
      expect(result.isError).toBe(false);

      // Serialized: the second writer's interval starts only after the first
      // ends, and the order follows the task array.
      expect(timeline).toEqual([
        "start:first",
        "end:first",
        "start:second",
        "end:second",
      ]);
    },
  );

  pendingTest(
    "a writer overlapping a still-running async ticket rejects the whole call",
    async () => {
      // v1 evidence: dispatch.test.ts "rejects a writer that overlaps a
      // still-running async ticket"; INVARIANTS: overlap with active work
      // rejects, not queues.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();

      let release!: () => void;
      const gatePromise = new Promise<void>((r) => (release = r));
      const hanging: FauxResponseFactory = async () => {
        await gatePromise;
        return fauxAssistantMessage("bg done");
      };
      subagents.respond([hanging]);

      const dispatched = await callDelegate(session, {
        tasks: [
          { prompt: "bg", cwd: dir, model: subagents.spec, tools: ["write"] },
        ],
        async: true,
      });
      ticketIdOf(dispatched.text); // ticket exists
      const callsBefore = subagents.state.callCount;

      const rejected = await callDelegate(session, {
        tasks: [
          { prompt: "now", cwd: dir, model: subagents.spec, tools: ["write"] },
        ],
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toMatch(/overlap|running|conflict|active/i);
      // No task started: the rejected call consumed no subagent work.
      expect(subagents.state.callCount).toBe(callsBefore);

      release();
    },
  );

  pendingTest(
    "shared and isolated work overlapping in one call rejects before execution",
    async () => {
      // v1 evidence: dispatch.test.ts "mixed isolated and shared same-call
      // overlap still rejects"; INVARIANTS: shared/isolated overlap rejects.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "shared",
            cwd: dir,
            model: subagents.spec,
            tools: ["write"],
            workspace: "shared",
          },
          {
            prompt: "isolated",
            cwd: dir,
            model: subagents.spec,
            tools: ["write"],
            workspace: "isolated",
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/isolated|shared|overlap|conflict/i);
      expect(subagents.state.callCount).toBe(0);
    },
  );

  pendingTest(
    "scratch changes are discarded and never reach the source tree",
    async () => {
      // v1 evidence: workspace.test.ts "copies the full Git tree, maps a
      // nested cwd, and discards mutations"; SPEC: scratch runs once in a
      // disposable copy and discards its changes.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const marker = join(dir, "scratch-marker.txt");
      // A relative write resolves inside the scratch copy, not the source.
      const writeThenDone: FauxResponseStep[] = [
        fauxAssistantMessage([
          fauxToolCall("write", {
            path: "scratch-marker.txt",
            content: "scratch",
          }),
        ]),
        fauxAssistantMessage("SCRATCH-DONE"),
      ];
      subagents.respond(writeThenDone);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "write a file",
            cwd: dir,
            model: subagents.spec,
            workspace: "scratch",
            tools: ["write"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("SCRATCH-DONE");
      expect(existsSync(marker)).toBe(false);
    },
  );

  pendingTest(
    "isolated proposals reconcile into the source in task order",
    async () => {
      // v1 evidence: isolated-workspace.test.ts "captures dirty and untracked
      // source state, then applies proposals in task order"; SPEC: isolated
      // reconciles successful proposals in task order.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const fileA = join(dir, "a.txt");
      const fileB = join(dir, "b.txt");
      subagents.respond([
        fauxAssistantMessage([
          fauxToolCall("write", { path: "a.txt", content: "A" }),
        ]),
        fauxAssistantMessage("A-DONE"),
        fauxAssistantMessage([
          fauxToolCall("write", { path: "b.txt", content: "B" }),
        ]),
        fauxAssistantMessage("B-DONE"),
      ]);

      const result = await callDelegate(session, {
        tasks: [
          {
            prompt: "write a.txt",
            cwd: dir,
            model: subagents.spec,
            workspace: "isolated",
            tools: ["write"],
          },
          {
            prompt: "write b.txt",
            cwd: dir,
            model: subagents.spec,
            workspace: "isolated",
            tools: ["write"],
          },
        ],
      });
      expect(result.isError).toBe(false);
      // A clean application is applied_unverified, never a correctness claim.
      expect(result.text).toMatch(/applied_unverified/);
      expect(readFileSync(fileA, "utf8")).toBe("A");
      expect(readFileSync(fileB, "utf8")).toBe("B");
    },
  );

  pendingTest(
    "a conflicting isolated proposal is retained, not silently applied or lost",
    async () => {
      // v1 evidence: isolated-workspace.test.ts "keeps a conflicting proposal
      // as a ref, full patch, and worktree"; INVARIANTS: conflicts retain
      // discoverable, recoverable artifacts; each proposal is all-or-nothing.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      const target = join(dir, "conflict.txt");
      writeFileSync(target, "original");
      execSync("git add -A && git commit -qm init", { cwd: dir });

      subagents.respond([
        fauxAssistantMessage([
          fauxToolCall("write", {
            path: "conflict.txt",
            content: "worker-change",
          }),
        ]),
        fauxAssistantMessage("WROTE"),
        // Second worker does not touch conflict.txt.
        fauxAssistantMessage([
          fauxToolCall("write", { path: "ok.txt", content: "ok" }),
        ]),
        fauxAssistantMessage("OK-DONE"),
      ]);

      // The human edits the same file mid-flight — the baseline moved.
      const dispatched = callDelegate(session, {
        tasks: [
          {
            prompt: "change conflict.txt",
            cwd: dir,
            model: subagents.spec,
            workspace: "isolated",
            tools: ["write"],
          },
          {
            prompt: "write ok.txt",
            cwd: dir,
            model: subagents.spec,
            workspace: "isolated",
            tools: ["write"],
          },
        ],
      });
      writeFileSync(target, "human-change");
      const result = await dispatched;

      // The independent proposal still applied; the conflicting one did not
      // clobber the human edit, and the result explains what was retained.
      expect(readFileSync(target, "utf8")).toBe("human-change");
      expect(result.text).toMatch(/conflict|retained|recover/i);
      expect(readFileSync(join(dir, "ok.txt"), "utf8")).toBe("ok");
    },
  );
});
