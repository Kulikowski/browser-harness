/**
 * The browser, as tools. The bridge's MCP server advertises these to the harness; the extension
 * runs them. Two families:
 *  - WebMCP: the page's own tools (document.modelContext), mirrored one MCP tool per WebMCP tool,
 *    plus a generic list/call pair for harnesses that cache their tool list.
 *  - Actuation: for pages without WebMCP. An accessibility snapshot with numbered refs, then
 *    click / type / press / scroll by ref, navigate, screenshot, all over
 *    chrome.debugger.
 */
import type { McpToolDescription } from "./protocol.js";

const tabId = { type: "integer", description: "Tab to act on. Omit to use the tab the user is looking at." } as const;

export const WEBMCP_PREFIX = "webmcp_";

export const STATIC_TOOLS: readonly McpToolDescription[] = [
  {
    name: "tabs",
    title: "List tabs",
    description:
      "List the open tabs: id, title, URL, which one you work on (the tab the user was looking at when they sent their message) and which one they look at now. Pass a tabId to another tool to act on a different tab; a tab of another site asks the user first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "webmcp_list_tools",
    title: "List the page's WebMCP tools",
    description:
      "List the WebMCP tools the page registered (document.modelContext): name, description, input schema and annotations. Prefer these tools over clicking: they are the page's own API.",
    inputSchema: { type: "object", properties: { tabId }, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "webmcp_call_tool",
    title: "Call a WebMCP tool",
    description:
      "Call one of the page's WebMCP tools by name with a JSON arguments object that matches its input schema. Tools the page marks consequential ask the user first.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, arguments: { type: "object" }, tabId },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    name: "snapshot",
    title: "Read the page",
    description:
      "Read the page as text in page order: headings with '#' marks for their level, text, and every control as '[ref] role \"name\"' with its value and state. Use the ref with click, type and scroll. Take a new snapshot after the page changes; refs from an old one may be gone.",
    inputSchema: { type: "object", properties: { tabId }, additionalProperties: false },
    annotations: { readOnlyHint: true }
  },
  {
    name: "click",
    title: "Click",
    description:
      "Click the control with this ref from the last snapshot. Submitting, buying, deleting or sending asks the user first.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "integer" }, tabId },
      required: ["ref"],
      additionalProperties: false
    }
  },
  {
    name: "type",
    title: "Type",
    description:
      "Replace the text in the field with this ref. Set submit to press Enter afterwards (asks the user first).",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "integer" }, text: { type: "string" }, submit: { type: "boolean" }, tabId },
      required: ["ref", "text"],
      additionalProperties: false
    }
  },
  {
    name: "press_key",
    title: "Press a key",
    description:
      "Press one key in the focused element, e.g. Escape, Tab, ArrowDown, Enter, Space (Enter and Space ask the user first).",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, tabId },
      required: ["key"],
      additionalProperties: false
    }
  },
  {
    name: "scroll",
    title: "Scroll",
    description: "Scroll the page up or down by most of a screen, or scroll the control with this ref into view.",
    inputSchema: {
      type: "object",
      properties: { direction: { type: "string", enum: ["up", "down"] }, ref: { type: "integer" }, tabId },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "navigate",
    title: "Open a URL",
    description: "Open an http(s) URL in the tab, or go back. Leaving the current site asks the user first.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, back: { type: "boolean" }, tabId },
      additionalProperties: false
    }
  },
  {
    name: "screenshot",
    title: "Screenshot",
    description: "A JPEG of what the tab shows right now. Use snapshot first; it is cheaper and gives refs.",
    inputSchema: { type: "object", properties: { tabId }, additionalProperties: false },
    annotations: { readOnlyHint: true }
  }
];

export const STATIC_TOOL_NAMES = new Set(STATIC_TOOLS.map((tool) => tool.name));

/** The tools that read or drive the page itself rather than through its WebMCP tools. "Page tools only" removes these. */
export const ACTUATION_TOOL_NAMES = new Set([
  "snapshot",
  "click",
  "type",
  "press_key",
  "scroll",
  "navigate",
  "screenshot"
]);

/** MCP tool names allow [A-Za-z0-9_-]; WebMCP names also allow '.'. Map it, and keep the result unique. */
export function mirroredToolName(webmcpName: string): string {
  return WEBMCP_PREFIX + webmcpName.replace(/[^A-Za-z0-9_-]/g, "_");
}
