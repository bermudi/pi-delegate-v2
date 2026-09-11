# Delegate v2 compatibility contract

## Status and rule

This is the v2 rewrite boundary extracted from v1's README, schemas, ADR,
context glossary, and tests. “Preserve” means callers and operators can rely on
the semantic behavior, not identical prose, temporary paths, or rendering.

Any departure from the preserve list is a deliberate breaking change and needs
release notes and migration guidance; it must not arrive as rewrite drift.

## v2 preserves

### Calls and configuration

- The four modes, their top-level selectors, dispatch-wide `async`, canonical
  task fields, closed enum values, and batch-before-start validation described
  in `SPEC.md`.
- Defensive normalization of stringified tasks, flat task calls, string tools,
  and empty agent names.
- Top-level-only session RPC. Task-level `async` and `sessionAction`, legacy
  `action`, and model-facing unsafe-write bypasses remain rejected.
- `default`, `scout`, `coder`, and `reviewer` semantics; task-over-profile
  precedence; Markdown discovery order and first-definition wins.
- User-global `delegate.json` configuration. Project files do not become
  delegate configuration.
- Parent model/context inheritance and extension isolation, including verified
  provider-scoped exceptions and the meanings of `*` and `ro`.

### Execution and state

- Input-ordered sync results, bounded global/per-model concurrency, cooperative
  cancellation, retry accounting, and compaction-inclusive usage accounting.
- Live process-local sessions keyed by `sessionId`; durable recovery through
  explicit `.jsonl` `resumeFrom`, not automatic pool recovery after restart.
- Frozen session configuration, same-ID serialization, insert-on-success,
  explicit close, and parent-shutdown cleanup.
- Async fire-and-forget tickets, poll/wait/cancel/pause/resume behavior,
  idempotent settlement, retained results, and session-tree leaf-aware delivery.
- Pause as a cooperative boundary between tasks/model turns—not OS process
  suspension—and continued counting of explicit deadlines.

### Workspaces and safety

- `shared` edits the source tree; `scratch` discards a reflink copy;
  `isolated` reconciles Git proposals. Scratch and isolated remain one-shot and
  are not advertised as security boundaries.
- Fail-closed shared-write admission, canonical overlap rules, unknown tools as
  writers, same-call serialization, cross-call rejection, and the
  operator-only warned escape hatch.
- Isolated preservation of dirty/untracked baseline state and the user's
  branch/index; task-order, all-or-nothing application; retained conflict and
  cancellation artifacts; `applied_unverified` wording.
- The quiescence and quarantine guarantees in `INVARIANTS.md`.

### Signals and data

- Actionable errors that preserve the relevant correction, even if wording
  changes.
- Aggregate usage on synchronous tool results where supported. Async delivered
  messages still cannot add usage to the parent total.
- Fail-open telemetry that never stores prompt/output content, with stable
  call/task outcome meaning and explicit migration or versioning for existing
  databases.

## v2 intentionally may change

The rewrite may change without compatibility ceremony:

- module boundaries, internal interfaces, types, data structures, dependency
  injection, and concurrency implementation;
- generated bundle layout and build plumbing;
- Pi-version adapters and host-compatibility checks;
- TUI component structure, refresh strategy, and non-semantic visual details;
- ticket identifier format, temporary directory names, and recovery artifact
  paths, provided identifiers remain opaque and artifacts remain discoverable;
- exact error/help/status prose, provided it stays actionable and does not lose
  a semantic distinction;
- telemetry tables and storage internals, provided existing data is migrated or
  explicitly versioned rather than silently lost.

This contract does **not** pre-authorize changed defaults, removed normalization,
weaker cancellation or workspace guarantees, different ticket delivery,
different session persistence, or a broader extension trust boundary. Those
would be intentional public API changes, not implementation freedom.
