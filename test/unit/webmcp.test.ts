import { describe, expect, it } from "vitest";
import { STATIC_TOOL_NAMES } from "../../src/shared/browserTools.js";
import { withTimeout } from "../../src/shared/timeout.js";
import { describeMirrored, mirrorPageTools, normaliseSchema, readPageTool } from "../../src/shared/webmcp.js";

describe("readPageTool", () => {
  it("reads Chrome's RegisteredTool shape, where inputSchema is a JSON string", () => {
    const tool = readPageTool({
      name: "add_todo",
      description: "Add",
      inputSchema: '{"type":"object","properties":{"text":{"type":"string"}}}',
      annotations: { readOnlyHint: false }
    });
    expect(tool).toEqual({
      name: "add_todo",
      title: "",
      description: "Add",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false }
    });
  });

  it("accepts an object schema and the older destructiveHint", () => {
    const tool = readPageTool({
      name: "wipe",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: true }
    });
    expect(tool?.annotations.consequentialHint).toBe(true);
    expect(tool?.inputSchema).toEqual({ type: "object" });
  });

  it("drops tools without a name and survives a broken schema", () => {
    expect(readPageTool({ description: "no name" })).toBeNull();
    expect(readPageTool(null)).toBeNull();
    expect(readPageTool({ name: "x", inputSchema: "{not json" })?.inputSchema).toBeNull();
  });
});

describe("mirrorPageTools", () => {
  it("prefixes names and never collides with the static tools or each other", () => {
    const tools = ["snapshot", "list_tools", "a", "a", "a_2"].map((name) => readPageTool({ name })!);
    const names = mirrorPageTools(tools).map((tool) => tool.mcpName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(STATIC_TOOL_NAMES.has(name)).toBe(false);
    expect(names[0]).toBe("webmcp_snapshot");
  });
});

describe("describeMirrored", () => {
  it("says where the tool comes from and maps consequential to destructiveHint", () => {
    const [mirrored] = mirrorPageTools([
      readPageTool({ name: "clear", description: "Clear all", annotations: { consequentialHint: true } })!
    ]);
    const described = describeMirrored(mirrored!, "https://a.example");
    expect(described.description).toBe(
      'WebMCP tool "clear" from https://a.example (consequential, asks the user first). The page describes it as:\n<page-content origin="https://a.example" trust="untrusted">\nClear all\n</page-content>'
    );
    expect(described.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(described.inputSchema).toEqual({ type: "object", properties: {} });
  });
});

describe("normaliseSchema", () => {
  it("gives MCP an object schema", () => {
    expect(normaliseSchema(null)).toEqual({ type: "object", properties: {} });
    expect(normaliseSchema({ properties: { a: {} } })).toEqual({ type: "object", properties: { a: {} } });
    expect(normaliseSchema({ type: "object", required: ["a"] })).toEqual({ type: "object", required: ["a"] });
  });
});

describe("withTimeout", () => {
  it("passes a timely answer through and gives up on one that never comes", async () => {
    await expect(withTimeout(Promise.resolve(7), 50, "The page")).resolves.toBe(7);
    await expect(withTimeout(new Promise(() => {}), 20, "The page")).rejects.toThrow(
      "The page did not answer within 0.02 s"
    );
  });
});
