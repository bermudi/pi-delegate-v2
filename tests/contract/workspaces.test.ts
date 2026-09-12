import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
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
  // An initial commit is required: isolated baselines are built on HEAD.
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git commit -qm init --allow-empty",
    { cwd: dir },
  );
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

  test(
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

  test(
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

  test(
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

  test(
    "unimplemented workspace modes fail loudly before any provider call",
    async () => {
      // INVARIANTS: unsupported modes must not silently degrade to shared.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      for (const workspace of ["scratch"]) {
        const result = await callDelegate(session, {
          tasks: [
            {
              prompt: "write marker",
              cwd: dir,
              model: subagents.spec,
              tools: ["write"],
              workspace,
            },
          ],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/not implemented|unsupported/i);
      }
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "inherited GIT_DIR redirect fails closed for a bash-capable multi-writer batch",
    async () => {
      // INVARIANTS: admission must fail closed when inherited Git redirects
      // could make a bash-capable writer escape the reserved scope.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      const previous = process.env.GIT_DIR;
      process.env.GIT_DIR = join(dir, "bogus-git-dir");
      try {
        const result = await callDelegate(session, {
          tasks: [
            {
              prompt: "first",
              cwd: dir,
              model: subagents.spec,
              tools: ["write", "bash"],
            },
            {
              prompt: "second",
              cwd: dir,
              model: subagents.spec,
              tools: ["write"],
            },
          ],
        });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/git|redirect|scope|unsafe/i);
      } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
      }
      expect(subagents.state.callCount).toBe(0);
    },
  );

  test(
    "inherited GIT_DIR does not shrink reserved scope for non-bash writers",
    async () => {
      // The Git probe must run with GIT_* scrubbed; otherwise a bogus
      // redirect makes scope discovery fail and admission would either fall
      // back to per-task cwds (missing the same-repo overlap) or reject
      // everything.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);
      const left = join(dir, "left");
      const right = join(dir, "right");
      mkdirSync(left, { recursive: true });
      mkdirSync(right, { recursive: true });

      let active = 0;
      let maxActive = 0;
      const gated: FauxResponseFactory = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        return fauxAssistantMessage("done");
      };
      subagents.respond([gated, gated]);

      const previous = process.env.GIT_DIR;
      process.env.GIT_DIR = join(dir, "bogus-git-dir");
      let result: Awaited<ReturnType<typeof callDelegate>> | undefined;
      try {
        result = await callDelegate(session, {
          tasks: [
            {
              prompt: "write left",
              cwd: left,
              model: subagents.spec,
              tools: ["write"],
            },
            {
              prompt: "write right",
              cwd: right,
              model: subagents.spec,
              tools: ["write"],
            },
          ],
        });
      } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
      }

      // Same repository scope → the writers serialize despite disjoint cwds.
      expect(result?.isError).toBe(false);
      expect(maxActive).toBe(1);
      expect(subagents.state.callCount).toBe(2);
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

  test(
    "isolated proposals reconcile into the source in task order",
    async () => {
      // v1 evidence: isolated-workspace.test.ts "captures dirty and untracked
      // source state, then applies proposals in task order"; SPEC: isolated
      // reconciles successful proposals in task order.
      session = await openDelegateBoundary();
      const subagents = await installSubagentModel(session);
      const dir = tempDir();
      gitInit(dir);

      // Pre-dispatch source state the baseline must carry without touching
      // the user's index: a dirty tracked edit, an untracked file, and a
      // staged-but-uncommitted index entry.
      writeFileSync(join(dir, "tracked.txt"), "committed");
      execSync("git add -A && git commit -qm add-tracked", { cwd: dir });
      writeFileSync(join(dir, "tracked.txt"), "dirty-edit");
      writeFileSync(join(dir, "untracked.txt"), "untracked");
      writeFileSync(join(dir, "staged.txt"), "staged");
      execSync("git add staged.txt", { cwd: dir });

      const fileA = join(dir, "a.txt");
      const fileB = join(dir, "b.txt");
      // Responses are a global FIFO across parallel workers: dispatch on the
      // prompt so either worker can win either step.
      const writeForPrompt: FauxResponseFactory = async (context) => {
        if (context.messages.some((m) => m.role === "toolResult")) {
          return fauxAssistantMessage("DONE");
        }
        const file = JSON.stringify(context.messages).includes("a.txt")
          ? "a.txt"
          : "b.txt";
        return fauxAssistantMessage([
          fauxToolCall("write", { path: file, content: file }),
        ]);
      };
      subagents.respond([
        writeForPrompt,
        writeForPrompt,
        writeForPrompt,
        writeForPrompt,
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
      expect(readFileSync(fileA, "utf8")).toBe("a.txt");
      expect(readFileSync(fileB, "utf8")).toBe("b.txt");
      // The dirty edit and untracked file survive reconciliation, and the
      // user's index still holds exactly what they staged — the baseline
      // machinery never touched it.
      expect(readFileSync(join(dir, "tracked.txt"), "utf8")).toBe(
        "dirty-edit",
      );
      expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe(
        "untracked",
      );
      expect(
        execSync("git diff --cached --name-only", { cwd: dir })
          .toString()
          .trim(),
      ).toBe("staged.txt");
    },
  );

  test(
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

      // The first provider call is gated: once it is streaming, preparation
      // has finished and the baseline is captured, so the human edit below
      // is a genuine mid-flight drift. Whichever worker calls first gets the
      // gated response — the file outcomes are identical either way.
      let workerStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        workerStarted = resolve;
      });
      let releaseWorker!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseWorker = resolve;
      });
      const gatedConflictWrite: FauxResponseFactory = async () => {
        workerStarted();
        await gate;
        return fauxAssistantMessage([
          fauxToolCall("write", {
            path: "conflict.txt",
            content: "worker-change",
          }),
        ]);
      };
      subagents.respond([
        gatedConflictWrite,
        fauxAssistantMessage([
          fauxToolCall("write", { path: "ok.txt", content: "ok" }),
        ]),
        fauxAssistantMessage("DONE"),
        fauxAssistantMessage("DONE"),
      ]);

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
      await started;
      // The human edits the same file mid-flight — the baseline moved.
      writeFileSync(target, "human-change");
      releaseWorker();
      const result = await dispatched;

      // The independent proposal still applied; the conflicting one did not
      // clobber the human edit, and the result explains what was retained.
      expect(readFileSync(target, "utf8")).toBe("human-change");
      expect(result.text).toMatch(/conflict|retained|recover/i);
      expect(readFileSync(join(dir, "ok.txt"), "utf8")).toBe("ok");
    },
  );
});
