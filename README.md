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

## Async results

`async: true` returns a ticket and automatically delivers the settled batch
result, including isolated integration outcomes. While the parent is still on
the dispatching leaf, delivery may wake it; after tree navigation the result
is appended to the current branch without waking and enters context on the
next turn, with a notice announcing it. Tickets remain pollable even if
delivery fails. Shutdown force-cancels outstanding tickets without follow-up
delivery and waits for their workers to actually stop before letting the
session end. Tickets are host-lifetime only — they are not persisted across
reload or session replacement.

## Parent conversation isolation (breaking change)

Tasks no longer accept `context`, including `context: "fresh"` or
`"with-parent-transcript"`. Omit it and supply a self-contained brief. Children
never inherit parent conversation history; project instructions, model
inheritance, child-owned pooled sessions and explicit `resumeFrom` still apply.

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
