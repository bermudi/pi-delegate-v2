Use when the idea is sharp and you need to nail the GH issue (+ spec if load-bearing). This is the clear mode of `plan`.

## What to write — GH issue is proposal + design + queue

Before writing, run `git status --porcelain`. If the output is not empty, stop and ask the user to commit, stash, or move that work. Do not create a queue issue from a dirty tree.

Record the output of `git rev-parse HEAD` as the base. Create and switch to `litespec/<change-name>` with `git switch -c`; stop if it already exists rather than reusing it. This branch belongs exclusively to this issue. Concurrent or unrelated work uses another branch or worktree.

1. **Proposal (why/what).** Create the issue with the `litespec` label. Top of issue body: what we're doing, why, what we're not doing. Then record both immutable ownership lines:
   ```
   Base: <sha>
   Branch: litespec/<change-name>
   ```
   `litespec-review` checks the branch and derives review scope from the base.
2. **Design (how).** Directory, lanes, key decisions — concise, not an essay.
3. **Queue — one `##` per unit.** Each unit:
   ```
   ## <one boundary or failure-policy outcome>
   Read first: <areas and rulings, not a file list — optional>
   Constraints: <what must stay true or is out of bounds — never what to edit — optional>
   Depends: <other unit heading>, <another unit heading>
   Boundary: <filesystem | process | network — when applicable>
   Done means:
   - [<clause-id>] <observable outcome>
   Scenarios:
   - [<clause-id>] <named test scenario>
   Risk cases:
   - timeout: [<clause-id>] or N/A — <reason>
   - cleanup: [<clause-id>] or N/A — <reason>
   - non-ENOENT errors: [<clause-id>] or N/A — <reason>
   - concurrency: [<clause-id>] or N/A — <reason>
   - optional configured dependencies: [<clause-id>] or N/A — <reason>
   Verify: `<command that fails without the outcome>`
   - [ ] pending
   ```
   Omit `Boundary:` and `Risk cases:` unless the unit crosses a filesystem, process, or network boundary. The `Boundary:` field takes exactly one of the closed vocabulary: `filesystem`, `process`, or `network`. Every `Done means:` clause has a unique ID and maps through `Scenarios:` to at least one named test. Applicable risk entries map to exactly one clause ID or give N/A with a concrete reason, never mixed forms.
   `Verify:` must fail for a plausible state where the outcome is missing. A `bun test` that doesn't check output is not a Verify.
   Dry-run each Verify on the base tree before filing. Honest result: non-zero (outcome or verifier missing), or green for a test run where every named file actually executed — red then comes from this unit's new tests. Red-pre shape: a unit whose exact Verify is green on base takes its red from the verifier-only commit carrying the new failing tests — an expected shape, not a smell. Confirm execution from the runner's per-file output or file count: runners silently skip named files that don't match their discovery patterns and stay green while never running them. A named file that never ran can never witness its outcomes — reshape the Verify to the entry point that executes those tests (for example a suite bootstrap).
   `Depends:` is optional, references `##` headings in the same issue, comma-separated. A unit is unblocked when all its `Depends:` units are checked `- [x]`.
   `Read first:` is optional, unique, nonempty when present. Context, not scope — prefer areas and rulings over long file lists. Omit rather than placeholder.
   `Constraints:` is optional, unique, nonempty when present. Boundaries: what must stay true or is out of bounds — never what to edit. Omit rather than placeholder. The worker owns the implementation path; don't smuggle in an edit script via Constraints.

4. **Spec if load-bearing.** If the feature is a promise that breaks things when wrong (CLI shape, API, file format), edit the applicable root contract identified by AGENTS.md — `SPEC.md`, `INVARIANTS.md`, or `COMPATIBILITY.md` — directly in the same change — not a delta. Keep to 3-5 SHALL requirements, each with a WHEN/THEN scenario.

## Rules

- One unit = one external boundary or one failure policy. Split broad demos across independent boundaries into separate units.
- Cross-check every unit outcome against earlier units in the same queue before filing: an outcome an earlier unit delivers — or is constrained to preserve — is never re-delivered; reshape it as a regression pin (the named tests are the outcome, and the Verify fails while the pin is absent) or drop the unit.
- Reconcile prose against the queue before filing: every scope or preservation sentence in the Proposal and Design prose — anything that must stay true, must not happen, or bounds the change — maps onto a unit's `Done means:` or `Constraints:`, becomes its own regression-pin unit, or is deleted. A sentence no unit enforces is a promise nothing can test; catch it here, not at closure review.
- Every outcome clause maps to a named test scenario; filesystem, process, and network units account for all five standard risks.
- One Verify per unit, and that Verify is the gate — `build` must satisfy it before claiming done.
- If building shows the contract is wrong, update the applicable root contract in the same PR. Don't force wrong code to match a stale contract.
