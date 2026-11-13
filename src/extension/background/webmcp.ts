/**
 * Reading and calling a page's WebMCP tools. The calls run in the page's main world, where
 * document.modelContext lives (WebMCP Draft CG Report: getTools(), executeTool(tool, input)).
 * Older Chrome builds exposed navigator.modelContextTesting; we fall back to it.
 */
import { withTimeout } from "../../shared/timeout.js";
import { readPageTool, type PageTool } from "../../shared/webmcp.js";

export interface PageToolList {
  source: "native" | "page" | "none";
  tools: PageTool[];
}

export type PageCallResult = { ok: true; json: string } | { ok: false; error: string };

const CALL_TIMEOUT_MS = 120_000;
/**
 * How long a page gets to list its tools. The page controls getTools(), and a page that never
 * answers must not hold up the panel or a message.
 */
export const LIST_TIMEOUT_MS = 3000;

export async function listPageTools(tabId: number): Promise<PageToolList> {
  const [frame] = await withTimeout(
    chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: inPageList, args: [LIST_TIMEOUT_MS] }),
    LIST_TIMEOUT_MS + 500,
    "The page"
  );
  const result = frame?.result as { source: PageToolList["source"]; tools: unknown[] } | undefined;
  if (!result) return { source: "none", tools: [] };
  return {
    source: result.source,
    tools: result.tools.map(readPageTool).filter((tool): tool is PageTool => tool !== null)
  };
}

export async function callPageTool(
  tabId: number,
  name: string,
  input: Record<string, unknown>
): Promise<PageCallResult> {
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: inPageCall,
    args: [name, input, CALL_TIMEOUT_MS]
  });
  return (frame?.result as PageCallResult | undefined) ?? { ok: false, error: "The page did not answer." };
}

export const TOOL_CHANGE_MESSAGE = "browser-harness:toolchange";

/**
 * Tells the extension when the page's tools change. Many pages register their tools only after
 * they finish starting up, so a list read at load time is often empty. Chrome fires "toolchange" on
 * document.modelContext; the page's world cannot message the extension, so a listener there raises
 * a DOM event and a second one in the extension's isolated world passes it on. Both are idempotent.
 */
export async function watchPageTools(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: inPageWatch,
    args: [TOOL_CHANGE_MESSAGE]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: inIsolatedRelay,
    args: [TOOL_CHANGE_MESSAGE]
  });
}

// The functions below are serialised into the page: no closures, no imports.

function inPageWatch(eventName: string): void {
  type Watched = EventTarget & Record<symbol, true>;
  const ctx = ((document as unknown as { modelContext?: EventTarget }).modelContext ??
    (navigator as unknown as { modelContext?: EventTarget }).modelContext) as Watched | undefined;
  if (!ctx || typeof ctx.addEventListener !== "function") return;
  // Mark the context rather than window, so no new global appears. A page that looks for it can still
  // find the symbol (and hear the event), which tells it no more than the panel's tool calls do.
  const mark = Symbol.for(eventName);
  if (ctx[mark]) return;
  try {
    Object.defineProperty(ctx, mark, { value: true });
  } catch {
    // A frozen polyfill: watch anyway. A second injection may then add a second listener, which the
    // relay's debounce folds into one message.
  }
  ctx.addEventListener("toolchange", () => window.dispatchEvent(new CustomEvent(eventName)));
}

function inIsolatedRelay(eventName: string): void {
  const TOOL_CHANGE_DEBOUNCE_MS = 150;
  // The extension's isolated world has its own window object, so this flag is invisible to the page.
  const flag = "__webmcpHarnessRelay";
  const win = window as unknown as Record<string, unknown>;
  if (win[flag]) return;
  win[flag] = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener(eventName, () => {
    // Pages register tools in bursts (and anyone can raise this event); one message per burst.
    clearTimeout(timer);
    timer = setTimeout(
      () => void chrome.runtime.sendMessage({ type: eventName }).catch(() => undefined),
      TOOL_CHANGE_DEBOUNCE_MS
    );
  });
}

async function inPageList(timeoutMs: number): Promise<{ source: "native" | "page" | "none"; tools: unknown[] }> {
  // A page that never answers is treated as having no tools yet; the next look tries again.
  const inTime = <T>(work: Promise<T>, fallback: T) =>
    Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))]);
  type Ctx = { getTools?: () => Promise<unknown[]>; isPolyfill?: boolean };
  const ctx = ((document as unknown as { modelContext?: Ctx }).modelContext ??
    (navigator as unknown as { modelContext?: Ctx }).modelContext) as Ctx | undefined;
  const plain = (tool: Record<string, unknown>) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ? { ...(tool.annotations as object) } : undefined,
    origin: tool.origin
  });
  if (ctx && typeof ctx.getTools === "function") {
    const native = !ctx.isPolyfill && Object.prototype.toString.call(ctx) !== "[object Object]";
    const tools = (await inTime(Promise.resolve(ctx.getTools()), [])) as Record<string, unknown>[];
    // Only this document's own tools: an iframe's tools belong to another origin's page.
    const own = tools.filter((tool) => !tool.origin || tool.origin === location.origin);
    return { source: native ? "native" : "page", tools: own.map(plain) };
  }
  const testing = (
    navigator as unknown as { modelContextTesting?: { listTools?: () => unknown[] | Promise<unknown[]> } }
  ).modelContextTesting;
  if (testing && typeof testing.listTools === "function") {
    return {
      source: "native",
      tools: ((await inTime(Promise.resolve(testing.listTools()), [])) as Record<string, unknown>[]).map(plain)
    };
  }
  return { source: "none", tools: [] };
}

async function inPageCall(
  name: string,
  input: Record<string, unknown>,
  timeoutMs: number
): Promise<{ ok: true; json: string } | { ok: false; error: string }> {
  type Ctx = {
    getTools?: () => Promise<{ name: string }[]>;
    executeTool?: (tool: unknown, input: object) => Promise<string>;
  };
  const ctx = ((document as unknown as { modelContext?: Ctx }).modelContext ??
    (navigator as unknown as { modelContext?: Ctx }).modelContext) as Ctx | undefined;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new DOMException(`No answer after ${timeoutMs / 1000} s`, "TimeoutError")), timeoutMs)
  );
  const describe = (error: unknown) => {
    if (error instanceof DOMException || error instanceof Error)
      return error.message ? `${error.name}: ${error.message}` : error.name;
    return String(error);
  };
  try {
    if (ctx && typeof ctx.getTools === "function" && typeof ctx.executeTool === "function") {
      const tool = (await Promise.race([ctx.getTools(), timeout])).find((entry) => entry.name === name);
      if (!tool) return { ok: false, error: `The page has no WebMCP tool named "${name}" (any more).` };
      const json = await Promise.race([ctx.executeTool(tool, input), timeout]);
      return { ok: true, json: typeof json === "string" ? json : JSON.stringify(json ?? null) };
    }
    const testing = (
      navigator as unknown as {
        modelContextTesting?: { executeTool?: (name: string, args: string) => Promise<string | null> };
      }
    ).modelContextTesting;
    if (testing && typeof testing.executeTool === "function") {
      const json = await Promise.race([testing.executeTool(name, JSON.stringify(input)), timeout]);
      return { ok: true, json: json ?? "null" };
    }
    return { ok: false, error: "This page has no WebMCP." };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}
