---
name: litespec-plan
description: Shape intent into a bounded GH issue (+ spec if load-bearing). Use fuzzy mode for half-baked ideas/questions/research and clear mode to nail the issue. Handles grilling ('grill-me'), codebase design, and glossary. Use when the user wants to plan, shape, explore, grill, or says 'plan', 'shape', 'grill-me', or 'let's think about'.
---

You turn intent into a bounded GH issue (+ spec if load-bearing). Fuzzy vs clear are modes of this skill.

**IMPORTANT: You create planning artifacts, not production code.** If the user asks to implement, suggest `litespec-build`.

---

## Modes

### Fuzzy — half-baked idea
When the idea has questions, unknowns, or needs research. No files yet.
Read `references/fuzzy.md`.

### Clear — sharp idea
When the idea can be demoed and needs a GH issue + spec.
Read `references/clear.md`.

Both are in this skill. Start in fuzzy. Load clear only when you can answer: "what demo proves this?" and "what Verify fails without it?"

---

## References — load only when branch applies

- `references/grilling.md` — default fuzzy process; also load when the user says `grill-me`
- `references/codebase-design.md` — when planning a feature that touches boundaries/modules
- `references/domain-modeling.md` — when a new ubiquitous term appears -> glossary
- `references/fuzzy.md` — fuzzy mode
- `references/clear.md` — clear mode (also owns the Verify rule)

If every invocation needs it, it belongs in this file, not a reference.

---

## Setup — read before you write

Read `specs/product.md`, `specs/glossary.md` if present, relevant `specs/<feature>/spec.md`, `specs/decisions/` for context, and the code the change would touch. Don't speculate about behavior you haven't opened.

Derive a kebab-case change name from the description. Check for open queue issues with `gh issue list --label litespec --state open` or `litespec view`.

---

## Fuzzy work

Grill by default: load `references/grilling.md` and ask one question at a time to find the forks. Name unknowns, run a tiny spike if reading can't answer a question — the spike is evidence, not production code. End with a one-paragraph rough shape and "ready to nail it?" — then load `clear.md`.

---

## Clear work

1. Run `git status --porcelain`. If it is not empty, stop: planning must start from a clean tree so pre-existing work cannot enter the issue.
2. Record `Base:` from `git rev-parse HEAD`, create and switch to the dedicated `litespec/<change-name>` branch, and record it as `Branch:`. Stop if that branch already exists; do not reuse it.
3. Write the GH issue body with the `litespec` label — `Base: <sha>` and `Branch: <branch>` near the top, then one `## <outcome>` per unit. One unit = one external boundary or one failure policy. Split broad demos across independent boundaries into separate units. Every unit has identified `Done means:` clauses mapped through `Scenarios:` to named tests, one `Verify:` that fails without the outcome, and a `- [ ]` checkbox. Filesystem, process, and network units also declare `Boundary:` and account in `Risk cases:` for timeout, cleanup, non-ENOENT errors, concurrency, and optional configured dependencies by scenario ID or reasoned N/A. Optional `Read first:` / `Constraints:` / `Depends:` remain unique and nonempty. Prose-only units are banned — documentation and explanation ride along with the unit whose behavior they describe, never as their own unit. If `gh` is unavailable, write the same body to `specs/queues/<name>.md`, where `<name>` is the change name chosen during `plan[clear]`.
4. If load-bearing (CLI shape, API, file format that breaks things when wrong), edit `specs/<feature>/spec.md` directly — 3-5 SHALL requirements with WHEN/THEN scenarios.
5. Run `litespec validate`. Fix formatting before handing off.

---

## Amending a unit contract

Plan is the only actor that may change a unit contract; build and review never do. A contract change is witnessed, append-only:

1. Run `litespec digest --issue <N>` (or `--queue <path>`) and record the unit's current digest.
2. Edit the unit's contract fields (heading, `Read first:`, `Constraints:`, `Depends:`, `Boundary:`, `Done means:`, `Scenarios:`, `Risk cases:`, `Verify:`) directly in the queue — on GitHub this is a deliberate plan-owned body edit, locally an edit to `specs/queues/<name>.md`. Dry-run a changed `Verify:` on the base tree before posting the witness — `references/clear.md` owns the rule.
3. Re-run `litespec digest` and post the witness — GitHub: one comment with the record below; local: append the same block at the end of the queue file as a separate clean metadata commit:
   ```text
   Amendment:
   Unit occurrence: <positive 1-based occurrence>
   Unit heading: <exact post-amendment heading>
   Old digest: <64 lowercase hex>
   New digest: <64 lowercase hex>
   Reason: <one line>
   ```
   Identity fields carry the post-amendment identity because the heading itself may have renamed. An amendment resolves an outstanding re-plan marker only when its `Old digest:` equals the marker's `Unit digest:`.
4. The amendment leaves the checked unit selectable but unresolved until build posts a fresh identity-bearing receipt whose `unit digest:` equals `New digest:`. Validate enforces the chain: every observed digest must connect to the current contract digest through amendment edges.

---

## Glossary

After writing, check if you introduced a term not in `specs/glossary.md`. Offer to add it via `references/domain-modeling.md`.

---

## Don't

- Don't prescribe files to edit in the GH issue — scope is outcome + boundaries. Use `Read first:` for context (areas/rulings, not file lists) and `Constraints:` for boundaries (what must stay true or is out of bounds); never as an edit list. The worker owns the path.
- Don't create files for a small fix. Small fix = edit code + update `specs/<feature>/spec.md` directly, no issue required.
- Don't invent Verify that doesn't fail without the outcome; dry-run it on the base tree before filing.
- Don't file a unit whose outcome an earlier unit in the same queue already delivers or is constrained to preserve — reshape it as a regression pin (the named tests are the outcome; the Verify fails while the pin is absent) or drop it.
- Don't put unrelated work on a queue issue's branch. Use another branch or worktree.

