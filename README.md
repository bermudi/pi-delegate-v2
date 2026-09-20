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
