# pi-delegate v2

Specification-first rewrite of Delegate.

- `SPEC.md` defines public behavior.
- `INVARIANTS.md` defines safety outcomes.
- `COMPATIBILITY.md` defines the v1 compatibility boundary.
- `TEST-MIGRATION.md` tracks test classification and reimplementation.

```bash
bun install
bun test
bun run typecheck
```

The extension registers three sibling tools: `delegate` dispatches subagent
tasks (`tasks` required; `[]` shows the manual), `delegate_ticket` operates on
async tickets (`action`: poll/wait/cancel/pause/resume/answer), and
`delegate_session` lists and closes pooled sessions (`action`: list/close).

## Async results

`async: true` returns a ticket and automatically delivers the settled batch
result, including isolated integration outcomes. While the parent is still on
the dispatching leaf, delivery may wake it; after tree navigation the result
is appended to the current branch without waking and enters context on the
next turn, with a notice announcing it. Tickets remain pollable even if
delivery fails. Shutdown force-cancels outstanding tickets without follow-up
delivery and waits for their workers to actually stop before letting the
session end. Ticket results are saved under the agent directory and can be
polled after reload or session replacement. Unfinished tickets from an unclean
exit show as `interrupted`, never automatically restarted. Owner-only files
under `delegate-tickets/` hold full outputs and are not automatically deleted.
`operationId` deduplication and automatic delivery do not survive restart.

## Worker questions

Workers on async tickets can use `ask_parent` (as their only tool call in a
turn). The question appears in ticket polls and a parent notification. Answer
it with the ticket, task, and question identifiers shown there:

```json
{ "action": "answer", "ticket": "…", "taskId": "…", "questionId": "…", "answer": "Use the existing format." }
```

on `delegate_ticket`.

Waiting releases execution capacity, **not** the worker's workspace or
shared-write reservation. Task deadlines keep running. A parent already
waiting on the ticket is released to answer; unanswered questions are never
guessed or automatically escalated to a human. Synchronous workers cannot
ask questions.

## Parent conversation isolation (breaking change)

Tasks no longer accept `context`, including `context: "fresh"` or
`"with-parent-transcript"`. Omit it and supply a self-contained brief. Children
never inherit parent conversation history; project instructions, model
inheritance, child-owned pooled sessions and explicit `resumeFrom` still apply.

## Duplicate-safe retries

Pass `operationId` — 1–64 letters, digits, `.`, `_`, or `-` — to make a
dispatch retry-safe for the life of the session:

```json
{ "tasks": [{ "prompt": "rebuild the index" }], "operationId": "reindex-1" }
```

Repeating the call with the same id and the same request returns the
original in-flight or settled result — the sync result or the async ticket —
without running the work twice. The same id with a different request is an
error, not a second run. Results live at most one hour after settling, with
at most 256 settled operations retained; an expired or evicted id may run
fresh again. Without `operationId` identical dispatches always run
independently — there is no content deduplication and no crash/restart
exactly-once guarantee.

## Telemetry

Telemetry is off by default and writes only to a local SQLite database —
nothing is transmitted anywhere. Enable it in the user-global
`delegate.json`:

```json
{ "telemetry": { "enabled": true } }
```

The database lives at `telemetry.dbPath` when configured, else
`DELEGATE_TELEMETRY_DB`, else `<agentDir>/delegate-usage.db`. Each dispatch
pins its destination at dispatch start: if the config changes before a batch
finishes, that batch's record is dropped instead of reopening the old
database.

Rows are written only for dispatches that reach a completed batch outcome —
rejected calls and failed preparation record nothing. Recorded per batch and
per task: the batch start timestamp and wall duration, sync/async mode, task
count, terminal call status, caller-visible task status,
agent/model/thinking/tools/workspace selections, integration status, retry
count, and numeric token/cost usage. Per-task duration is not recorded in
v2; a task row whose worker could not be confirmed stopped is marked
provisional and may later be superseded in the live ticket. Never stored:
prompt, system-prompt, output, or error text; cwd or session paths; caller
task IDs; operation IDs; or parent transcript content.

Telemetry is fail-open — a database problem logs the failure and disables it
for that destination; delegation results never change. Opt back out by removing
`"enabled": true` or setting it to `false`; an existing database is then left
unopened and untouched.

Inspect the database with any SQLite client — e.g.
`sqlite3 <db> 'SELECT * FROM calls'` if `sqlite3` is installed. To move it,
point `telemetry.dbPath` or `DELEGATE_TELEMETRY_DB` at the new location. To
delete it, stop Pi first, then remove `delegate-usage.db` plus any
`delegate-usage.db-wal` and `delegate-usage.db-shm` sidecars.
