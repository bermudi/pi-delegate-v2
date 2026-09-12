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
