# Delegate v2 invariants

These are safety properties, not implementation suggestions.

## Cancellation and quiescence

- A session MUST NOT be returned to the pool, disposed, or have its workspace
  removed while provider, tool, compaction, or extension continuation work may
  still mutate it.
- Normal completion MUST wait until the session is idle, non-compacting, and
  event-quiet across multiple event-loop turns. `prompt()` completion or one
  quiet turn is not sufficient.
- Healthy quiescence waits MUST remain unbounded; the inactivity watchdog is
  responsible for wedged work.
- Cancelled unwind MUST be bounded (v1 default: 30 seconds). On expiry it MUST
  report abandonment and quarantine the session/workspace.
- Events or continuations appearing after cancellation MUST trigger another
  abort. Failed safety checks MUST NOT authorize cleanup.
- Cancellation is cooperative. It MUST NOT claim to stop subprocesses or roll
  back completed side effects.
- Cancellation cause precedence is parent abort, then deadline, then stall.

## Session reuse

- One lock per `sessionId` MUST cover acquire, execution, settlement, and
  commit. Same-ID calls serialize; different IDs may proceed concurrently.
- Pool checkout MUST NOT itself mutate stats or pool state.
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
- Shutdown MUST reject new inserts, abort active sessions, wait behind their
  locks, attempt every cleanup, and surface aggregate cleanup failures.
- Scratch and isolated workspaces MUST remain one-shot and MUST NOT support
  pooling or transcript resume.

## Ticket state

- Ticket terminal transition—status, completion time, error, and busy-index
  removal—MUST have one idempotent owner.
- Running and cancelling tickets remain busy; terminal tickets do not.
- Forced cancellation transitions through `cancelling`; ordinary completion of
  the workers settles it as `cancelled`.
- Shutdown cancellation settles immediately, resolves waiters, and performs no
  follow-up delivery.
- Terminal ticket status MUST NOT imply worker cleanup is complete.
  `workersSettled: false` is valid during unwind.
- Poll formatting MUST NOT cache an incomplete terminal snapshot; late worker
  results must become visible.
- Delivery failure MUST NOT undo settlement or make results unpollable.
- Wait timeout or caller abort MUST detach only that waiter.
- Pause is orthogonal to lifecycle: a paused ticket remains running and retains
  busy entries, slots, sessions, deadlines, and workspace reservations.

## Shared writes

- Admission MUST fail closed when the physical cwd/Git scope is ambiguous.
  Canonical equal, ancestor, and descendant roots overlap.
- `read`, `grep`, `find`, `ls`, and `web_search` are read-only for admission;
  unknown tools are mutating.
- Same-call overlapping shared writers MUST serialize in task order. A
  predecessor failure MUST still release its successor. Waiting happens before
  global-slot acquisition.
- Overlap with another active sync/async dispatch or quarantined task MUST
  reject, not queue. Shared/isolated overlap MUST reject.
- Inherited Git redirection with bash-capable multiple writers MUST fail closed.
- The operator-only unsafe bypass may skip admission only with a visible
  warning. It MUST NOT be exposed as a model-facing task field.
- Admission MUST NOT claim path confinement, cross-process locking, or
  protection from external processes.

## Isolated application

- Preparation MUST capture tracked, deleted, and untracked dirty baseline state
  with a temporary index, without changing the user's branch or index.
- Workers MUST run in detached worktrees. Processes rooted there MUST terminate
  before snapshot and reconciliation.
- Every successful proposal MUST be backed by a private ref and full patch
  before reconciliation.
- Proposals MUST reconcile in task order through disposable candidates. Each
  proposal is all-or-nothing; predecessor conflict MUST NOT prevent later
  independent proposals from being considered.
- Source apply MUST first revalidate the baseline and MUST use a temporary
  index. A failed apply MUST restore the baseline and preserve partial recovery
  artifacts when needed.
- Conflicts and cancellation before source apply MUST retain recoverable refs,
  patches, and worktrees. Cancellation MUST NOT apply accepted proposals.
- An abandoned worker MUST be discarded, never snapshotted or applied, and its
  cleanup MUST wait for safety confirmation.
- Source reservations persist through preparation, execution, reconciliation,
  and worker cleanup.
- A clean apply is `applied_unverified`; it MUST NOT assert semantic correctness
  or successful tests.

