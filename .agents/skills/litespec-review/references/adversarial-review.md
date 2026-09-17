Adversarial review deliberately constructs adversarial scenarios to find interaction bugs, missing guards, and wiring gaps. It runs before compliance review so that scenario construction is not anchored by compliance findings.

**Different rules apply here.** The "prefer false negatives" and "no speculation" rules from compliance review are suspended. You are expected to imagine how state transitions compose, where loops re-read stale state, and where declared code is never wired up. Noise is acceptable — a human will triage. Your job is to surface candidate bugs, not to be certain. But noise cannot block: only confirmed findings inside review scope or against a unit's contract / durable spec count as blocking. Uncertain candidates route — report them, let the human triage them into a lane.

**Skip this phase** if the change contains no stateful code paths (pure refactors, documentation, configuration-only changes). State `Phase 1 skipped: no stateful code paths detected` and proceed to compliance review.

---

## Step 1: Enumerate adversarial scenarios (from specs, before reading code in detail)

Before tracing implementation paths, read the specs and enumerate:
- Every state transition the specs describe (conditions for X → Y)
- Every place the specs describe multi-entity operations (loops, batches, cascades, bulk processing)
- Every place the specs describe concurrent access (claims, locks, leases, workers competing for the same resource)
- Every place the specs describe global guarantees (`across all X`, `in order of Y`, `the first available`)

For each, construct 1–3 worst-case scenarios:
- What if two of these happen simultaneously?
- What if one succeeds and a related one fails mid-cascade?
- What if the precondition changes between the check and the mutation?
- What if the entity is already in a terminal state when the operation arrives?

Write these down as a numbered list BEFORE tracing implementation code. This is red-team-before-blue-team — generate the adversarial frame from the spec's structure, not from pattern-matching against the code's surface.

**For each scenario**, structure your reasoning as:
1. **Premises**: What invariants does the spec claim? What state is assumed?
2. **Trace**: The concrete code path from trigger to effect, with file:line anchors
3. **Conclusion**: Does the trace uphold or violate the premises? Tag as [confirmed] or [inferred].

---

## Step 2: Check each scenario against the implementation

For each numbered adversarial scenario, trace the relevant code paths. Report:
- **Handled**: code demonstrably prevents the scenario (with `file:line` reference)
- **Missing**: code does not guard against it (with concrete `file:line` showing the gap)
- **Uncertain**: can't determine from reading alone

---

## Step 3: Check for structural patterns

**Multi-entity loop invariants**: When code iterates over a collection and each iteration mutates shared state, trace what happens if iteration N's state changes are visible to iteration N+1. Does each iteration re-query or re-validate its preconditions, or does it act on stale data from before the loop began?

**State guard completeness**: For every endpoint/handler that transitions an entity's state, check that ALL preconditions are validated — not just the happy-path ones. If endpoint A checks "is lease expired?" and endpoint B transitions the same entity, does endpoint B also check? Enumerate every state-transition endpoint and verify each guards against every invalid current state.

**Wiring completeness**: Are all declared functions/types actually referenced in the control flow? Functions defined in service modules but never called from handlers/routes are implementation gaps. Search for them. Types imported but never used in runtime paths are scaffolding without substance.

**Scope-of-guarantee**: When the spec says "across all X" or describes global ordering/behavior, verify the implementation doesn't implicitly narrow scope to a subset (per-resource, per-file, per-request, per-run).

---

## Step 4: Test adequacy

For each spec scenario, ask: would existing tests catch a violation of this scenario's guarantee?

A test that only exercises the happy path does not count. Flag cases where:
- A spec requirement has no corresponding negative test (invalid input, rejected transition, expired state)
- A spec scenario is tested in isolation but never in combination with other scenarios that affect the same entity
- A spec describes a cascade or multi-step interaction but tests only cover single-step cases
- A state transition has no test for what happens when the entity is already in a terminal state

## Step 5: Extract patterns

After completing Steps 1–4, step back and look for shared structure across your findings.

When multiple findings stem from the same root cause (e.g., several methods that transition the same state machine without a shared guard, multiple loops that close over the same mutable variable, several event handlers that assume an entity is alive), group them into a **Pattern Annotation**.

A pattern annotation serves the fixer — the agent that will consume this report and apply changes. The fixer may not have the reviewer's full context. By shipping the pattern, you give the fixer permission and direction to fix *all* instances rather than cherry-picking the one reported finding.

For each pattern:
1. Name the pattern (concise, descriptive)
2. List all confirmed locations (findings already reported above)
3. List all likely locations (same pattern, not yet triggered by your scenarios but structurally identical)
4. Give a single unified fix recommendation

Patterns are optional — only emit them when findings genuinely share a root cause. Do not force unrelated findings into patterns. One finding with no structural kin needs no pattern annotation.
