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
