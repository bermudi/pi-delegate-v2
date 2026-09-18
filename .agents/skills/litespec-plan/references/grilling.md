Use when the shape is fuzzy, the human says "grill-me", or a plan has unresolved branches.

Grill to find the forks — don't write files until the forks are resolved.

## How

- Ask one question at a time. Each question should surface a real fork (two ways that lead to different work).
- For each question, give your recommended answer and why — don't just list options.
- Read code before asking. If the codebase answers it, don't ask the human.
- Resolve language first: if a term is fuzzy, fix it via `references/domain-modeling.md` before diving into architecture.

## What to grill

- Who is the user and what are they actually trying to demo?
- What is the smallest slice that proves it?
- What must stay true (constraints) vs what is out of scope?
- Where does this live in the codebase — extend existing path or new module?
- What could ro rot if we keep it as a durable spec?

## End

When forks are resolved, summarize the shape in one paragraph and ask "ready to nail it?" — then load `references/clear.md` to write the GH issue.

A fork closed by argument is a decision candidate. If the losing road is one someone will reasonably propose again and the reasoning spans files, flag it in the summary so clear mode can `touch` + `validate` a decision file (bar in DESIGN.md). Otherwise it becomes a comment at the line that would change, or nothing.
