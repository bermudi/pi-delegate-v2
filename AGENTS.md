# pi-delegate v2

This is a specification-first rewrite. Read `SPEC.md`, `INVARIANTS.md`, and
`COMPATIBILITY.md` before implementation work.

## Consulting v1

The v1 repository is a behavioral oracle, not an architectural template.

When consulting v1:
- extract externally observable behavior, invariants, and regression scenarios;
- do not copy its module boundaries, internal APIs, abstractions, globals,
  state machines, test seams, algorithms, or fixtures without independently
  justifying them for v2;
- migrated tests should test v2 through its public boundary whenever possible.

## Tests

- Do not copy the v1 suite or its architecture.
- Classify v1 evidence as contract, regression, or internal using
  `TEST-MIGRATION.md`.
- Reimplement contract and regression scenarios through Pi's registered
  `delegate` tool boundary.
- Discard tests that only pin v1 helpers, private state, algorithms, fixtures,
  module seams, or decomposition.
- Do not expose production internals solely for tests.
- The test harness must remain provider-free. Its local compatibility patch is
  required until the upstream harness supports the pinned Pi version.

## Current state

Only the public tool/schema/help scaffold and the first migrated test tranche
exist. Dispatch, ticket, and session operations fail loudly as unimplemented;
do not mistake that scaffold behavior for the final contract.
