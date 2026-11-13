/** Runs the browser tools the harness calls, behind the approval policy. */
import { ACTUATION_TOOL_NAMES, STATIC_TOOLS } from "../../shared/browserTools.js";
import { messageOf } from "../../shared/errors.js";
import type { ActivityEntry } from "../../shared/panel.js";
import {
  alwaysKey,
  judge,
  normaliseKey,
  originOf,
  type ApprovalCategory,
  type PolicyInput,
  type TargetElement,
  type Verdict
} from "../../shared/policy.js";
import type { McpToolDescription, ToolResult } from "../../shared/protocol.js";
import type { ApprovalOutcome } from "../../shared/transcript.js";
import { fencePageContent } from "../../shared/untrusted.js";
import { describeMirrored, mirrorPageTools, type PageTool } from "../../shared/webmcp.js";
import * as act from "./actuation.js";
import { isAlwaysAllowed } from "./approvals.js";
import { isWebUrl, targetTab } from "./target.js";
import { callPageTool, listPageTools } from "./webmcp.js";

export interface ToolHost {
  /** Ask the user in this chat; resolves with their answer. */
  approve(
    chatId: string,
    request: {
      tool: string;
      args: Record<string, unknown>;
      origin: string;
      reason: string;
      category: ApprovalCategory;
      scope?: string;
    }
  ): Promise<ApprovalOutcome>;
  activity(entry: ActivityEntry): void;
  /** The user's "Page tools only" setting: no reading, clicking or typing on the page. */
  pageToolsOnly(): boolean;
  /** The tab this chat's turn started on. Calls without a tabId act there, wherever the user looks now. */
  turnTab(chatId: string | null): number | undefined;
}

/** Origins where the user declined something, per chat, until that chat's next message. */
const declinedThisTurn = new Map<string, Set<string>>();
/** Unmarked WebMCP tools the user let through; asked again after Chrome restarts the extension. */
const allowedForNow = new Set<string>();
/** Other sites' tabs the user let a chat reach into, per chat, until that chat's next message. */
const otherTabsThisTurn = new Map<string, Set<string>>();
/** The document each tab's last snapshot was taken on (tabId -> document id). Refs mean nothing on another one. */
const snapshots = new Map<number, string>();

/** A new message from the user: what they declined last turn no longer locks the site. */
export function startTurn(chatId: string): void {
  declinedThisTurn.delete(chatId);
  otherTabsThisTurn.delete(chatId);
}

export const DECLINE_LOCK =
  "The user declined an action on this site in this turn, so nothing else that changes the site runs until they send a new message. Stop and ask them what they want.";
export const STALE_REFS =
  "Refs come from a snapshot of the page this tab shows now, and there is none: the tab is a different one, or the page loaded again. Take a snapshot first.";
const MOVED =
  "The tab moved to another site while this waited for the user, so nothing happened. Look at the page again.";
const CHANGED = "The control changed while this waited for the user, so nothing happened. Take a new snapshot.";

function sameElement(a: TargetElement, b: TargetElement): boolean {
  return a.tag === b.tag && a.type === b.type && a.name === b.name && a.href === b.href && a.inForm === b.inForm;
}

async function requireFreshRefs(tabId: number): Promise<void> {
  if (snapshots.get(tabId) !== (await act.documentId(tabId))) throw new Error(STALE_REFS);
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const failure = (value: string): ToolResult => ({ isError: true, content: [{ type: "text", text: value }] });

export const PAGE_TOOLS_ONLY_REFUSAL =
  'The user turned on "Page tools only": reading, clicking and typing on the page are off. Use the page\'s WebMCP tools (webmcp_list_tools); if none can do this, tell the user.';

async function pageToolsOf(tab: chrome.tabs.Tab): Promise<{ origin: string; tools: PageTool[]; source: string }> {
  if (!tab.id || !isWebUrl(tab.url)) return { origin: "", tools: [], source: "unavailable" };
  try {
    const listed = await listPageTools(tab.id);
    return { origin: originOf(tab.url!), tools: listed.tools, source: listed.source };
  } catch {
    return { origin: originOf(tab.url!), tools: [], source: "unavailable" };
  }
}

export async function listTools(
  host: Pick<ToolHost, "pageToolsOnly" | "turnTab">,
  chatId: string | null = null
): Promise<McpToolDescription[]> {
  const fixed = host.pageToolsOnly()
    ? STATIC_TOOLS.filter((tool) => !ACTUATION_TOOL_NAMES.has(tool.name))
    : [...STATIC_TOOLS];
  const tab = await targetTab(undefined, host.turnTab(chatId)).catch(() => null);
  if (!tab) return fixed;
  const { origin, tools } = await pageToolsOf(tab);
  return [...fixed, ...mirrorPageTools(tools).map((mirrored) => describeMirrored(mirrored, origin))];
}

type Outcome = ActivityEntry["outcome"];

/** A call that ended before its tool ran, with the activity log's word for why. */
class Stopped {
  constructor(
    readonly result: ToolResult,
    readonly outcome: Outcome
  ) {}
}

/** Everything one tool call knows: who asked, which tab, and the checks it can put itself through. */
interface Call {
  host: ToolHost;
  name: string;
  args: Record<string, unknown>;
  tab: chrome.tabs.Tab;
  tabId: number;
  origin: string;
  /** After a decline, nothing else that changes this site runs in this turn, whichever tool asks. */
  locked(): Stopped | null;
  /** Puts the verdict to the user when it needs their yes. `asked` tells whether they were. */
  gate(verdict: Verdict, toolName?: string): Promise<Stopped | { asked: boolean }>;
}

type Handler = (call: Call) => Promise<ToolResult | Stopped>;

async function listWebMcp({ host, tab, origin }: Call): Promise<ToolResult> {
  const { tools, source } = await pageToolsOf(tab);
  if (!tools.length) {
    return text(
      host.pageToolsOnly()
        ? `${tab.url} has no WebMCP tools yet, and the user turned on "Page tools only", so you cannot read or click the page. Tell the user.`
        : `${tab.url} has no WebMCP tools yet. Pages often add them after loading; otherwise use snapshot, then click and type.`
    );
  }
  const lines = tools.map((tool) => {
    const marks = [
      tool.annotations.readOnlyHint && "read-only",
      tool.annotations.consequentialHint && "consequential",
      tool.annotations.untrustedContentHint && "returns untrusted content"
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${tool.name}${marks ? ` (${marks})` : ""}: ${tool.description}\n  input: ${JSON.stringify(tool.inputSchema ?? {})}`;
  });
  const from = source === "native" ? "Chrome's document.modelContext" : "the page's own modelContext";
  return text(
    fencePageContent(origin, `${tools.length} WebMCP tools on "${tab.title ?? ""}" (${from}):\n${lines.join("\n")}`)
  );
}

/** `webmcp_call_tool` names the page tool in its arguments; a mirrored `webmcp_<name>` is the page tool. */
async function callWebMcp(call: Call): Promise<ToolResult | Stopped> {
  const { name, args, tab, tabId, origin } = call;
  const generic = name === "webmcp_call_tool";
  const { tools } = await pageToolsOf(tab);
  const wanted = generic
    ? String(args.name ?? "")
    : mirrorPageTools(tools).find((entry) => entry.mcpName === name)?.pageTool.name;
  const tool = tools.find((entry) => entry.name === wanted);
  if (!tool)
    return failure(`This tab has no WebMCP tool "${wanted ?? name}". Call webmcp_list_tools to see what it has now.`);
  const input = (generic ? (args.arguments as Record<string, unknown> | undefined) : stripTab(args)) ?? {};
  const locked = tool.annotations.readOnlyHint ? null : call.locked();
  if (locked) return locked;
  const gated = await call.gate(
    judge({ tool: "webmcp", toolName: tool.name, annotations: tool.annotations }),
    tool.name
  );
  if (gated instanceof Stopped) return gated;
  const called = await callPageTool(tabId, tool.name, input);
  return called.ok
    ? text(
        fencePageContent(
          origin,
          called.json,
          tool.annotations.untrustedContentHint ? "the page marks this output as untrusted" : undefined
        )
      )
    : failure(`${tool.name} failed in the page:\n${fencePageContent(origin, called.error)}`);
}

/**
 * Click and type share their checks: the site is not locked, the ref is from this page, the user
 * said yes where the policy asks, and the control they said yes to is still the one there.
 */
async function onControl(
  call: Call,
  verdictFor: (element: TargetElement) => Verdict,
  run: (ref: number) => Promise<string>
): Promise<ToolResult | Stopped> {
  const locked = call.locked();
  if (locked) return locked;
  const ref = requireRef(call.args);
  await requireFreshRefs(call.tabId);
  const element = await act.describeElement(call.tabId, ref);
  const gated = await call.gate(verdictFor(element));
  if (gated instanceof Stopped) return gated;
  if (gated.asked && !sameElement(element, await act.describeElement(call.tabId, ref))) return failure(CHANGED);
  return text(await run(ref));
}

const HANDLERS: Record<string, Handler> = {
  webmcp_list_tools: listWebMcp,
  webmcp_call_tool: callWebMcp,
  async snapshot({ tabId, origin }) {
    // Noted before reading: if the page loads again meanwhile, the refs are already stale.
    const doc = await act.documentId(tabId);
    const result = text(fencePageContent(origin, await act.snapshot(tabId)));
    snapshots.set(tabId, doc);
    return result;
  },
  click: (call) =>
    onControl(
      call,
      (element) => judge({ tool: "click", element, pageOrigin: call.origin }),
      (ref) => act.click(call.tabId, ref)
    ),
  type(call) {
    const submit = call.args.submit === true;
    return onControl(
      call,
      (element) => judge({ tool: "type", element, submit }),
      (ref) => act.type(call.tabId, ref, String(call.args.text ?? ""), submit)
    );
  },
  async press_key(call) {
    const locked = call.locked();
    if (locked) return locked;
    const key = normaliseKey(String(call.args.key ?? ""));
    const gated = await call.gate(judge({ tool: "press_key", key }));
    return gated instanceof Stopped ? gated : text(await act.pressKey(call.tabId, key));
  },
  async scroll({ args, tabId }) {
    const direction = args.direction === "up" ? "up" : args.direction === "down" ? "down" : undefined;
    if (args.ref !== undefined) await requireFreshRefs(tabId);
    return text(await act.scroll(tabId, direction, args.ref === undefined ? undefined : requireRef(args)));
  },
  async navigate(call) {
    const locked = call.locked();
    if (locked) return locked;
    const back = call.args.back === true;
    const url = typeof call.args.url === "string" ? call.args.url : null;
    if (!back && !url) return failure("Give a url, or back: true.");
    const gated = await call.gate(
      judge({ tool: "navigate", url, back, pageOrigin: call.origin } satisfies PolicyInput)
    );
    return gated instanceof Stopped ? gated : text(await act.navigate(call.tabId, back ? { back } : { url: url! }));
  },
  async screenshot({ tab, tabId }) {
    const shot = await act.screenshot(tabId);
    return {
      content: [
        { type: "image", data: shot.data, mimeType: shot.mimeType },
        { type: "text", text: `Screenshot of ${tab.url}` }
      ]
    };
  }
};

function handlerFor(name: string): Handler | undefined {
  if (Object.hasOwn(HANDLERS, name)) return HANDLERS[name];
  return name.startsWith("webmcp_") ? callWebMcp : undefined;
}

async function listTabs(host: ToolHost, chatId: string | null): Promise<ToolResult> {
  const tabs = await chrome.tabs.query({});
  const current = await targetTab(undefined, host.turnTab(chatId)).catch(() => null);
  const inView = await targetTab().catch(() => null);
  const lines = await Promise.all(
    tabs
      .filter((tab) => isWebUrl(tab.url))
      .map(async (tab) => {
        const { tools } = tab.id === current?.id ? await pageToolsOf(tab) : { tools: [] as PageTool[] };
        const mark = [
          tab.id === current?.id ? "you work on this one" : "",
          tab.id === inView?.id ? "the user is looking at this one" : ""
        ]
          .filter(Boolean)
          .join("; ");
        return `- tab ${tab.id}: "${tab.title ?? ""}" ${tab.url}${mark ? ` (${mark})` : ""}${tab.id === current?.id ? `, ${tools.length} WebMCP tools` : ""}`;
      })
  );
  // Titles and URLs are the sites' words.
  return text(
    lines.length
      ? fencePageContent("open tabs", lines.join("\n"), "tab titles are written by the sites")
      : "No web pages are open."
  );
}

/**
 * The turn belongs to the page the user was on. A tab of another site is theirs too, but they did
 * not point at it, so even reading it asks: once per site and turn, or never again if they say so.
 */
async function reachIntoOtherTab(call: Call, chatId: string | null): Promise<Stopped | null> {
  const { host, args, tabId, origin } = call;
  if (args.tabId === undefined || args.tabId === null || !origin) return null;
  if (chatId && otherTabsThisTurn.get(chatId)?.has(origin)) return null;
  const home = await targetTab(undefined, host.turnTab(chatId)).catch(() => null);
  const homeOrigin = home && isWebUrl(home.url) ? originOf(home.url!) : "";
  if (home?.id === tabId || homeOrigin === origin) return null;
  // A decline here closes the site for reading too, not only for what changes it.
  const locked = call.locked();
  if (locked) return locked;
  const gated = await call.gate(judge({ tool: "other-tab", tabOrigin: origin }));
  if (gated instanceof Stopped) return gated;
  if (chatId) otherTabsThisTurn.set(chatId, (otherTabsThisTurn.get(chatId) ?? new Set<string>()).add(origin));
  return null;
}

export async function callTool(
  host: ToolHost,
  chatId: string | null,
  harness: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const started = Date.now();
  let origin = "";
  const finish = (result: ToolResult, outcome: Outcome = result.isError ? "failed" : "done"): ToolResult => {
    host.activity({ at: started, chatId, harness, tool: name, origin, outcome, ms: Date.now() - started });
    return result;
  };
  try {
    if (name === "tabs") return finish(await listTabs(host, chatId));

    // Checked before anything else (even before there must be a tab, and before any approval), so a
    // setting the user chose is always reported as such and never put to them as a question.
    if (host.pageToolsOnly() && ACTUATION_TOOL_NAMES.has(name)) {
      const seen = await targetTab(args.tabId, host.turnTab(chatId)).catch(() => null);
      origin = seen && isWebUrl(seen.url) ? originOf(seen.url!) : "";
      return finish(failure(PAGE_TOOLS_ONLY_REFUSAL), "blocked");
    }

    const handler = handlerFor(name);
    if (!handler) return finish(failure(`Unknown browser tool "${name}".`));

    const tab = await targetTab(args.tabId, host.turnTab(chatId));
    const tabId = tab.id!;
    origin = isWebUrl(tab.url) ? originOf(tab.url!) : "";
    const site = origin;
    const call: Call = {
      host,
      name,
      args,
      tab,
      tabId,
      origin: site,
      locked: () =>
        chatId && declinedThisTurn.get(chatId)?.has(site) ? new Stopped(failure(DECLINE_LOCK), "denied") : null,
      async gate(verdict, toolName) {
        if (!verdict.ask || !verdict.category) return { asked: false };
        const scope = toolName ?? verdict.scope;
        const key = alwaysKey(site, verdict.category, scope);
        if (verdict.category === "webmcp-first-use" && allowedForNow.has(key)) return { asked: false };
        if (await isAlwaysAllowed(site, verdict.category, scope)) return { asked: false };
        if (!chatId)
          return new Stopped(
            failure("This action needs the user's approval, and the call did not come from a chat."),
            "denied"
          );
        // What would be typed into a password field is not shown, and so not stored with the chat.
        const shown = verdict.category === "password" ? { ...args, text: "(hidden)" } : args;
        const outcome = await host.approve(chatId, {
          tool: name,
          args: shown,
          origin: site,
          reason: verdict.reason ?? "",
          category: verdict.category,
          scope
        });
        if (outcome === "allowed" || outcome === "always") {
          if (verdict.category === "webmcp-first-use") allowedForNow.add(key);
          // The answer can take minutes. It was given for this site; if the tab is elsewhere now, it does not carry over.
          const now = await targetTab(tabId).catch(() => null);
          if (!now || !isWebUrl(now.url) || originOf(now.url!) !== site) return new Stopped(failure(MOVED), "failed");
          return { asked: true };
        }
        if (outcome === "denied") {
          declinedThisTurn.set(chatId, (declinedThisTurn.get(chatId) ?? new Set<string>()).add(site));
          return new Stopped(
            failure("The user declined this action. Do not try to do it another way; ask them what they want instead."),
            "denied"
          );
        }
        return new Stopped(failure("Nobody answered the approval in time, so nothing happened."), "denied");
      }
    };

    const result = (await reachIntoOtherTab(call, chatId)) ?? (await handler(call));
    return result instanceof Stopped ? finish(result.result, result.outcome) : finish(result);
  } catch (error) {
    return finish(failure(messageOf(error)), "failed");
  }
}

function requireRef(args: Record<string, unknown>): number {
  const ref = Number(args.ref);
  if (!Number.isInteger(ref) || ref <= 0) throw new Error("ref must be a number from the last snapshot, like 42.");
  return ref;
}

function stripTab(args: Record<string, unknown>): Record<string, unknown> {
  const { tabId: _tabId, ...rest } = args;
  return rest;
}

/** What the panel shows under the composer, and what each prompt tells the harness about the tab. */
export async function summariseTab(): Promise<import("../../shared/panel.js").TabSummary | null> {
  const tab = await targetTab().catch(() => null);
  if (!tab?.id) return null;
  const { origin, tools, source } = await pageToolsOf(tab);
  return {
    tabId: tab.id,
    title: tab.title ?? "",
    url: tab.url ?? "",
    origin,
    webmcpTools: tools.map((tool) => tool.name),
    webmcpSource: (source === "native" || source === "page" || source === "none" ? source : "unavailable") as
      "native" | "page" | "none" | "unavailable"
  };
}
