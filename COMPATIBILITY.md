# Delegate v2 compatibility contract

## Status and rule

This is the v2 rewrite boundary extracted from v1's README, schemas, ADR,
context glossary, and tests. “Preserve” means callers and operators can rely on
the semantic outcome.

V1 implementation details are explicitly non-binding. Its module boundaries,
algorithms, event-loop heuristics, timeout constants, lock structure, ticket
state machinery, temporary-index strategy, worktree/ref/patch representation,
database layout, and test seams do not become v2 requirements merely because
they were necessary in v1.

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
  provider-scoped exceptions and the meanings of `*` and `ro`, subject to the
  model-allowlist departure below.

### Execution and state

- Input-ordered sync results, bounded global/per-model concurrency, cooperative
  cancellation, retry accounting, and compaction-inclusive usage accounting.
- Live host-lifetime sessions keyed by `sessionId`; durable recovery through
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
- The safe-reuse, safe-cleanup, and quarantine outcomes in `INVARIANTS.md`;
  v1's quiescence-barrier algorithm is not preserved.

### Signals and data

- Actionable errors that preserve the relevant correction, even if wording
  changes.
- Aggregate usage on synchronous tool results where supported. Async delivered
  messages still cannot add usage to the parent total.
- Fail-open telemetry that never stores prompt/output content, with stable
  call/task outcome meaning and explicit migration or versioning for existing
  databases.

## v2 deliberate breaking changes

Departures from the preserve list above. Each must carry its own motivation
and migration guidance; none may arrive as silent rewrite drift.

- **Task `model` field removed; models are user-configured only.** V1
  resolved any registry-resolvable model reference (including
  `:thinking`-suffixed ones) the caller cared to type, letting a subagent
  spend on any model in the registry — and callers are reliably bad at
  picking models (stale training-data names, wrong cost tier). V2 tasks
  carry no model selection at all: a task runs on the parent's model, or on
  the model the user assigned its agent under `"models"` in the user-global
  `delegate.json` (object: agent name or `"default"` → reference; `"default"`
  covers inline tasks). A task `model` field is rejected before tasks start
  with guidance toward the config; a configured reference that does not
  resolve in the session's registry fails the same way, naming the entry.
  Migration: move any per-task model choice into `delegate.json`
  `"models"` (e.g. `{"default": "anthropic/claude-haiku-4-5",
  "scout": "google/gemini-2.5-flash"}`); callers stop sending `model`. The
  model-failure recovery hint now addresses the operator, not the caller.

## v2 intentionally may change

The rewrite may change without compatibility ceremony:

- module boundaries, internal interfaces, types, data structures, dependency
  injection, locking, scheduling, and concurrency implementation;
- cancellation detection, completion proofs, cleanup strategy, retry machinery,
  and all internal timeout values, provided the documented outcomes hold;
- ticket state representation, transition ownership, busy tracking, retention
  implementation, and delivery plumbing;
- session materialization and pooling architecture, including the v1
  policy/materialization module seam, provided reuse behavior remains compatible;
- isolated-workspace mechanics, including whether v2 uses temporary indexes,
  detached worktrees, refs, patches, or another recoverable transactional design;
- generated bundle layout and build plumbing;
- Pi-version adapters and host-compatibility checks;
- TUI component structure, refresh strategy, and non-semantic visual details;
- ticket identifier format, temporary directory names, and recovery artifact
  paths, provided identifiers remain opaque and artifacts remain discoverable;
- exact error/help/status prose, provided it stays actionable and does not lose
  a semantic distinction;
- telemetry tables and storage internals, provided existing data is migrated or
  explicitly versioned rather than silently lost;
- tests and test seams. V1 tests are evidence for behavior, not an API that v2
  must reproduce.

This contract does **not** pre-authorize changed defaults, removed normalization,
weaker cancellation or workspace guarantees, different ticket delivery,
different session persistence, or a broader extension trust boundary. Those
would be intentional public API changes, not implementation freedom.

## Test migration policy

Do **not** port the v1 test suite wholesale. Its regression knowledge is useful;
its decomposition is not a v2 contract. Before reimplementation, classify each
v1 test by purpose:

1. **Contract tests** cover behavior promised by `SPEC.md`: accepted calls,
   validation, results, sessions, tickets, workspaces, usage, and other
   caller-visible effects. Reimplement these against v2's public tool boundary.
2. **Regression tests** reproduce a real failure that could violate the public
   contract or an invariant. Preserve the scenario and expected outcome, but
   reimplement it through the public boundary rather than carrying over v1
   fixtures, mocks, call sequences, or helper assumptions.
3. **Internal tests** exist only to validate a v1 helper, module boundary,
   intermediate representation, private state transition, or decomposition.
   Delete them. Add new internal tests only when v2's own design warrants them.

Tests should assert observable results and effects: returned tool content,
ticket/session behavior, filesystem state, preserved user Git state, resource
availability, emitted usage, and actionable failure. They should not assert
which v1 helper was called, the shape of private state, exact internal event
ordering, or a particular cleanup/reconciliation mechanism.

The old suite is a source catalogue for discovering cases, not code to copy and
not a coverage target. Similar test counts, file names, fixtures, and line
coverage are explicitly not compatibility goals.
