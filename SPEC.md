# Delegate v2 behavioral specification

This document describes the user-visible contract to carry forward from
`pi-delegate` v1. It specifies outcomes, not how v2 must produce them. V1
modules, algorithms, state machines, timers, storage layouts, and cleanup
mechanisms are explicitly not requirements.

## Operations

`delegate` has four mutually exclusive modes, selected after input
normalization in this order:

1. **Ticket RPC** — top-level `ticketAction`.
2. **Session RPC** — top-level `sessionAction`.
3. **Dispatch** — a non-empty `tasks` array.
4. **Help** — no tasks, or an empty task array.

Mixing fields from different modes is an error. Validation happens before any
task starts.

### Dispatch

```ts
delegate({ tasks: [task, ...], async?: boolean, workspace?: "shared" | "scratch" | "isolated" })
```

Dispatch is synchronous by default. `async: true` applies to the whole batch,
returns a ticket immediately, and later auto-delivers the batch result.
Synchronous results preserve task input order and include aggregate usage when
the Pi host supports it. A top-level `workspace` is the default for every task
that does not name its own.

A task accepts:

| Field | Meaning |
| --- | --- |
| `id` | Optional correlation key: 1–64 ASCII letters, digits, `.`, `_`, or `-`; unique in the batch |
| `prompt` | Self-contained instruction; optional only when continuing with `resumeFrom` |
| `agent` | Named profile; omission selects an inline task |
| `cwd` | Working directory; relative paths resolve from the parent cwd |
| `systemPrompt` | Base prompt; project context is added separately |
| `tools` | Exact capability list; `*` = read/write/edit/bash, `ro` = read/grep/find/ls |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `sessionId` | Key for a live reusable session |
| `resumeFrom` | Absolute `.jsonl` transcript path |
| `deadlineMs` | Positive wall-clock budget beginning after queueing |
| `workspace` | `shared`, `scratch`, or `isolated` |

Omitting `agent` creates an `inline` task with `*` by default. The built-ins are:

- `default`: mirrors the live parent's model, thinking level, delegatable native
  tools, and sanitized base prompt.
- `scout`: read-only investigation.
- `coder`: shared-tree implementation.
- `reviewer`: shared-tree review by default.

If reading the parent's active tools throws and any `default`-profile task
omits `tools`, the whole sync or async dispatch fails before any child starts.
The failure is logged and returned with its cause and guidance to restore the
parent inventory or supply explicit tools. Explicit `tools` (including `[]`),
`scout`, `coder`, `reviewer`, and inline tasks do not require that probe;
inline tasks retain their writer default.

Children never inherit the parent conversation: no parent transcript is extracted
or injected. Supply a self-contained task brief. The obsolete `context` field
is rejected before any task starts, including `context: "fresh"`; omit it.
This does not remove a child's own pooled `sessionId` or explicit `resumeFrom` history.

Task fields override profile defaults. Named Markdown profiles use
first-definition-wins discovery. Project context is rebuilt for the task cwd;
the parent's extension inventory, MCP tools, and user-global harness
instructions are not inherited. Provider extensions are disabled except for
the verified, provider-scoped allowlist.

Subagents run on the parent's model. The user may override a **named agent**
under `"models"` in the user-global `delegate.json` — an object mapping agent
name to a model reference. There is deliberately no `"default"` entry and no
way to redirect inline or `default`-profile tasks: they mirror the parent's
model unconditionally. Callers never select models: a task `model` field is
rejected before tasks start, whatever value it carries — the model registry
containing a model is not authorization to spend on it. A configured
reference that does not resolve in the session's model registry fails the
whole call, naming the config entry.

The user-global `delegate.json` is discovered from the session's agent
directory: the `DELEGATE_AGENT_DIR` environment variable when set, else the
session-store layout (`<agentDir>/sessions/<slug>`), else — for sessions
with no session directory — the session cwd behind a visible warning.
Delegate-owned trees (`delegate-sessions/`, `delegate-scratch/`,
`delegate-isolated/`) are created under the same resolved directory.
Project files never become delegate configuration.

Tasks run concurrently subject to global and per-model limits. Overlapping
same-call shared writers serialize in task order, and the result names the
serialized tasks and scope with the `isolated` remedy — independent same-repo
edits are meant to run in parallel worktrees. Overlap with active work, or
between shared and isolated work, rejects the whole call before execution.

### Workspaces

- **shared** operates directly in the source tree.
- **scratch** runs once in a disposable reflink copy and discards its changes.
  It cannot use `sessionId` or `resumeFrom`. A task whose resolved tools are
  all read-only is rejected — the copy buys nothing. Scratch holds no write
  reservation on the source tree.
- **isolated** runs one-shot tasks in detached Git worktrees and reconciles
  successful proposals into the source tree in task order. It cannot use
  `sessionId` or `resumeFrom`.

Scratch and isolated workspaces protect against ordinary relative writes; they
are not security sandboxes.

### Ticket RPC

```ts
delegate({ ticketAction: "poll", ticket? })
delegate({ ticketAction: "wait", ticket, timeoutMs? })
delegate({ ticketAction: "pause" | "resume", ticket })
delegate({ ticketAction: "cancel", ticket, force? })
```

- `poll` returns one ticket or the ticket roster.
- `wait` blocks until settlement or timeout. Timeout/parent abort detaches the
  waiter; it does not cancel background work.
- `pause` cooperatively stops queued tasks and future model turns, not current
  model/tool work or subprocesses.
- `resume` continues the same ticket.
- `cancel` previews unless `force: true`; forced cancellation is cooperative
  and does not undo completed writes or commands.

Tickets remain pollable after settlement. A same-leaf async result may wake the
parent; after session-tree navigation it is delivered for the next turn and
announced without waking the wrong branch.

### Session RPC

```ts
delegate({ sessionAction: "list" })
delegate({ sessionAction: "close", sessionId })
```

`list` reports live pooled sessions. `close` aborts, disposes, and removes the
named session. Session controls are top-level only.

## Input recovery and errors

For compatibility with imperfect tool callers, Delegate silently repairs only
unambiguous shapes:

- a JSON-stringified task array;
- flat task fields wrapped into one task when there is no ticket/session intent;
- `tools` supplied as a JSON array string or one bare token;
- `agent: ""`, treated as omitted.

It does not merge flat fields into an existing non-empty task array. Unknown
task keys, task-level `async`/`sessionAction`, duplicate IDs or session IDs,
busy sessions, unresolved agents/tools, a task `model` field, and invalid mode
combinations fail the whole call with an actionable error and no started
tasks.

## Sessions, retries, and cancellation

A successful task with `sessionId` keeps a live conversation for the lifetime
of the host process.
Later calls with that ID serialize and continue it. Its cwd, tools, thinking,
model, base prompt, and provider-extension configuration are frozen; incompatible
reuse is rejected. `resumeFrom` rehydrates a durable transcript and may then be
pooled under a new `sessionId`.

Transient whole-task failures may retry. Model/account failures do not blindly
retry on the same model and surface as model-attributed, pointing the operator
at the user-side model configuration — callers have no model recourse.

Stall timeouts measure inactivity; deadlines measure wall-clock time.
Cancellation does not promise rollback or immediate termination. Delegate does
not reuse or clean up resources while they may still mutate state; resources
whose safety cannot be established remain unavailable.
