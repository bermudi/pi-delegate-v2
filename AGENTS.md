# pi-delegate v2

A [Pi](https://github.com/earendil-works/pi) extension providing the
`delegate` tool: subagent dispatch, async tickets, pooled sessions, and
workspace isolation. This is a specification-first rewrite; the v1 repository
at `../pi-delegate` is the behavioral oracle.

Before implementing or changing behavior, read `SPEC.md`, `INVARIANTS.md`,
and `COMPATIBILITY.md` — they are authoritative and describe outcomes, not
mechanisms. Before migrating or writing tests, read `TEST-MIGRATION.md`.

## Stack

TypeScript (strict), Bun, TypeBox. Tests run in-process via
`@marcfargas/pi-test-harness`, which carries a local compatibility patch
(`patches/`) required until upstream supports the pinned Pi version.

## Workflow

```bash
bun install
bun test                        # pending contract tests list as (todo)
bun run typecheck
DELEGATE_RUN_PENDING=1 bun test # run pending tests for real — they should
                                # fail meaningfully on unimplemented ops
```

## Consulting v1

V1 is evidence for behavior, never a design source. When consulting it:

- extract externally observable behavior, invariants, and regression
  scenarios;
- do not copy its module boundaries, internal APIs, abstractions, globals,
  state machines, test seams, algorithms, or fixtures without independently
  justifying them for v2;
- migrated tests exercise v2 through its public boundary whenever possible.

## Tests

- Classify v1 evidence as contract, regression, or internal per
  `TEST-MIGRATION.md`; discard tests that only pin helpers, private state,
  or decomposition.
- Tests go through the registered `delegate` tool — never import production
  internals, and never add a production export solely for tests.
- Keep provenance: each migrated test cites its v1 source scenario.
- The harness must remain provider-free. Subagent models use pi-ai's `faux`
  provider via `installSubagentModel`, which assumes v2 resolves and streams
  subagent models through the parent session's model runtime.
- Contract tests whose subsystem isn't implemented use `pendingTest` and
  cite what they assert. Promote them to `test` when the behavior lands —
  or sooner if the assertions already hold.
- In tests, the session's `agentDir` is its temporary cwd, so
  `<cwd>/delegate.json` stands in for the user-global config.
- Update `TEST-MIGRATION.md`'s coverage map when migrating or promoting
  tests.

## Constraints

- No module-level mutable application state. Runtime state must have an
  explicit owner and lifetime (e.g. `TicketStore`, `AdmissionController`,
  the extension closure). Immutable constants and stateless helpers are
  fine.
- Until a subsystem is implemented it fails loudly. Scaffold errors and
  scaffold output are not the contract — `SPEC.md` is.
- Do not extend the scaffold to force a migrated test green; let it fail
  meaningfully or keep it pending.
- `INVARIANTS.md` properties are red lines: cancellation/quiescence, session
  reuse, ticket state, shared-write admission, and isolated application must
  not be weakened to make implementation easier.
