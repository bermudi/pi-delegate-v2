---
name: litespec-build
description: Implement one GH issue unit at a time, satisfying Done means and Verify. Use when the user wants to build, implement a unit, fix review findings, or says 'build', 'implement', or 'fix'.
---

You implement one GH issue unit at a time. One unit, one Verify, stop.

**IMPORTANT: You are an implementer, not a designer.** Turn clear units into working code. Don't invent scope, don't refactor beyond the unit, don't guess. Reversible local choices are yours; if a consequential trade-off is unclear — pause and ask (see Decisions and blockers).

---

## Setup

Read the GH issue body (or `specs/queues/<name>.md` from `plan[clear]` when `gh` is unavailable), `specs/product.md`, relevant `specs/<feature>/spec.md`, `specs/decisions/`, `specs/glossary.md`, and the code the unit touches. Treat `Done means:`, `Scenarios:`, `Boundary:`, `Risk cases:`, and `Verify:` as fixed contract fields. Do not add, remove, rename, or remap clause IDs, scenario mappings, boundary declarations, or risk cases.

If the queue has no `## <outcome>` with `Done means:`/`Verify:`, stop — ask to run `plan` first.

Read the queue's `Branch:` line and compare it with `git branch --show-current`. If either is missing or they differ, stop — never build a queue issue on another branch. Every commit and working-tree change on the recorded branch belongs to this issue; unrelated work uses another branch or worktree.

---

## One unit per session

1. Fetch the current issue body and comments. Give each unit a stable identity: its exact `##` heading plus its positive 1-based occurrence among units with that exact heading. Occurrence counts identical headings within one issue; it is not a unit index; different headings are each occurrence 1. Scan comments oldest to newest. A valid rebuild request is exactly:
   ```text
   Rebuild request:
   Unit occurrence: <positive integer>
   Unit heading: <exact heading>
   ```
   It is unresolved until a later comment begins with the same `Unit occurrence:` and `Unit heading:`, followed by `Evidence:`, and contains a complete evidence receipt for that unit's exact `Verify:`. One later complete receipt resolves all earlier requests for that identity. A structured `Amendment:` record (authored only by plan) is likewise an unresolved request for its post-amendment identity; your fresh identity-bearing receipt resolves it when its `unit digest:` equals the amendment's `New digest:` — confirm with `litespec digest --issue <N>` before posting. Reject malformed requests, identities that do not resolve to exactly one body unit, and malformed identity-bearing receipts as visible boundary failures; do not guess.
   An unresolved `Re-plan required:` marker makes that contract unavailable to build. Stop and route it to `litespec-plan`; do not rebuild the marked contract. Only a later plan-authored amendment whose `Old digest:` equals the marker's `Unit digest:` clears the marker, and that amendment remains unresolved until fresh evidence satisfies its new digest.
2. Pick the first selectable AND unblocked unit in body order. An unchecked unit is selectable. A checked unit is also selectable when its latest request state is unresolved. A unit is unblocked when all its `Depends:` units are checked `- [x]` and have no unresolved request. Units without `Depends:` are always unblocked.
3. Require a clean tree: `git status --porcelain` must print nothing. Run the exact `Verify:` command on the clean starting commit before implementation.
   - If the verifier already exists, use the starting commit as pre.
   - If Verify cannot run because the verifier is part of the unit, create one verifier-only commit, require a clean tree, and use that commit as pre. It may contain only the test or other verifier, never the outcome. Keep it green under the project's standard compile/typecheck gates where possible: when the verifier references symbols that do not exist yet, add a loud stub (the symbol exists and every entry point fails fast with an explicit not-implemented error) so gates pass while the pre run still fails for the absent outcome. If a stub would turn the pre run green, the verifier is too weak — fix the verifier, do not soften the stub.
   - Red-pre shape: a unit whose exact Verify is green on base — refactor and regression-pin outcomes — takes its red from the verifier-only commit carrying the new failing tests. That is the expected shape, not a smell.
   - The pre run must exit non-zero; Verify fails because the unit outcome is absent. If it exits 0, or fails because of an unrelated command, dependency, or environment error, stop. Do not implement or check the unit.
   - Save the full pre SHA, integer exit status, and raw output exactly as emitted.
4. Implement the unit — the smallest coherent change. Extend the existing path, don't add a parallel one. No speculative abstraction. If the unit is a contract change, update `specs/<feature>/spec.md` now.
5. Create one or more implementation/fix commits for the unit. Keep every commit after pre immutable: fix failures in a new commit, never by amending.
6. Require a clean tree again. Run the same exact `Verify:` command. It must exit 0 with the outcome present. Post is the final clean commit where `Verify:` passes; save its full SHA from `git rev-parse HEAD`, exit status, and raw output.
7. Record one receipt — verbatim, not interpretive (see Verification). Newly assembled receipts declare `Protocol: evidence/v2` and fit one 8192-byte comment; required fields, in this order:
   - for a checked GitHub rebuild, `Unit occurrence: <n>`, `Unit heading: <exact heading>`, and `Evidence:`; otherwise the unit heading and `Evidence:` block
   - immediately after `Evidence:`, `Protocol: evidence/v2`
   - `Digest algorithm: unit-contract-sha256-v1`
   - `Receipt ID: receipt-sha256-v2:<64 lowercase hex>` — the lowercase SHA-256 of the canonical bounded logical receipt with this ID field omitted; include protocol, algorithm, optional recovery reference, routing identity, Verify, unit digest, per-run commit sha, exit status, byte count, full-output SHA-256, excerpt text, and scope lines; the full output participates only through its byte count and hash
   - optional `Recovered from: <receipt ID>` only when preserving provenance for an earlier complete receipt; it may name any retained receipt ID, including v1
   - exact `Verify:` command
   - `unit digest: <64 lowercase hex>` — run `litespec digest --issue <N>` (or `--queue <path>`) and paste the line whose heading and occurrence match this unit; status checkbox and Evidence content are excluded from the digest. Validate recomputes it from the current body: a missing or wrong digest is an error, so an edit to `Done means:` or `Verify:` after evidence is recorded fails validation.
   - `pre sha: <full 40- or 64-char hex>`
   - `pre exit status: <non-zero integer>`
   - one fenced block: the complete raw pre output when it fits the excerpt budget (head 2048 + tail 3072 bytes, fixed constants), otherwise the head excerpt, the literal line `... <N> bytes elided ...` (N = the exact elided byte count), and the tail excerpt; if the command emits nothing, the fence holds `<no output>`. Cuts are byte-exact and never split a rune.
   - `pre bytes: <decimal byte length of the full pre output>`
   - `pre output sha256: <SHA-256 of the full pre output>`
   - `Pre-evidence scope: this command exited <status> at <sha>; nothing else is inferred.`
   - `post sha: <full 40- or 64-char hex from git rev-parse HEAD>`
   - `post exit status: 0`
   - one fenced block for the post output under the same excerpt rule
   - `post bytes: <decimal>`
   - `post output sha256: <SHA-256 of the full post output>`
   - `Post-evidence scope: this command exited 0 at <sha>; nothing else is inferred.`
   The pre and post SHAs must differ, and pre must be an ancestor of post. A v2 receipt never continues across comments and never uses the chunk form; if identity and status fields alone exceed the budget, the receipt cannot be assembled — stop and surface the refusal.
8. Post the receipt and tick the box (`- [x]`) only after evidence is posted:
   - GH issue queue: post the receipt as one issue comment. Prefer `litespec receipt` to assemble (and, on request, post) it; hand-assembly in the shape above stays valid. The continuation marker and `Raw output chunk:` forms remain valid only for retained receipts declaring `evidence/v1` or the legacy shape — never emit them for a new receipt. For an initially unchecked unit, then check its box in the issue body. For a checked rebuild, leave the issue body and prior comments unchanged; the fresh identity-bearing receipt resolves its requests.
   - Local queue file (`specs/queues/<name>.md`): append the receipt as an `Evidence:` block under the unit (after `Verify:`, before the status checkbox), then check the box. Commit this queue-file bookkeeping as a separate metadata commit—it cannot be folded into the implementation commit because the receipt records the post SHA.
   A nonempty `Evidence:` label is not a receipt. Validate rejects missing fields, short or equal SHAs, an empty fence, a current-digest receipt whose command does not match `Verify:` verbatim, a missing or malformed `unit digest:`, an unchained superseded digest, a zero pre status, or a non-zero post status. For `evidence/v2` it also enforces the bounds: reconstruction arithmetic (head plus elided plus tail equals the declared byte count), hash-matched unelided fences, one comment within the 8192-byte budget, and refusal of continuation and chunk forms. A complete superseded receipt is checked against its own declared command and digest before amendment-chain validation.
9. Never amend either recorded evidence commit. Subsequent fixes go in a new commit.
10. Stop. Tell the user this unit is done and they can re-invoke build for the next.

No batching units. At most one verifier-only commit, then one or more implementation/fix commits, then stop.

---

## Rebuilding a unit after review

If a checked GitHub unit has an unresolved rebuild request, or a local unit was unchecked by review after a CRITICAL or WARNING against its `Done means:` or `Verify:`, you are rebuilding — not starting fresh. Review owns that routing metadata. Do not ask the user to edit a checkbox. The previous Verify failed to prove the outcome. Load `references/review-fixing.md` and follow its scope-expansion rules: find the abstract pattern behind the finding, fix all instances, not just the cited `file:line`. Then follow the same red-green order as above. The exact Verify must fail for the missing fix at a clean pre commit before you create one or more implementation/fix commits. Record a fresh pre/post receipt. For GitHub, include the request's exact occurrence and heading so the receipt resolves every earlier request for that identity without editing the body. For a local queue, re-check the affected box in the separate metadata commit. Never amend a prior evidence commit.

---

## Verification

- Run the narrowest credible Verify first, then `go vet`/`go test ./...` if relevant.
- Report exactly what passed and what remains unverified. A passing command proves only what it exercises.
- Evidence protocol: the worker that ticks a unit box records one exact command at two immutable clean commits — non-zero pre because the outcome is absent, then zero post with the outcome present. Keep both raw outputs. NEVER narrate what the command "proves" in prose. Red-green evidence shows only that Verify distinguishes those trees; it does not prove that Verify targets the correct behavior. Review makes that judgment and replays pre, post, and `HEAD`.
- If the unit is a contract change, update `specs/<feature>/spec.md` in the implementation commit — don't force wrong code to match a stale spec.

---

## Knowledge gaps

When you hit a novel API or unfamiliar library, pause to gather docs. You MAY write `.agents/skills/research-<topic>/SKILL.md` as a persisted reference. This is inline, not a separate phase. Skip when you know it cold.

---

## Decisions and blockers

Reversible local choices are worker-owned — naming, helper placement within the module, test structure, error messages, small refactors that don't change contracts. Decide alone, don't interrupt.

A novel consequential trade-off is different: new public surface, persistence shape, security boundary, cross-module contract, cost/latency trade-off, or anything that would deserve a decision in `specs/decisions/`. Present it to the human interactively, or report a blocker if headless/batch unless authority was delegated. The human decides; you record only after acceptance via `specs/decisions/NNNN-<slug>.md` (`spine: true` if load-bearing) — never promote a preference into an accepted decision.

If the unit is ambiguous or the Verify is weak and the gap is consequential, pause and ask. If it's a reversible local detail, pick the simplest coherent option and note it in the commit.

---

## Guardrails

- At most one verifier-only commit and one or more implementation/fix commits per unit. Local-queue bookkeeping (Evidence block + checkbox) is a separate metadata commit.
- Never amend the pre commit or any implementation/fix commit. Post is the final clean commit where `Verify:` passes.
- Don't refactor beyond the unit — note drive-bys, don't fix them.
- If the GH issue needs re-shaping, pause — don't rewrite planning artifacts yourself.

---

## References

`references/review-fixing.md` — load when rebuilding a unit that review routed back to build. Scope-expansion rules: fix the pattern, not just the cited line.
`specs/glossary.md` — consult for terms after a unit. No enforcement.

