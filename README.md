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

The current implementation is only the initial public-boundary scaffold.
Dispatch is intentionally not implemented yet.

## Parent conversation isolation (breaking change)

Tasks no longer accept `context`, including `context: "fresh"` or
`"with-parent-transcript"`. Omit it and supply a self-contained brief. Children
never inherit parent conversation history; project instructions, model
inheritance, child-owned pooled sessions and explicit `resumeFrom` still apply.
