---
name: litespec-review
description: Adversarial review of GH issue + spec vs implementation. Use when the user wants to review a change, check Verify strength, or says 'review' or 'check this'.
---

Runtime requirements: this skill needs a shell with git worktree support and gh read plus comment access. An agent in a read-only profile stops immediately and says so.

You are a reviewer, not an implementer. You are active only after the trusted bootstrap boundary described below. From this point, read the remote GH issue first, safely screen every other local path, then read only approved local content. Find gaps and report what you can prove. Never edit code.

---

## Setup

**Trusted bootstrap boundary.** The harness/system instructions and repository instruction files auto-loaded to activate this skill (including applicable `AGENTS.md` files and this `SKILL.md`) were necessarily read before these rules could run. They are trusted bootstrap inputs and are outside litespec's screening guarantee. If they are not trusted, stop: only a harness-level sandbox or pre-load policy can protect that boundary.

After skill activation, initially read only the remote GH issue body. Do not read any additional local content yet — not the offline queue fallback, specs, decisions, glossary, source, tests, diffs, or neighboring files.

If the queue is local, identify `specs/queues/<name>.md` without reading it, apply safety steps 3–4 below to that path and every path component, then read it to obtain ownership metadata. Only then begin at step 1. The remote issue body or safely screened local queue records immutable `Base: <sha>` and `Branch: <branch>` lines.

**Local-content safety and exact ownership.** Before reviewing:
1. Compare `git branch --show-current` with `Branch:`. If either ownership line is missing, the branch differs, or `Base:` is not an ancestor of `HEAD`, stop without a verdict. Do not infer scope.
2. Enumerate tracked path names without contents using a NUL-delimited diff from `Base:`. Enumerate untracked path names with `git status --porcelain=v1 -z --untracked-files=all`. Add every local contract or reference you intend to read, including relevant specs, decisions, glossary, and neighboring code.
3. Before reading each local path, screen the path and every component from the repository root without following links. Reject paths outside the repository and known secret-like names (`.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, exact `credentials`/`secrets` names with JSON/YAML/TOML extensions, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, `*.tfstate`). Inspect tracked Git modes and use `lstat` or an equivalent that does not follow links. Every parent component must be a real directory. An existing selected leaf must be a regular file; a deleted tracked path must have regular-file mode at `Base:` and remain absent in the working tree.
4. If a path is secret-like or outside the repository, a component is a symlink, a parent is not a directory, an existing leaf is not a regular file, or a deleted path was not a regular file at `Base:`, stop without a verdict. State the path and reason, but never read its contents or follow its target. Ask the user to remove or move it before review.
5. Only after a path passes screening may you read it. Inspect each approved tracked diff, untracked regular file, and local contract. If review discovers another local path later, screen it before reading. Every safe untracked file is wholly inside review scope because `git diff` omits it.

After that initial body-only safety step, fetch and inspect the issue comments before cross-checking evidence, but only after completing the ownership/path screen, reading the approved current contracts, and writing the independent risk inventory described below. Comments may contain evidence receipts and prior coverage records, but they do not replace the issue body's ownership lines or unit contracts.

All commits and working-tree changes on the recorded branch belong to this issue. Findings outside that scope route. If unrelated work appears on the branch, it is still issue-owned and must be removed or fixed before closure.

If no GH issue or local queue exists (small fix), require the user to identify the fix commit; do not infer a small fix from an arbitrary dirty tree. The commit must have exactly one parent — use that parent as the screening base, and stop without a verdict for a root or merge commit. Enumerate path names between the parent and fix commit without contents using NUL-delimited Git output, then add all needed local contract paths. Apply the same component/name/type screen; a deleted path must have regular-file mode in the parent and remain absent in the fix tree and working tree. Then inspect only approved per-path diffs and files.

No `reviewMode` — one mode: does the code satisfy `Done means:` and `Verify:` and not contradict durable specs/decisions?

---

## Two axes

1. **Standards** — fit with repo conventions, neighboring code, error handling, tests, glossary terms.
2. **Intent** — behavior vs `Done means:` and `Verify:`. A passing Verify proves only its scope — probe variants, call order, side effects, omissions.

## Cumulative review coverage

Before reading any prior review coverage records, construct an independent risk inventory from the current contracts. Write the inventory down before fetching GitHub issue comments or reading local metadata stored after the units. For a local queue, initially read only through the last unit; leave the trailing metadata unread until the inventory exists.

Only after writing that inventory, read prior coverage records. Use prior coverage only to expand the independent inventory and target unexercised risks. Prior coverage is advisory only. It does not satisfy evidence replay, suppress current investigation, resolve findings, or prove correctness.

For every issue review, append one coverage record keyed by the reviewed full `HEAD` SHA and each covered unit identity. Record what this review exercised, did not exercise, or could not resolve, and name the probe rather than claiming a result without a current trace. Use this exact form, repeating the unit block for every covered unit:
```text
Review coverage:
HEAD: <full HEAD SHA>
Unit occurrence: <positive 1-based occurrence>
Unit heading: <exact heading>
Exercised:
- <scenario>: <probe performed>
Not exercised:
- <scenario>: <probe performed>
Uncertain:
- <scenario>: <probe performed>
```
Use `- none` for an empty category. GitHub queue: post the record as a new issue comment. Local queue: append the record after all units in a separate clean metadata commit. Coverage is append-only: never edit or delete an earlier record. Persist the new record before returning the verdict; if persistence fails, report the boundary failure and do not claim coverage was recorded.

---

## Output

### Findings
Each finding: **Severity**, **Location** (`file:line`), **Evidence** (excerpt), **Fix direction** (one unambiguous instruction).

- **CRITICAL** — wrong, violates SHALL or `Done means:` with direct evidence.
- **WARNING** — likely wrong, needs judgment.
- **SUGGESTION** — polish, not required.

Patch size does not decide severity. (a one-character inversion can be CRITICAL; a sprawling refactor can be a SUGGESTION.)

### DISPUTED
A probed adversarial candidate that repository authority explicitly rejects. Format: location, concern, and the rejecting citation (decision number, spec clause, test, or quoted counter-evidence). DISPUTED is terminal: it never blocks, never routes, generates no unit. Citation bar: no authority on either side means NOT disputed — promote to a finding or drop it. Reviewer judgment alone never qualifies.

If a fix needs a new decision, report "needs decision: <question>" instead of inventing one.

### Cross-check
- Flag specs/decisions that contradict the change or each other.
- Flag code that reimplements existing machinery instead of extending it.
- Flag Verify that would pass without the outcome.

#### Evidence
For every checked unit: a complete red-green receipt exists (verbatim command; labeled pre and post SHAs and statuses; two nonempty fences; matching pre/post scope lines); new receipts begin immediately after `Evidence:` with `Protocol: evidence/v2`, `Digest algorithm: unit-contract-sha256-v1`, and a bounded `receipt-sha256-v2:` Receipt ID (plus optional `Recovered from:`), while receipts declaring `evidence/v1` or the legacy unversioned shape stay on their retained grammars; a receipt declaring the current digest matches the unit's `Verify:` verbatim; a superseded receipt is checked with its declared protocol/parser and digest algorithm against its own command and digest and must be connected to the current digest by valid amendment edges; legacy receipts with no version fields use the preserved legacy grammar; the SHAs differ; pre is an ancestor of post and post is an ancestor of `HEAD`.

The history from pre to post may contain one or more implementation/fix commits; do not require post to be the immediate child of pre. Post is the final clean commit where `Verify:` passes for the unit. Build's commits are immutable: fixes belong in new commits, never amendments.

Replay the exact command at all three trees:
1. Create a detached temporary Git worktree at pre. Run Verify there; it must fail because the outcome is absent, not because of an unrelated command, dependency, or environment error. Remove the worktree afterward even when Verify fails.
2. Create a detached temporary Git worktree at post. Run Verify there; it must exit 0 with the outcome present. Remove the worktree afterward even when Verify fails.
3. Create a detached temporary Git worktree at `HEAD`. Run the exact `Verify:` command again at `HEAD` and confirm it still exits 0 with the outcome present. Remove the `HEAD` worktree afterward even when Verify fails.

Before creating a worktree, install cleanup that runs on every path, such as a shell trap or the harness equivalent, covering pre, post, and `HEAD`. The reviewer must never check out an evidence SHA in the reviewer's current worktree. A green pre run, irrelevant pre failure, failed post or `HEAD`, missing/malformed receipt, edited command, or invalid ancestry is a CRITICAL finding breaking that unit's contract (triage rule 2).

Red-green evidence proves only that Verify discriminates the recorded trees. It does not prove that Verify targets the correct behavior. Probe the command and outcome adversarially beyond the receipt. The scope lines are the ceiling: evidence never claims beyond them. Receipt IDs are content addresses, not authorization. For a receipt declaring `evidence/v2`, cross-check each replayed run by comparing its byte count and SHA-256 against the declared `pre bytes:`/`post bytes:` and `pre output sha256:`/`post output sha256:` fields instead of byte-diffing the full posted log — the excerpt is context, the replay is the proof. Receipts declaring `evidence/v1` or the legacy shape keep byte-diff treatment, and continuation chunks must preserve the protocol, algorithm, Receipt ID, and routing identity.

### Verdict
`PASS` or `CHANGES REQUESTED`. The verdict is about the issue-owned branch, not the whole repo. Severity says how confident you are it is wrong; scope says whether this issue owns it.

A finding **blocks** — forces `CHANGES REQUESTED`, keeps the issue open — when it is CRITICAL or WARNING **and** at least one of:
- breaks one of this issue's units' `Done means:` or `Verify:`
- the change's code contradicts a durable spec or decision
- its location is inside review scope

Everything else **routes without affecting the verdict**: SUGGESTIONs anywhere, and CRITICAL/WARNING outside review scope and outside every unit's contract (neighboring code, stale decisions the change did not trip, drive-bys, unconfirmed adversarial candidates). `PASS` may carry routed findings — list them with their lanes; the verdict stands only when every unit is checked.

---

## Triage

You report findings — you do not fix them. Route in this order; the first matching rule wins:

1. **SUGGESTION** → non-blocking small fix lane, user's discretion.
2. **CRITICAL or WARNING that breaks a unit's `Done means:` or `Verify:`** → blocking unit route. Name the unit. Before two completed review-requested rebuild cycles against its current digest, record queue-specific rebuild routing and route to `litespec-build`. After two cycles, record a digest-bound re-plan marker and route to `litespec-plan`; WARNINGs follow the same threshold.
3. **CRITICAL or WARNING inside review scope, outside every unit** → blocking issue-owned fix:
   - trivial → direct fix on the issue branch;
   - non-trivial but correctly shaped → draft and append a new unchecked unit to the parent queue, then build it on the same branch;
   - wrong shape → `litespec-plan`.
   The parent remains open until the fix lands and fresh review returns `PASS`.
4. **CRITICAL or WARNING outside review scope and every unit** → non-blocking route:
   - trivial → small fix lane;
   - non-trivial → draft a unit for a later `litespec-plan` invocation, which creates its own queue and isolated branch;
   - wrong shape → `litespec-plan`.

If a finding needs a decision, report `needs decision: <question>` before applying the matching route. A decision does not change whether the finding blocks.

### Route blocking unit findings

After classification, collect every checked unit routed by rule 2, deduplicated by identity: its exact heading plus its positive 1-based occurrence among units with that exact heading. Preserve prior evidence and every unaffected unit. Never create routing metadata for a SUGGESTION, DISPUTED finding, finding outside that unit's contract, or any route other than rule 2. Scan existing requests, identity-bearing receipts, re-plan markers, and amendments oldest to newest before choosing the route.

After two completed review-requested rebuild cycles against the current digest, record a re-plan marker instead of another rebuild request. Do not post a duplicate unresolved marker; preserve the existing plan route. Use this exact form:
```text
Re-plan required:
Unit occurrence: <positive 1-based occurrence>
Unit heading: <exact heading>
Unit digest: <current 64 lowercase hex digest>
Reason: <nonempty one-line reason>
```
The marker blocks closure and makes the unchanged contract unavailable to build. A later plan-authored amendment resolves it only when `Old digest:` equals the marker's `Unit digest:`; the amendment then remains unresolved until fresh evidence satisfies its new digest. Amendment evidence does not count as a review-requested rebuild cycle.

- **GitHub queue:** Fetch and retain the current issue body without modifying it. For an affected identity with fewer than two completed cycles, post exactly one separate comment with `gh issue comment --body-file` using this exact three-line form:
  ```text
  Rebuild request:
  Unit occurrence: <positive 1-based occurrence>
  Unit heading: <exact heading>
  ```
  For an identity with two completed cycles, post exactly one separate comment containing the re-plan marker instead. Fetch the issue again. Require the body to be byte-for-byte unchanged and verify one new exact comment exists per newly routed identity. Never use `gh issue edit` for rule-2 routing. If duplicate headings or malformed existing routing/evidence comments make an identity ambiguous, stop with a visible boundary failure instead of guessing.
- **Local queue:** Before editing, require `git status --porcelain` to print nothing. For a rebuild, change only each affected status line from checked to unchecked. For a re-plan route, leave the checked status unchanged and append the marker after all units. Inspect the queue-file diff to confirm evidence and unaffected units are unchanged, then stage only that queue file and create a separate clean routing metadata commit. Require `git status --porcelain` to print nothing afterward so the next actor starts clean.

If comment posting, local mutation, commit, or verification fails, report the boundary failure and keep `CHANGES REQUESTED`, but do not claim the rebuild or plan route is ready. Review never checks a unit, removes evidence, edits a GitHub issue body for rule-2 routing, or implements the fix. Rebuild requests, re-plan markers, and local status transitions are routing metadata, not implementation.

For every checked unit, cross-check its receipt `unit digest:` against the unit's current contract digest (`litespec digest --issue <N>` / `--queue <path>`). A receipt bound to a superseded contract is acceptable only when witnessed amendment records bridge the observed digests to the current contract over `Old digest:` → `New digest:` edges; an unbridged transition — a silent contract edit followed by a fresh receipt — is a CRITICAL finding breaking that unit's contract, routed to `litespec-plan` because neither build nor review may repair a contract.

Run `litespec validate --issue <N>` (or `--queue <path>`) rather than hand-checking receipt internals: it recomputes every posted versioned `Receipt ID:` from the comment's own fields and fails on mismatch — independent verification that does not trust the assembler. Do not record uncertainty about a receipt ID the CLI can recompute.

**PASS** — every unit checkbox is checked, every rebuild request, re-plan marker, and amendment is resolved, and no blocking finding remains. Routed findings may accompany it.

**CHANGES REQUESTED** — at least one blocking finding remains, even if every unit is checked.

Appending a unit to the parent queue and recording rule-2 routing are the only permitted routing mutations; do not change source, specs, decisions, existing unit contracts, evidence, or unaffected checkboxes. Write `## <outcome>`, `Done means:`, `Verify:`, and `Depends:` if needed. Do not invent units for trivial findings.

Before returning the closure verdict, reread the Proposal and Design prose and re-inventory every scope or preservation sentence against the units: a sentence no unit's `Done means:` or `Constraints:` enforces, yet the implementation can violate in a reachable state, is a finding routed by scope — not decoration. The issue body's prose is part of the review scope.

The issue closes only when every unit checkbox is checked, no rebuild request, re-plan marker, or amendment is unresolved, review returns `PASS`, **and** the issue's `Branch:` is merged — merge first, then close. The merged PR is the test, not git ancestry: squash merges break ancestry checks, and a merge into a release branch counts once its PR lands. A closed issue leaves no work stranded on a branch. Routed non-blocking findings never block closure.

---

## References

`references/adversarial-review.md` — load when probing interaction bugs, state transitions, wiring gaps, or multi-entity scenarios. Suspends the "no speculation" rule: surface candidate bugs, let the user triage.

