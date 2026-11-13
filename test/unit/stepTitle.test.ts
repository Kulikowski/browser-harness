import { describe, expect, it } from "vitest";
import {
  browserToolName,
  folderName,
  middleEllipsis,
  pageChanges,
  pageLine,
  pageLineNote,
  stepTitle
} from "../../src/extension/sidepanel/format.js";
import type { TabSummary } from "../../src/shared/panel.js";
import type { Item } from "../../src/shared/transcript.js";

describe("browserToolName", () => {
  it("finds our tool behind each harness's naming", () => {
    expect(browserToolName("mcp__browser__webmcp_add_todo")).toBe("webmcp_add_todo");
    expect(browserToolName("Run mcp_browser_67283dd3_type")).toBe("type");
    expect(browserToolName("browser.snapshot")).toBe("snapshot");
    expect(browserToolName("browser__snapshot")).toBe("snapshot");
    expect(browserToolName("Call mcp__browser__click")).toBe("click");
    expect(browserToolName("Use browser/click")).toBe("click");
    expect(browserToolName("  mcp__browser__scroll")).toBe("scroll");
  });

  it("leaves everything else alone", () => {
    expect(browserToolName("Run browser tool add_todo")).toBeNull();
    expect(browserToolName("Bash")).toBeNull();
    expect(browserToolName("")).toBeNull();
  });
});

describe("stepTitle", () => {
  it("names page tools by the page's own name", () => {
    expect(stepTitle("mcp__browser__webmcp_add_todo", { text: "x" })).toBe("Page tool: add_todo");
    expect(stepTitle("mcp__browser__webmcp_call_tool", { name: "getOrderStatus", arguments: {} })).toBe(
      "Page tool: getOrderStatus"
    );
    expect(stepTitle("mcp__browser__webmcp_call_tool", {})).toBe("Page tool: a WebMCP tool");
    expect(stepTitle("mcp__browser__webmcp_list_tools", {})).toBe("List the page's own tools");
  });

  it("says what each browser action did", () => {
    const cases: [string, unknown, string][] = [
      ["Run mcp_browser_67283dd3_snapshot", {}, "Read the page"],
      ["mcp__browser__click", { ref: 3 }, "Click on the page"],
      ["Run mcp_browser_67283dd3_type", { ref: 12, text: "Ada Lovelace" }, 'Type "Ada Lovelace"'],
      ["mcp__browser__type", { ref: 1, text: "hi", submit: true }, 'Type "hi" and press Enter'],
      ["mcp__browser__type", { ref: 1 }, "Type on the page"],
      ["mcp__browser__type", { text: "x".repeat(50) }, `Type "${"x".repeat(40)}…"`],
      ["mcp__browser__press_key", { key: "Enter" }, "Press Enter"],
      ["mcp__browser__press_key", {}, "Press a key"],
      ["mcp__browser__scroll", { direction: "down" }, "Scroll the page"],
      ["mcp__browser__navigate", { url: "https://example.com/a" }, "Open example.com"],
      ["mcp__browser__navigate", { back: true }, "Open a page"],
      ["mcp__browser__screenshot", {}, "Take a screenshot"],
      ["mcp__browser__tabs", {}, "Look at the open tabs"],
      ["mcp__browser__something_new", {}, "Browser: something_new"]
    ];
    for (const [title, input, words] of cases) expect(stepTitle(title, input), title).toBe(words);
  });

  it("copes with input that is not an object", () => {
    expect(stepTitle("mcp__browser__type", null)).toBe("Type on the page");
    expect(stepTitle("mcp__browser__press_key", "Enter")).toBe("Press a key");
  });

  it("says whether Claude Code's tool search was for the browser", () => {
    expect(stepTitle("ToolSearch", { query: "select:mcp__browser__snapshot" })).toBe("Look up the browser tools");
    expect(stepTitle("ToolSearch", { query: "notebook" })).toBe("Look up tools");
  });

  it("keeps the harness's own title for its own tools", () => {
    expect(stepTitle("Read file", { path: "/x" })).toBe("Read file");
  });
});

describe("folderName and middleEllipsis", () => {
  it("takes the last folder of a path", () => {
    expect(folderName("/Users/k/proj")).toBe("proj");
    expect(folderName("/Users/k/proj/")).toBe("proj");
    expect(folderName("/")).toBe("/");
    expect(folderName("")).toBe("");
  });

  it("shortens in the middle and keeps the end", () => {
    const short = middleEllipsis("~/a/b/c/d/e/bin/claude", 12);
    expect(short).toHaveLength(12);
    expect(short.endsWith("claude")).toBe(true);
    expect(short).toContain("…");
    expect(middleEllipsis("~/bin/agy", 12)).toBe("~/bin/agy");
  });

  it("never returns more than it was given room for", () => {
    for (const max of [0, 1, 2, 3, 5])
      expect(middleEllipsis("abcdefghij", max).length).toBeLessThanOrEqual(Math.max(max, 1));
  });
});

describe("pageLine and pageChanges", () => {
  it("shows the page as its title and host", () => {
    expect(pageLine("Todo board (http://127.0.0.1:5/x)")).toBe("Todo board · 127.0.0.1:5");
    expect(pageLine(" (https://a.b/)")).toBe("a.b");
    expect(pageLine("Just a title")).toBe("Just a title");
  });

  it("marks only the messages sent from a different page than the one before", () => {
    const user = (id: string, page: string | null): Item => ({ kind: "user", id, text: id, at: 0, page });
    const items: Item[] = [
      user("1", "A"),
      user("2", "A"),
      { kind: "agent", id: "x", text: "hi" },
      user("3", "B"),
      user("4", null),
      user("5", "B")
    ];
    expect([...pageChanges(items)]).toEqual(["1", "3", "5"]);
  });
});

describe("pageLineNote", () => {
  const tab = (webmcpTools: string[], webmcpSource: TabSummary["webmcpSource"]): TabSummary => ({
    tabId: 1,
    title: "T",
    url: "https://a/",
    origin: "https://a",
    webmcpTools,
    webmcpSource
  });

  it("says nothing extra when the page has tools", () => {
    expect(pageLineNote(tab(["a"], "native"), false)).toBe("");
    expect(pageLineNote(tab(["a"], "native"), true)).toBe(", Page tools only");
  });

  it("says tools may still come when the page has WebMCP but none yet", () => {
    expect(pageLineNote(tab([], "native"), false)).toBe(", none yet, so the agent reads and clicks the page");
    expect(pageLineNote(tab([], "page"), true)).toBe(", none yet, and Page tools only is on");
  });

  it("says what happens on a page without WebMCP", () => {
    expect(pageLineNote(tab([], "none"), false)).toBe(", so the agent reads and clicks the page");
    expect(pageLineNote(tab([], "unavailable"), true)).toBe(", and Page tools only is on, so the agent can't act here");
  });
});
