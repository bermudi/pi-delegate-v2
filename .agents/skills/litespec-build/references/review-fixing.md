You are rebuilding a unit that review routed back to build — a CRITICAL or WARNING finding showed the unit's `Done means:` or `Verify:` was not satisfied. The previous Verify passed but didn't prove the outcome. Your job is to cure the disease, not patch the symptom.

**Scope expands, does not narrow:**
- Identify the **abstract pattern** behind the finding. Do not fix just the reported `file:line`.
- Search the affected module for the same pattern. Fix all instances, not just the cited one.
- After fixing, re-read the affected module end-to-end. Ask: "Did my changes introduce new surface area? What invariants might now be broken?"
- Run the full test suite, not just tests related to your fix.

**Red-green rebuild order:**
1. Start from a clean tree. Establish and record a clean pre commit where the exact `Verify:` fails because the fix is absent. If the existing verifier passes, create at most one verifier-only commit, require a clean tree, and record the meaningful failing run there.
2. Only after recording that pre run, create one or more implementation/fix commits. Never amend the recorded pre or any later commit.
3. At the final clean commit where `Verify:` passes, record post and post a fresh evidence receipt. A GitHub rebuild receipt carries the request's exact occurrence and heading and leaves the checked body unchanged; a local rebuild re-checks only the affected unit.

**Per-finding loop:**

1. Read the finding and the relevant source. If it references a spec requirement, read that spec section first.
2. Search the module for the same pattern — fix all instances.
3. Make the minimal change that addresses the pattern.
4. Run `go build` and relevant tests. If both pass, move on. If either fails, fix and retry.
5. If the same verification fails twice on the same finding, stop. Re-read the finding and code before retrying.
6. State what was fixed and where.

**Final verification:**
1. Confirm the pre run was recorded before any fix, then run the same exact Verify at the final clean post commit and require exit status 0.
2. `go build`
3. `go test ./...`
4. `go vet ./...`
5. `litespec validate` — confirm no structural regressions.
6. Post a fresh evidence receipt. For GitHub, identify the unit by exact heading and occurrence without editing the body; for a local queue, re-check only the affected unit.

**Escalation:**
If a finding cannot be resolved, state it explicitly: "Finding [X] in `file:line` could not be resolved because [reason]." Never silently skip a finding. Suggest next steps (decision needed, re-plan the unit).

**Guardrails:**
- Do not fix only the cited `file:line` while ignoring structurally identical code nearby.
- Do not declare done after tests pass without re-reading the changed module.
- SUGGESTIONs remain optional. If evidence proves one is a unit-contract violation, it must be reclassified as CRITICAL or WARNING before it can expand rebuild scope.
- Do not reshape the unit contract: do not change its heading, Done means, Verify, dependencies, constraints, specs, or decisions. If the contract or spec is wrong, pause and ask.
- Queue bookkeeping is the narrow exception: post a fresh evidence receipt with the GitHub request identity, or re-check only the affected local unit. For a local queue, commit that bookkeeping separately after the recorded post commit.
- Stay within the unit. Drive-bys outside the unit's scope get noted, not fixed.
