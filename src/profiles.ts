import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Built-in coding tools a subagent session can actually be given. */
export const CHILD_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** Tools that cannot mutate the workspace, for shared-write admission. */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
]);

const TOOL_GROUPS: Record<string, readonly string[]> = {
  "*": ["read", "bash", "edit", "write"],
  ro: ["read", "grep", "find", "ls"],
};

export interface AgentProfile {
  readonly name: string;
  /** Fixed tool set; undefined means "resolve like the default profile". */
  readonly tools?: readonly string[];
  readonly thinking: ThinkingLevel | undefined;
  readonly systemPrompt: string | undefined;
}

const BUILTIN_PROFILES: Record<string, Omit<AgentProfile, "tools" | "name"> & { tools?: readonly string[] }> = {
  default: {
    // Mirrors the parent's model, thinking, and active tools at resolution.
    thinking: undefined,
    systemPrompt: undefined,
  },
  scout: {
    tools: TOOL_GROUPS.ro,
    thinking: undefined,
    systemPrompt:
      "You are a read-only investigation subagent. Report findings precisely; do not modify files.",
  },
  coder: {
    thinking: undefined,
    systemPrompt:
      "You are an implementation subagent working directly in the source tree.",
  },
  reviewer: {
    tools: TOOL_GROUPS.ro,
    thinking: undefined,
    systemPrompt:
      "You are a code-review subagent. Inspect the tree and report concrete findings.",
  },
};

export function knownAgentNames(): string[] {
  return [...Object.keys(BUILTIN_PROFILES)];
}

export function getBuiltinProfile(name: string): AgentProfile | undefined {
  const profile = BUILTIN_PROFILES[name];
  return profile ? { name, ...profile } : undefined;
}

/**
 * Expand the task `tools` field into concrete child tool names.
 * `*` and `ro` are groups; every other entry must name a known tool.
 * Returns an error string instead of throwing so callers can compose it.
 */
export function expandTools(spec: readonly string[] | undefined): string[] | string {
  if (!spec) return [...TOOL_GROUPS["*"]!];
  const expanded: string[] = [];
  for (const entry of spec) {
    const group = TOOL_GROUPS[entry];
    if (group) {
      expanded.push(...group);
      continue;
    }
    if (!READ_ONLY_TOOLS.has(entry) && !(CHILD_TOOLS as readonly string[]).includes(entry)) {
      return `unknown tool '${entry}'. Known tools: ${[...CHILD_TOOLS].join(", ")}; groups: *, ro.`;
    }
    // web_search is meaningful for admission but is not a built-in child tool.
    if (!(CHILD_TOOLS as readonly string[]).includes(entry)) {
      return `tool '${entry}' is not available to subagents. Known tools: ${[...CHILD_TOOLS].join(", ")}; groups: *, ro.`;
    }
    expanded.push(entry);
  }
  return [...new Set(expanded)];
}

/** A task can mutate its workspace when any effective tool is not read-only. */
export function isWriter(tools: readonly string[]): boolean {
  return tools.some((tool) => !READ_ONLY_TOOLS.has(tool));
}
