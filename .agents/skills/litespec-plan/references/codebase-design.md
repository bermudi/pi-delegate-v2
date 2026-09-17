Use when planning a feature that touches boundaries, modules, or where you must choose where code lives.

Keep it plain — no theory links.

## Heuristics

- **Thin slice first.** Prove one external boundary or one failure policy per unit. A broader end-to-end demo is a queue of those units, not one unit that hides independent failure surfaces.
- **Vertical, not horizontal.** Touch CLI → validation → view for *one* feature before finishing all validation. Horizontal phases ("finish all DB, then all API") hide integration bugs until week 3.
- **Reuse the existing path.** Find what already does 80% and extend it. A new helper/parser/matcher next to an existing one is a smell — you'll reintroduce bugs the old code already fixed. If the new code is larger than the machinery it parallels, you're rebuilding it poorly.
- **Smallest coherent change.** No wrapper, no abstraction unless this unit needs it. More code is more bug surface, not more thoroughness. Complete is not speculative — handle real edge cases, skip invented ones.

## Check before you write the GH issue

- Can you demo the slice end-to-end?
- Does the proposed `Verify:` fail if the slice is missing?
- Did you extend an existing path instead of adding a parallel one?

Bad: "Migrate DB, then write API, then add CLI flag"
Good: "Run `litespec view` and see an arrow between two related changes, wired through existing `deps.go`"
