# V1 test migration

The v1 suite is evidence, not source material. Tests are rewritten against the
registered `delegate` tool; they do not import implementation helpers.

## Classification

- **Contract** — proves behavior promised by `SPEC.md`.
- **Regression** — preserves a previously observed public failure scenario.
- **Internal** — proves only v1 helper behavior, decomposition, private state,
  rendering implementation, or an exact algorithm. Do not migrate.

When one v1 test mixes categories, extract only the public scenario. Do not
copy its fixtures, mocks, call graph, or intermediate assertions.

## Conventions

- `pendingTest` (`tests/support/pending.ts`) marks a migrated test whose
  contract needs unimplemented subsystems. Pending tests compile and
  typecheck, list as `(todo)` under `bun test`, and run for real with
  `DELEGATE_RUN_PENDING=1 bun test`, where they are expected to **fail
  meaningfully** against the scaffold's not-implemented boundary. Promote a
  pending test to `test` when its subsystem lands — or earlier, if its
  assertions already hold (two were promoted in the second tranche).
- `installSubagentModel` (`tests/support/pi-boundary.ts`) registers pi-ai's
  built-in `faux` provider on the test session's `modelRuntime`, giving tasks
  a provider-free model selectable through the public `model` task field.
  This encodes a testability assumption for v2: subagent model resolution and
  streaming must route through the parent session's model runtime/registry
  (which `default`-profile parent-model inheritance needs anyway). If v2 ends
  up creating subagent sessions on a different runtime, update the support
  layer — not the tests.
- The harness session's `agentDir` is its temporary cwd, so
  `<cwd>/delegate.json` stands in for the user-global config file.
- Assertions target observable outcomes (result text/isError/details, ticket
  status wording, filesystem effects, provider call counts), never v1 prose
  or internal state. Exact ticket-id format and wording stay loose on
  purpose.

## Coverage map

Per subsystem: contract behaviors, regression scenarios carried forward,
internal-only v1 tests discarded, what v2 tests already represent, and known
gaps.

### Input recovery and mode validation

- **Contract:** four-mode selection after normalization; mode exclusivity;
  closed enums; batch validated before any task starts; actionable errors.
- **Regression:** stringified/flat/task-string normalization; task-level
  `async`/`sessionAction` silently degrading; `workspace:"none"` misparse;
  orphaned ticket fields producing help.
- **Internal:** direct calls to `normalizeDelegateArguments` /
  `validateDelegateOperation`; exact error wording; description-length
  budgets.
- **Covered now:** help for omitted/empty tasks; orphaned-field rejection;
  enum rejection; task-level control-field rejection; task-id charset;
  stringified/flat/tools recovery; ticket/session intent never folded into
  tasks; flat fields never merged into an explicit task array.
- **Pending:** duplicate task/session ids; non-positive `deadlineMs`;
  scratch/isolated + `sessionId`/`resumeFrom`; mixed-mode conflict wording;
  prompt-less task without resume; unknown agent guidance; required-field
  messages for ticket/session RPC.
- **Gap:** model-reference resolution errors (unknown/unauthenticated model)
  and corrective-hint wording depth are unasserted.

### Synchronous dispatch

- **Contract:** sync default; input-ordered per-task results; per-task
  outcomes; aggregate usage where the host supports it; caller task ids
  echoed for correlation.
- **Regression:** failed task does not fail siblings or destroy index
  alignment; partial output/usage/touched files preserved on failure.
- **Internal:** `formatCompletedTask`/`formatFailedTask` rendering, header
  markers, `fmt*`/`trunc*` helpers, touched-file extraction helpers.
- **Pending (migrated):** ordered results; sibling failure isolation; task-id
  echo; aggregate usage on the tool result.
- **Gap:** parent-abort of a sync call (harness cannot yet interrupt an
  in-flight tool call); deadline/stall outcomes visible in result text;
  overlap warnings on results.

### Multi-task / concurrent dispatch

- **Contract:** bounded global and per-model concurrency; order independent
  of completion order; queued tasks hold no execution resources.
- **Regression:** abort wakes queued tasks without waiting for a slot; a
  gated successor waits without holding a global slot.
- **Internal:** `mapConcurrent*` helpers; `reconfigureGlobalConcurrency`
  mechanics.
- **Pending (migrated):** configured bound limits simultaneous subagent work
  (measured through the faux provider's live call tracking).
- **Gap:** per-model/per-provider limits; abort-of-queued behavior; dynamic
  limit changes.

### Async tickets

- **Contract:** `async: true` returns a ticket immediately; auto-delivery;
  poll roster and single-ticket views; wait blocks to settlement or timeout;
  tickets stay pollable after settlement; not-found semantics.
- **Regression:** cancelled tickets retain partial results with index
  alignment; a late worker cannot flip a cancelled ticket to done; wait
  timeout/abort detaches only that waiter; delivery failure never unsettles.
- **Internal:** ticket id generation, TTL sweeping, roster/format string
  composition, busy-index internals, waiter plumbing.
- **Pending (migrated):** empty roster; unknown-ticket handling for all
  actions; wait-to-settlement; timeout detach; cancel preview vs force;
  cancelled-ticket retains completed results; pause/resume.
- **Gap:** leaf-aware delivery after session-tree navigation (needs
  harness-level session-tree control); delivered-result suppression when a
  waiter already consumed it; progress/onUpdate frames; roster wording
  details.

### Cancellation

- **Contract:** preview unless `force`; cooperative; never claims rollback or
  subprocess termination; cause precedence parent-abort > deadline > stall;
  cancelled work must still produce a caller-visible outcome; unsafe-to-clean
  resources stay quarantined.
- **Regression:** cancellation during prompt/turn produces structured
  cancellation (not provider-error text); completed writes survive.
- **Internal:** quiescence-barrier internals, unwind budgets, settle-path
  plumbing.
- **Pending (migrated):** cancel preview/force and retained results.
- **Gap:** parent-abort and deadline/stall causes (need in-flight abort and
  wall-clock control at the boundary); quarantine visibility after unsafe
  cancellation.

### Pause / resume

- **Contract:** cooperative boundary between tasks and model turns; paused
  ticket stays running and keeps sessions, deadlines, and reservations.
- **Regression:** resume-then-repause cannot leak a waiting operation; a
  naturally final turn completes instead of parking; parked time is not
  inactivity while wall-clock deadlines still apply.
- **Internal:** checkpoint machinery, `Agent.subscribe` gating, parked
  listener bookkeeping.
- **Pending (migrated):** pause holds queued work; paused ticket remains
  running; resume continues to settlement.
- **Gap:** mid-turn pause semantics (current turn finishes); deadline-during-
  pause; pause unavailability on terminal tickets.

### Session reuse and lifecycle

- **Contract:** `sessionId` pools a live session for host lifetime; same-id
  serializes; frozen cwd/tools/thinking/model/base-prompt/extension config;
  insert-on-success; `resumeFrom` rehydrates and may then pool; `close`
  disposes; `list` reports live sessions; shutdown cleans up.
- **Regression:** frozen-config mismatch is an actionable rejection; missing
  `resumeFrom` transcript errors; busy sessions (including cancelling
  tickets) reject conflicting reuse; cancelled/stalled pooled sessions are
  evicted; pre-prompt deadline leaves the pooled session intact with no
  usage; late materialization after cancellation is never prompted or pooled.
- **Internal:** pool map/locks, config cloning, quarantine registry, session
  file bookkeeping.
- **Pending (migrated):** pool + list + continuation; close then fresh;
  frozen-config rejection; missing-transcript error; busy-ticket conflict.
- **Gap:** eviction after cancelled/stalled/deadline-exceeded runs;
  `resumeFrom` happy path (needs a real `.jsonl` transcript fixture);
  shutdown cleanup; usage recorded for ordinary failures on pooled sessions.

### Admission and shared writes

- **Contract:** fail closed on ambiguous Git/cwd scope; canonical equal /
  ancestor / descendant roots overlap; `read`, `grep`, `find`, `ls`,
  `web_search` are read-only; unknown tools count as mutating; same-call
  overlapping writers serialize in task order; overlap with active or
  quarantined work rejects; shared/isolated overlap rejects; operator-only
  warned bypass.
- **Regression:** symlink canonicalization; inherited `GIT_DIR`/
  `GIT_COMMON_DIR`/`core.worktree` redirection fails closed with bash-capable
  writers; nested repositories reject; path-prefix siblings are not nested;
  a predecessor failure does not block a serialized successor.
- **Internal:** `findSharedWriteConflicts` grouping internals, canonical-path
  helpers.
- **Pending (migrated):** same-call writer serialization order; cross-call
  rejection against a running ticket (including no-work-started); shared +
  isolated same-call rejection.
- **Gap:** read-only + writer parallelism allowed; unknown-but-real tools
  treated as mutating; operator bypass warning surfaces; scratch suggestion
  in rejection prose.

### Scratch workspaces

- **Contract:** one-shot; disposable copy; changes discarded; no `sessionId`
  or `resumeFrom`; relative-write protection only; actionable setup-failure
  remedy.
- **Regression:** stale-lease cleanup races; symlink escape rejection;
  nested-Git and linked-worktree rejection; setup failure appends the
  `workspace:"shared"` remedy.
- **Internal:** lease layout/markers, sweep mechanics, copy strategy.
- **Pending (migrated):** discarded mutations never reach the source tree.
- **Gap:** setup-failure remedy wording; unsupported-tree rejections
  observable at the boundary; cleanup-safety properties are internal by
  nature.

### Isolated workspaces

- **Contract:** one-shot Git isolation; baseline (dirty/untracked) and the
  user's index/branch preserved; task-order all-or-nothing reconciliation;
  conflicts and pre-apply cancellation retain recoverable artifacts;
  `applied_unverified` never claims correctness; worker activity ends before
  output is accepted.
- **Regression:** source changed mid-execution refuses apply; failed workers
  are discarded; abandoned workers are never snapshotted or applied;
  proposals with no changes leave nothing behind.
- **Internal:** temporary-index strategy, private refs, patch representation,
  candidate-worktree mechanics.
- **Pending (migrated):** ordered apply of two proposals with
  `applied_unverified` wording; conflict retains artifacts without clobbering
  a human edit while an independent proposal still applies.
- **Gap:** cancellation before apply retains proposals and applies nothing;
  binary/symlink/mode reconciliation; baseline-drift refusal; worker-process
  termination guarantees.

### Failure propagation and retries

- **Contract:** transient failures may retry; model/account failures do not
  blindly retry on the same model and hint at a different model; exhausted
  retries return the last error; validation failure starts no tasks.
- **Regression:** retry accounting stays aligned on abort during backoff;
  observed bash activity suppresses whole-task retry; result text preserves
  the model-swap hint.
- **Internal:** `isModelAttributableError`, retry-gating internals, backoff
  timing.
- **Pending (migrated):** transient retry to success; model-attributable
  no-retry + model hint; serialized successor after predecessor failure;
  batch validation starts nothing.
- **Gap:** retry-count visibility in results; stall/deadline structured
  outcomes vs retries.

### Telemetry and observable events

- **Contract:** usage on synchronous results; async delivered results never
  add usage; telemetry is fail-open and never stores prompt/output content;
  externally visible signals (ticket roster/poll text, status surfaces) stay
  meaningful.
- **Internal:** SQLite layout, sweep cadence, record-once mechanics — all
  free to change; only privacy and outcome-meaning are contract.
- **Pending (migrated):** aggregate usage present on the sync tool result.
- **Gap:** async-no-usage property; the privacy property is only assertable
  once v2 chooses its telemetry surface; TUI/status rendering is
  intentionally out of scope for boundary tests.

## First tranche

| V1 evidence | Class | V2 treatment |
| --- | --- | --- |
| `delegate.test.ts`: extension registration and parameter surface | Contract | Rewritten in `tests/contract/tool-boundary.test.ts` |
| `delegate.test.ts`: empty-call help mode | Contract | Rewritten in `tests/contract/tool-boundary.test.ts`; asserts meaning, not exact manual copy |
| `schema.test.ts`: stringified tasks, flat fields, and string tools | Regression | Rewritten in `tests/regression/input-recovery.test.ts` through Pi's full registered-tool execution path |
| `schema.test.ts`: empty agent becomes inline | Regression | Deferred until agent resolution makes the effective profile observable |
| `schema.test.ts`: ticket/session intent must not become a task | Regression | Rewritten in `tests/regression/input-recovery.test.ts` |
| `schema.test.ts`: direct calls to normalizer/validator helpers | Internal | Not ported |
| `delegate.test.ts`: exact description lengths and wording | Internal | Not ported |
| `delegate.test.ts`: barrel exports and helper behavior | Internal | Not ported |
| `schema.test.ts`: orphaned ticket fields and async-without-tasks | Contract | Rewritten in `tests/contract/tool-boundary.test.ts` |

## Second tranche

| V1 evidence | Class | V2 treatment |
| --- | --- | --- |
| `schema.test.ts`/`delegate.test.ts`: enum, control-field, and id rejection | Contract | Live tests in `tests/contract/validation.test.ts` |
| `schema.test.ts`/`task-resolution.test.ts`: semantic validation (duplicates, deadlines, workspace conflicts, mode mixing, unknown agent, required fields) | Contract | Pending tests in `tests/contract/validation.test.ts` |
| `lifecycle.test.ts`/`dispatch.test.ts`: ordered sync results, sibling failure isolation, task-id echo, usage, async ticket return, concurrency bound | Contract | Pending tests in `tests/contract/dispatch.test.ts` |
| `delegate.test.ts`/`pause.test.ts` ticket integration: roster, not-found, wait, timeout detach, cancel preview/force, retained results, pause/resume | Contract + Regression | Pending tests in `tests/contract/tickets.test.ts` |
| `lifecycle.test.ts` pool/session tests: pooling, list, close, frozen config, `resumeFrom` errors, busy conflicts | Contract + Regression | Pending tests in `tests/contract/sessions.test.ts` |
| `dispatch.test.ts`/`shared-write-safety.test.ts`/`workspace.test.ts`/`isolated-workspace.test.ts`: writer serialization, cross-call rejection, shared/isolated rejection, scratch discard, ordered apply, conflict retention | Contract + Regression | Pending tests in `tests/contract/workspaces.test.ts` |
| `lifecycle.test.ts` retry matrix and `dispatch.test.ts` serialized-successor | Regression | Pending tests in `tests/regression/failure-propagation.test.ts` |
| All helper/private-state/rendering/internals tests (see per-subsystem "Internal" rows) | Internal | Not ported |

## Next contract slices

1. Complete mode exclusivity and actionable validation failures.
2. Batch-before-start validation and input-ordered results.
3. Ticket lifecycle, wait, cancellation, pause, and leaf-aware delivery.
4. Persistent session reuse, frozen configuration, close, and shutdown.
5. Shared-write admission and same-call serialization.
6. Scratch discard and isolated all-or-nothing application.
7. Cancellation safety and unavailable/quarantined resources.
8. Usage and telemetry privacy.

Each slice should add only the public test driver capabilities it needs. Tests
must not introduce public exports solely to reach private v2 state.
