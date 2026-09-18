Use when a new term appears that could mean different things to human vs agent.

Glossary is the shared language — defining the term *is* designing the system.

## When to trigger

- You used a word that isn't in `specs/glossary.md` but will appear in specs, code, or GH issues
- Two words could be confused (e.g., change vs feature vs capability)
- A vague idea needs precise words before you write the GH issue

## Do

1. Read `specs/glossary.md` if it exists. Check if the term already has a meaning.
2. Propose a one-line definition: `- **Term**: what it is, in this project's words`
3. Road-test with a concrete scenario: "If X happens, is it still a Term?"
4. If the human agrees, add it to `specs/glossary.md` (alphabetical, `- **Term**: def` format, no headers inside). Offer, don't auto-add.
5. Use the term consistently after — same word in GH issue, spec, and code.

## Don't

- Don't add every word — only terms that are project-specific, frequent, or easily confused.
- Don't redefine common engineering words.
- Don't let the GH issue use a different word than the glossary.

Example: bad — "stuff goes into the canon thing". Good — "Add `specs/view/spec.md` SHALL for the dependency graph".
