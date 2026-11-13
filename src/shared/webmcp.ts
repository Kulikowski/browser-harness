/** WebMCP tools as the extension reads them from a page, and how they become MCP tools. */
import { STATIC_TOOL_NAMES, mirroredToolName } from "./browserTools.js";
import type { McpToolDescription } from "./protocol.js";
import { fencePageContent } from "./untrusted.js";

export interface WebMcpAnnotations {
  readOnlyHint: boolean;
  /** Draft CG report name. Older drafts and MCP use destructiveHint; we read both. */
  consequentialHint: boolean;
  untrustedContentHint: boolean;
}

export interface PageTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
  annotations: WebMcpAnnotations;
}

export interface MirroredTool {
  mcpName: string;
  pageTool: PageTool;
}

/** One MCP tool per page tool. Names never collide with the static tools or with each other. */
export function mirrorPageTools(tools: readonly PageTool[]): MirroredTool[] {
  const taken = new Set<string>(STATIC_TOOL_NAMES);
  const mirrored: MirroredTool[] = [];
  for (const pageTool of tools) {
    const base = mirroredToolName(pageTool.name).slice(0, 60);
    let mcpName = base;
    for (let n = 2; taken.has(mcpName); n += 1) mcpName = `${base}_${n}`;
    taken.add(mcpName);
    mirrored.push({ mcpName, pageTool });
  }
  return mirrored;
}

export function describeMirrored({ mcpName, pageTool }: MirroredTool, origin: string): McpToolDescription {
  const marks = [
    pageTool.annotations.readOnlyHint ? "read-only" : null,
    pageTool.annotations.consequentialHint ? "consequential, asks the user first" : null
  ].filter(Boolean);
  return {
    name: mcpName,
    title: oneLine(pageTool.title || pageTool.name, 80),
    // The description is the page's own words and lands in the harness's tool list, so it is fenced
    // like everything else a page says.
    description: `WebMCP tool "${pageTool.name}" from ${origin}${marks.length ? ` (${marks.join("; ")})` : ""}. The page describes it as:\n${fencePageContent(origin, pageTool.description.slice(0, DESCRIPTION_LIMIT))}`,
    inputSchema: normaliseSchema(pageTool.inputSchema),
    annotations: {
      readOnlyHint: pageTool.annotations.readOnlyHint,
      destructiveHint: pageTool.annotations.consequentialHint
    }
  };
}

const DESCRIPTION_LIMIT = 1500;

function oneLine(text: string, length: number): string {
  return text
    .replace(/[\p{Cc}\u2028\u2029<>]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, length);
}

/** MCP requires an object schema at the top; WebMCP allows none. */
export function normaliseSchema(schema: Record<string, unknown> | null): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  if (schema.type === undefined) return { type: "object", ...schema };
  return schema;
}

/** Accept whatever shape a page's getTools() hands back and keep only what we use. */
export function readPageTool(raw: unknown): PageTool | null {
  if (!raw || typeof raw !== "object") return null;
  const tool = raw as Record<string, unknown>;
  if (typeof tool.name !== "string" || tool.name.length === 0) return null;
  const annotations = (tool.annotations && typeof tool.annotations === "object" ? tool.annotations : {}) as Record<
    string,
    unknown
  >;
  let inputSchema: Record<string, unknown> | null = null;
  if (typeof tool.inputSchema === "string" && tool.inputSchema !== "") {
    try {
      inputSchema = JSON.parse(tool.inputSchema) as Record<string, unknown>;
    } catch {
      inputSchema = null;
    }
  } else if (tool.inputSchema && typeof tool.inputSchema === "object") {
    inputSchema = tool.inputSchema as Record<string, unknown>;
  }
  return {
    name: tool.name,
    title: typeof tool.title === "string" ? tool.title : "",
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema,
    annotations: {
      readOnlyHint: annotations.readOnlyHint === true,
      consequentialHint: annotations.consequentialHint === true || annotations.destructiveHint === true,
      untrustedContentHint: annotations.untrustedContentHint === true
    }
  };
}
