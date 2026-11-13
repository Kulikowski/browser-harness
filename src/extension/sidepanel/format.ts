/** Words the panel uses for states. Words, not coloured dots. */
import type { ToolCallStatus } from "../../shared/acp.js";
import { hasWebMcp } from "../../shared/context.js";
export { messageOf } from "../../shared/errors.js";
import type { TabSummary } from "../../shared/panel.js";
import type { ApprovalOutcome, Chat, Item, PermissionOutcome } from "../../shared/transcript.js";

export function toolStatusWord(status: ToolCallStatus, waiting: boolean): string {
  if (waiting) return "Needs you";
  switch (status) {
    case "pending":
      return "Waiting";
    case "in_progress":
      return "Running";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
  }
}

export function chatStateWord(chat: Chat): string {
  switch (chat.state) {
    case "starting":
      return "Starting";
    case "working":
      return "Working";
    case "waiting":
      return "Needs you";
    case "error":
      return "Problem";
    case "closed":
      return "Paused";
    case "idle":
      return "";
  }
}

export function duration(ms: number | null): string {
  if (ms === null || ms < 0) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function relativeTime(then: number, now: number): string {
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function permissionOutcomeWords(outcome: PermissionOutcome): { text: string; allowed: boolean } {
  if (outcome === "cancelled") return { text: "Withdrawn", allowed: false };
  const allowed = outcome.kind === "allow_once" || outcome.kind === "allow_always";
  return { text: `You chose: ${outcome.name}`, allowed };
}

export function approvalOutcomeWords(outcome: ApprovalOutcome, origin: string): { text: string; allowed: boolean } {
  switch (outcome) {
    case "allowed":
      return { text: "You allowed it once", allowed: true };
    case "always":
      return { text: `You allowed it on ${hostOf(origin)} from now on`, allowed: true };
    case "denied":
      return { text: "You declined", allowed: false };
    case "expired":
      return { text: "Nobody answered; nothing happened", allowed: false };
  }
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function stopWords(stopReason: string, durationMs: number | null): string {
  const took = duration(durationMs);
  switch (stopReason) {
    case "end_turn":
      return took ? `Finished in ${took}` : "Finished";
    case "cancelled":
      return "Stopped";
    case "max_tokens":
      return "Stopped: the reply hit the model's length limit";
    case "max_turn_requests":
      return "Stopped: too many steps in one turn";
    case "refusal":
      return "The agent declined to continue";
    default:
      return "The turn ended with an error";
  }
}

/** Shorten a path under the user's home for display. */
export function tildePath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

export function pretty(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** What a browser action would do, for the approval slip: "run clear_board", "type and press Enter". */
export function browserActionPhrase(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "click":
      return "click";
    case "type":
      return args.submit ? "type and press Enter" : "type";
    case "press_key":
      return `press ${typeof args.key === "string" ? args.key : "a key"}`;
    case "navigate":
      return "open another site";
    case "webmcp_call_tool":
      return `run ${typeof args.name === "string" ? args.name : "a WebMCP tool"}`;
    default:
      return `run ${tool.replace(/^webmcp_/, "")}`;
  }
}

/**
 * Each harness names our MCP tools its own way ("mcp__browser__click" in Claude Code,
 * "Run mcp_browser_67283dd3_click" in Antigravity). Returns our own tool name, or null when the
 * step is not one of the browser's tools.
 */
export function browserToolName(title: string): string | null {
  const match = title
    .trim()
    .match(
      /^(?:(?:Run|Call|Use)\s+)?(?:mcp__browser__|mcp_browser_(?:[0-9a-f]{6,}_)?|browser[.:/_]{1,2})([A-Za-z0-9_-]+)\b/
    );
  return match ? match[1]! : null;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const quoted = (value: string, max = 40) => `"${value.length > max ? `${value.slice(0, max)}…` : value}"`;

/** What a tool step did, in words, for the step rail. Falls back to the harness's own title. */
export function stepTitle(title: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  // Claude Code loads MCP tools on demand; say whether it was ours it went looking for.
  if (title.trim() === "ToolSearch")
    return /browser/i.test(JSON.stringify(input ?? "")) ? "Look up the browser tools" : "Look up tools";
  const tool = browserToolName(title);
  if (!tool) return title;
  switch (tool) {
    case "snapshot":
      return "Read the page";
    case "click":
      return "Click on the page";
    case "type":
      return str(args.text)
        ? `Type ${quoted(str(args.text))}${args.submit ? " and press Enter" : ""}`
        : "Type on the page";
    case "press_key":
      return `Press ${str(args.key) || "a key"}`;
    case "scroll":
      return "Scroll the page";
    case "navigate":
      return str(args.url) ? `Open ${hostOf(str(args.url))}` : "Open a page";
    case "screenshot":
      return "Take a screenshot";
    case "tabs":
      return "Look at the open tabs";
    case "webmcp_list_tools":
      return "List the page's own tools";
    case "webmcp_call_tool":
      return `Page tool: ${str(args.name) || "a WebMCP tool"}`;
    default:
      return tool.startsWith("webmcp_") ? `Page tool: ${tool.slice("webmcp_".length)}` : `Browser: ${tool}`;
  }
}

/** The last folder of a path, which is the part that tells workspaces apart. */
export function folderName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts.at(-1) || path;
}

/** Shortens text in the middle to at most `max` characters, keeping its start and (a little more of) its end: "~/work/…/bin/claude". */
export function middleEllipsis(text: string, max = 40): string {
  if (text.length <= max) return text;
  if (max < 3) return text.slice(0, Math.max(max - 1, 0)) + "…";
  const tail = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, max - 1 - tail)}…${text.slice(-tail)}`;
}

/** "Todo board (http://127.0.0.1:5/x)" -> "Todo board · 127.0.0.1:5" */
export function pageLine(page: string): string {
  const match = page.match(/^(.*) \((\w+:\/\/[^)]*)\)$/);
  if (!match) return page;
  let host = match[2]!;
  try {
    host = new URL(host).host;
  } catch {
    // keep the text as it came
  }
  return match[1] ? `${match[1]} · ${host}` : host;
}

/** The user messages sent from a different page than the one before, which are the only ones that say the page. */
export function pageChanges(items: readonly Item[]): Set<string> {
  const changed = new Set<string>();
  let last: string | null = null;
  for (const item of items) {
    if (item.kind !== "user") continue;
    if (item.page !== null && item.page !== last) changed.add(item.id);
    last = item.page;
  }
  return changed;
}

/** What the agent can do on the page, after the tool count. Empty when nothing needs saying. */
export function pageLineNote(tab: TabSummary, pageToolsOnly: boolean): string {
  if (tab.webmcpTools.length > 0) return pageToolsOnly ? ", Page tools only" : "";
  if (hasWebMcp(tab))
    return pageToolsOnly
      ? ", none yet, and Page tools only is on"
      : ", none yet, so the agent reads and clicks the page";
  return pageToolsOnly
    ? ", and Page tools only is on, so the agent can't act here"
    : ", so the agent reads and clicks the page";
}
