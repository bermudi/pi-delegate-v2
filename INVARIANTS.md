# Delegate v2 invariants

These are externally meaningful safety properties, not a prescription for
recreating v1. References to v1 mechanisms—including event counters,
quiescence barriers, locks, controllers, indexes, temporary Git indexes,
private refs, worktrees, and timeout constants—are intentionally absent. V2 may
use any design that makes these properties true and testable.

## Cancellation and quiescence

- A session MUST NOT be returned to the pool, disposed, or have its workspace
  removed while provider, tool, compaction, or extension continuation work may
  still mutate it.
- Apparent request completion MUST NOT be treated as proof that deferred
  provider, tool, compaction, or extension work has stopped.
- Healthy long-running cleanup MUST NOT be misclassified as cancellation merely
  because it exceeds an internal fixed duration.
- Cancelled work MUST eventually produce a caller-visible outcome even when
  termination cannot be confirmed. In that case its resources remain
  quarantined.
- Work that restarts or continues after cancellation MUST remain cancelled and
  MUST NOT make its resources eligible for reuse. Failed safety checks MUST NOT
  authorize cleanup.
- Cancellation is cooperative. It MUST NOT claim to stop subprocesses or roll
  back completed side effects.
- Cancellation cause precedence is parent abort, then deadline, then stall.

## Session reuse

- Same-ID calls MUST serialize across acquisition, execution, and final state
  update; different IDs may proceed concurrently. No particular locking
  strategy is required.
- A pooled session's cwd, tools, thinking, model, base prompt, and provider
  extension configuration MUST be frozen. Tool comparison is order-independent.
  Explicitly incompatible reuse MUST fail.
- Fresh or resumed sessions enter the pool only after a successful,
  non-cancelled, non-stalled run and only when a durable session file exists.
- A pooled session cancelled, stalled, or deadline-exceeded after prompting
  MUST be evicted. A deadline before prompting may leave it intact and MUST
  record no usage.
- Ordinary provider/task failure on an existing pooled session remains
  reusable and its attempt usage is recorded.
- A late materialization after cancellation MUST NOT be prompted or pooled.
- Shutdown MUST reject new reusable sessions, request termination of active
  sessions, avoid racing their state updates, attempt every cleanup, and surface
  cleanup failures.
- Scratch and isolated workspaces MUST remain one-shot and MUST NOT support
  pooling or transcript resume.

## Ticket state

- Ticket terminal state MUST be internally consistent and idempotent regardless
  of racing completion, cancellation, and shutdown.
- Running and cancelling tickets remain unavailable for conflicting work;
  terminal tickets do not.
- After forced cancellation begins, later worker completion MUST NOT turn the
  ticket into a successful completion.
- Shutdown cancellation settles immediately, resolves waiters, and performs no
  follow-up delivery.
- A terminal cancellation response MUST NOT falsely imply that unsafe worker
  cleanup has completed. Later safe-to-expose results must remain visible.
- Delivery failure MUST NOT undo settlement or make results unpollable.
- Wait timeout or caller abort MUST detach only that waiter.
- Pause is orthogonal to lifecycle: a paused ticket remains running and retains
  its sessions, deadlines, workspace reservations, and protection against
  conflicting work.

## Shared writes

- Admission MUST fail closed when the physical cwd/Git scope is ambiguous.
  Canonical equal, ancestor, and descendant roots overlap.
- `read`, `grep`, `find`, `ls`, and `web_search` are read-only for admission;
  unknown tools are mutating.
- Same-call overlapping shared writers MUST serialize in task order. A
  predecessor failure MUST still allow its successor to run. Serialization
  MUST NOT consume scarce execution capacity while no task can execute.
- Overlap with another active sync/async dispatch or quarantined task MUST
  reject, not queue. Shared/isolated overlap MUST reject.
- Inherited Git redirection with bash-capable multiple writers MUST fail closed.
- The operator-only unsafe bypass may skip admission only with a visible
  warning. It MUST NOT be exposed as a model-facing task field.
- Admission MUST NOT claim path confinement, cross-process locking, or
  protection from external processes.

## Isolated application

- Preparation MUST capture tracked, deleted, and untracked dirty baseline state
  without changing the user's branch or index.
- Each worker MUST be isolated from other workers' ordinary relative writes.
  Worker activity MUST terminate before its output is accepted for application.
- Every successful proposal MUST have a durable recovery representation before
  reconciliation.
- Proposals MUST reconcile in task order. Each proposal is all-or-nothing;
  predecessor conflict MUST NOT prevent later independent proposals from being
  considered.
- Source apply MUST first verify that its baseline assumptions still hold and
  MUST leave the user's index and branch unchanged. A failed apply MUST restore
  the baseline and preserve recovery artifacts when needed.
- Conflicts and cancellation before source apply MUST retain discoverable,
  recoverable proposal artifacts. Cancellation MUST NOT apply accepted
  proposals.
- An abandoned worker MUST be discarded, never snapshotted or applied, and its
  cleanup MUST wait for safety confirmation.
- Source reservations persist through preparation, execution, reconciliation,
  and worker cleanup.
- A clean apply is `applied_unverified`; it MUST NOT assert semantic correctness
  or successful tests.
