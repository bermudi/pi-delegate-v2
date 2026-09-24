/**
 * Human-facing renderers for the `delegate` tool's results and for the
 * delivered `delegate-result` custom message.
 *
 * Pi's stock result rendering only ever displays the LLM-facing `content`
 * text, which spill-bounds large outputs to a tail plus a file pointer —
 * so expanding a result never revealed the whole output even though
 * SPEC "Recovery" promises it ("a human expanding the result sees it
 * whole"). The expanded views below re-render from `details.results`, the
 * complete recorded outcomes every result and delivered message carries.
 * Ticket results prefer the live store's `fullView` (which adds the ticket
 * header); a replayed transcript whose ticket is gone falls back to the
 * recorded outcomes alone.
 *
 * Collapsed views keep the host's compact contract — a preview of the
 * bounded content with an expand hint, matching the stock fallback's
 * budget. Styling goes through the `theme` argument exclusively: the
 * interactive-mode theme singleton throws when uninitialized, which is
 * exactly the state tests render under.
 */
import { keyText } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  MessageRenderer,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { formatDispatchResult } from "./format.ts";
import { UNBOUNDED_OUTPUT } from "./spill.ts";
import type { TicketStore } from "./tickets.ts";
import type { TaskOutcome } from "./types.ts";

/** Matches the stock tool-result fallback's collapsed preview budget. */
const COLLAPSED_PREVIEW_LINES = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOutcome(value: unknown): value is TaskOutcome {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.status === "ok" ||
      value.status === "failed" ||
      value.status === "cancelled")
  );
}

/**
 * The expanded document for a result's or delivered message's `details`,
 * or undefined when it carries no recoverable outcomes — in which case the
 * bounded content text is the most faithful expanded view available.
 */
function expandedText(
  details: unknown,
  tickets: TicketStore,
): string | undefined {
  if (!isRecord(details)) return undefined;
  // A ticket-backed result (a poll/wait view or a delivered message)
  // renders the store's whole view — header, notices, sections — which
  // the recorded outcomes alone cannot reproduce.
  if (typeof details.ticket === "string" && Array.isArray(details.results)) {
    const ticket = tickets.get(details.ticket);
    if (ticket !== undefined) return tickets.fullView(ticket);
    // Only a replayed transcript misses the store; fall through to the
    // outcomes recorded on the result itself.
  }
  if (!Array.isArray(details.results)) return undefined;
  const outcomes = details.results.filter(isOutcome);
  if (outcomes.length === 0) return undefined;
  const sections = formatDispatchResult(outcomes, [], UNBOUNDED_OUTPUT);
  const notices = Array.isArray(details.notices)
    ? details.notices.filter((n): n is string => typeof n === "string")
    : [];
  return notices.length > 0
    ? `${notices.join("\n")}\n\n${sections}`
    : sections;
}

function styled(text: string, theme: Theme): string {
  return text
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
}

function contentText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * The tool definition's `renderResult`: collapsed mirrors the stock
 * fallback (a bounded preview of the content); expanded renders the
 * complete recorded outcomes from `details.results` — the whole output a
 * human expanding the result is promised.
 */
export function createResultRenderer(tickets: TicketStore) {
  return (
    result: AgentToolResult<unknown>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: { lastComponent: Component | undefined },
  ): Component => {
    let body = options.expanded
      ? (expandedText(result.details, tickets) ?? contentText(result))
      : contentText(result);
    if (!options.expanded) {
      const lines = body.split("\n");
      if (lines.length > COLLAPSED_PREVIEW_LINES) {
        const keys = keyText("app.tools.expand");
        body =
          lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n") +
          theme.fg(
            "muted",
            `\n... (${lines.length - COLLAPSED_PREVIEW_LINES} more lines${keys !== "" ? `, ${keys} to expand` : ""})`,
          );
      }
    }
    const component =
      context.lastComponent instanceof Text
        ? context.lastComponent
        : new Text("", 0, 0);
    component.setText(styled(body, theme));
    return component;
  };
}

/**
 * The delivered `delegate-result` message's renderer: collapsed returns
 * undefined so the host's default custom-message chrome shows the bounded
 * content as before; expanded renders the complete outcomes — the live
 * ticket's `fullView` (header, notices, sections) when the ticket is
 * still in the store, else the recorded `details.results` sections.
 */
export function createMessageRenderer(tickets: TicketStore): MessageRenderer {
  return (message, options, theme) => {
    if (!options.expanded) return undefined;
    const details = message.details;
    let body = expandedText(details, tickets);
    if (body === undefined) return undefined;
    // Mirror the delivery text's cancelled-ticket suffix — fullView renders
    // the ticket document, not the delivery annotation.
    if (
      isRecord(details) &&
      typeof details.ticket === "string" &&
      tickets.get(details.ticket)?.status === "cancelled"
    ) {
      body += "\nCancellation is cooperative; worker cleanup may still be pending.";
    }
    const label = theme.fg(
      "customMessageLabel",
      theme.bold(`[${message.customType}]`),
    );
    const styledBody = body
      .split("\n")
      .map((line) => theme.fg("customMessageText", line))
      .join("\n");
    return new Text(`${label}\n\n${styledBody}`, options.outputPad, 0);
  };
}
