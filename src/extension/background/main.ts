/**
 * Service worker: owns the chats, the native port to the bridge, the browser tools and approvals.
 * The side panel only draws state and sends what the user did.
 *
 * Chrome may stop an idle service worker; an open native messaging port keeps it alive while the
 * bridge runs, and chats are saved to chrome.storage.local, so a restart loses nothing but the
 * live harness processes (sessions are reopened with session/resume or session/load on the next message).
 */
import { pageContext } from "../../shared/context.js";
import { messageOf } from "../../shared/errors.js";
import {
  PANEL_PORT,
  type ActivityEntry,
  type BridgeStatus,
  type FromPanel,
  type PanelReply,
  type PanelRequest,
  type PanelState,
  type TabSummary,
  type ToPanel
} from "../../shared/panel.js";
import type { FromBridge, HarnessInfo, MissingHarness } from "../../shared/protocol.js";
import { applyEvent, newChat, type Chat, type ChatEvent } from "../../shared/transcript.js";
import { detachAll } from "./actuation.js";
import { ACTIVITY_KEY, ChatStore } from "./chatStore.js";
import { answerApproval, expireApprovals, newApprovalId, waitForApproval } from "./approvals.js";
import { BridgeError, NativeBridge } from "./native.js";
import { rememberTab } from "./target.js";
import { callTool, listTools, startTurn, summariseTab, type ToolHost } from "./tools.js";
import { LIST_TIMEOUT_MS, TOOL_CHANGE_MESSAGE, watchPageTools } from "./webmcp.js";

const SETTINGS = "settings";
const ACTIVITY_LIMIT = 200;

let chats = new Map<string, Chat>();
let harnesses: HarnessInfo[] = [];
let missing: MissingHarness[] = [];
let bridgeStatus: BridgeStatus = { state: "connecting" };
let tab: TabSummary | null = null;
let cwdSetting = "";
let pageToolsOnly = false;

interface StoredSettings {
  cwd: string;
  pageToolsOnly: boolean;
}
let activity: ActivityEntry[] = [];
const signIn: PanelState["signIn"] = {};
/** Chats whose ACP session is open in the current bridge process. */
const live = new Set<string>();
/** The tab each chat's current turn started on: where its tool calls act unless they name another tab. */
const turnTabs = new Map<string, number>();
let storageError: string | null = null;
const panels = new Set<chrome.runtime.Port>();
let loaded: Promise<void> | null = null;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error("side panel behaviour", error));

const bridge = new NativeBridge({
  message: (message) => void onBridgeMessage(message),
  disconnected: (reason, notInstalled) => {
    live.clear();
    bridgeStatus = notInstalled ? { state: "not-installed", detail: reason } : { state: "failed", detail: reason };
    for (const chat of chats.values())
      if (chat.state === "working" || chat.state === "waiting" || chat.state === "starting")
        apply(chat.id, { type: "closed", reason: `The bridge stopped: ${reason}` });
    expireApprovals();
    releasePages();
    broadcast();
  }
});

const isActive = (chat: Chat) => chat.state === "working" || chat.state === "waiting" || chat.state === "starting";

/**
 * Let go of the pages once no turn is running: Chrome shows its "started debugging this browser" bar
 * for as long as we stay attached, and nobody needs it between turns.
 */
function releasePages(): void {
  if (![...chats.values()].some(isActive)) void detachAll();
}

async function load(): Promise<void> {
  const { chats: list, rest: stored } = await store.load();
  // A turn cannot survive a service-worker restart; say so instead of spinning forever.
  chats = new Map(
    list.map((chat) => [
      chat.id,
      chat.state === "working" || chat.state === "waiting" || chat.state === "starting"
        ? applyEvent(
            chat,
            { type: "closed", reason: "Chrome restarted the extension in the middle of this turn." },
            Date.now()
          )
        : chat
    ])
  );
  const settings = (stored[SETTINGS] as Partial<StoredSettings> | undefined) ?? {};
  cwdSetting = (settings.cwd ?? "").trim();
  pageToolsOnly = settings.pageToolsOnly === true;
  activity = (stored[ACTIVITY_KEY] as ActivityEntry[] | undefined) ?? [];
}

function ready(): Promise<void> {
  loaded ??= load().then(connectBridge);
  return loaded;
}

async function connectBridge(): Promise<void> {
  if (bridge.connected) return;
  bridgeStatus = { state: "connecting" };
  broadcast();
  try {
    bridge.connect();
    const hello = await bridge.request<{
      bridgeVersion: number;
      defaultCwd: string;
      found: HarnessInfo[];
      missing: MissingHarness[];
    }>({ type: "hello", extensionVersion: chrome.runtime.getManifest().version });
    harnesses = hello.found;
    missing = hello.missing;
    bridgeStatus = { state: "connected", bridgeVersion: hello.bridgeVersion, defaultCwd: hello.defaultCwd };
  } catch (error) {
    if (bridgeStatus.state === "connecting") bridgeStatus = { state: "failed", detail: messageOf(error) };
  }
  broadcast();
}

// ---------- state, persistence, broadcast ----------

const store = new ChatStore({
  storage: chrome.storage.local,
  chat: (id) => chats.get(id),
  activity: () => activity,
  saved(error) {
    const next =
      error === null
        ? null
        : `Chats could not be saved, so they may be gone after a restart: ${messageOf(error)} Delete old chats to make room.`;
    if (error !== null) console.error("saving chats", error);
    if (next === storageError) return;
    storageError = next;
    broadcast();
  }
});
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

function apply(chatId: string, event: ChatEvent): Chat | undefined {
  const chat = chats.get(chatId);
  if (!chat) return undefined;
  const next = applyEvent(chat, event, Date.now());
  chats.set(chatId, next);
  store.chatChanged(chatId);
  broadcast();
  updateBadge();
  return next;
}

function state(): PanelState {
  return {
    bridge: bridgeStatus,
    harnesses,
    missing,
    chats: [...chats.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    tab,
    cwd: currentCwd(),
    pageToolsOnly,
    activity,
    signIn,
    storageError
  };
}

/** Coalesce bursts of streamed chunks into one redraw per frame-ish. */
function broadcast(): void {
  broadcastTimer ??= setTimeout(() => {
    broadcastTimer = null;
    const message: ToPanel = { type: "state", state: state() };
    for (const port of panels) port.postMessage(message);
  }, 16);
}

function updateBadge(): void {
  const waiting = [...chats.values()].filter((chat) => chat.state === "waiting").length;
  void chrome.action.setBadgeText({ text: waiting ? String(waiting) : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#9A5B00" });
}

function currentCwd(): string {
  return cwdSetting || (bridgeStatus.state === "connected" ? bridgeStatus.defaultCwd : "");
}

// ---------- the bridge talking to us ----------

const toolHost: ToolHost = {
  pageToolsOnly: () => pageToolsOnly,
  turnTab: (chatId) => (chatId ? turnTabs.get(chatId) : undefined),
  async approve(chatId, request) {
    const id = newApprovalId();
    if (
      !apply(chatId, {
        type: "approval",
        id,
        tool: request.tool,
        args: request.args,
        origin: request.origin,
        reason: request.reason,
        category: request.category
      })
    )
      return "denied";
    return waitForApproval(chatId, id, request.origin, request.category, request.scope, () =>
      apply(chatId, { type: "approval-resolved", id, outcome: "expired" })
    );
  },
  activity(entry) {
    activity = [entry, ...activity].slice(0, ACTIVITY_LIMIT);
    store.activityAdded();
    broadcast();
  }
};

async function onBridgeMessage(message: FromBridge): Promise<void> {
  switch (message.type) {
    case "harnesses":
      harnesses = message.found;
      missing = message.missing;
      broadcast();
      return;
    case "session.ready":
      live.add(message.chatId);
      apply(message.chatId, {
        type: "ready",
        acpSessionId: message.acpSessionId,
        modes: message.modes,
        currentModeId: message.currentModeId,
        replayed: message.replayed
      });
      return;
    case "session.update":
      apply(message.chatId, { type: "update", update: message.update, replay: message.replay });
      return;
    case "session.turnEnded": {
      const harnessId = chats.get(message.chatId)?.harnessId;
      if (message.authRequired && harnessId)
        signIn[harnessId] = { message: message.error ?? "Sign in to this agent first.", methods: message.authRequired };
      apply(message.chatId, { type: "turn-ended", stopReason: message.stopReason, error: message.error });
      releasePages();
      return;
    }
    case "session.exited":
      live.delete(message.chatId);
      expireApprovals(message.chatId);
      apply(message.chatId, { type: "closed", reason: message.reason });
      releasePages();
      return;
    case "permission.request":
      apply(message.chatId, {
        type: "permission",
        requestId: message.requestId,
        toolCall: message.toolCall,
        options: message.options
      });
      return;
    case "permission.withdrawn":
      apply(message.chatId, { type: "permission-resolved", requestId: message.requestId, outcome: "cancelled" });
      return;
    case "browser.listTools": {
      const tools = await listTools(toolHost, message.chatId);
      bridge.post({ type: "browser.toolsResult", callId: message.callId, tools });
      return;
    }
    case "browser.call": {
      const harness = harnesses.find((entry) => entry.id === message.harnessId)?.name ?? message.harnessId ?? "unknown";
      const result = await callTool(toolHost, message.chatId, harness, message.name, message.arguments);
      bridge.post({ type: "browser.callResult", callId: message.callId, result });
      void refreshTab();
      return;
    }
    case "log":
      console[message.level === "error" ? "error" : message.level === "warn" ? "warn" : "info"](
        "[bridge]",
        message.message
      );
      return;
  }
}

// ---------- the panel talking to us ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  panels.add(port);
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    if (panels.size === 0) {
      stopWatching();
      releasePages();
    }
  });
  // The page was not watched while no panel was open; start now.
  watchedPage = "";
  void ready().then(refreshTab);
  port.onMessage.addListener((message: FromPanel) => {
    void (async () => {
      let reply: PanelReply;
      try {
        await ready();
        reply = { ok: true, data: await handle(message.request) };
      } catch (error) {
        reply = { ok: false, error: messageOf(error) };
      }
      port.postMessage({ type: "reply", id: message.id, reply } satisfies ToPanel);
    })();
  });
  void ready().then(async () => {
    if (!bridge.connected) await connectBridge();
    await refreshTab();
    port.postMessage({ type: "state", state: state() } satisfies ToPanel);
  });
});

async function handle(request: PanelRequest): Promise<unknown> {
  switch (request.type) {
    case "chat.new": {
      const harness = harnesses.find((entry) => entry.id === request.harnessId);
      if (!harness) throw new Error("That harness is not installed on this machine.");
      const chat = newChat({
        id: crypto.randomUUID(),
        harnessId: harness.id,
        harnessName: harness.name,
        cwd: currentCwd(),
        now: Date.now()
      });
      chats.set(chat.id, chat);
      broadcast();
      await openSession(chat.id, () =>
        bridge.request({ type: "session.new", chatId: chat.id, harnessId: harness.id, cwd: chat.cwd })
      );
      return chat.id;
    }
    case "chat.send":
      return send(request.chatId, request.text);
    case "chat.cancel": {
      const chat = chats.get(request.chatId);
      if (!chat) return null;
      // Only this chat's slips: another chat's question is still that chat's to answer.
      expireApprovals(chat.id);
      if (live.has(chat.id)) await bridge.request({ type: "session.cancel", chatId: chat.id });
      return null;
    }
    case "chat.delete":
      if (live.has(request.chatId))
        await bridge.request({ type: "session.close", chatId: request.chatId }).catch(() => undefined);
      expireApprovals(request.chatId);
      live.delete(request.chatId);
      turnTabs.delete(request.chatId);
      chats.delete(request.chatId);
      store.chatDeleted(request.chatId);
      broadcast();
      return null;
    case "chat.setMode":
      await ensureOpen(request.chatId);
      await bridge.request({ type: "session.setMode", chatId: request.chatId, modeId: request.modeId });
      // The agent's answer is its yes. Not every agent also sends current_mode_update for a mode we
      // asked for (Claude Code does not), so the chat records the change itself.
      apply(request.chatId, {
        type: "update",
        update: { sessionUpdate: "current_mode_update", currentModeId: request.modeId },
        replay: false
      });
      return null;
    case "permission.answer": {
      const chat = chats.get(request.chatId);
      const item = chat?.items.find((entry) => entry.kind === "permission" && entry.id === request.requestId);
      if (!item || item.kind !== "permission" || item.outcome !== null) return null;
      const option = item.options.find((entry) => entry.optionId === request.optionId);
      bridge.post({
        type: "permission.respond",
        requestId: request.requestId,
        optionId: option ? option.optionId : null
      });
      apply(request.chatId, {
        type: "permission-resolved",
        requestId: request.requestId,
        outcome: option ? { optionId: option.optionId, name: option.name, kind: option.kind } : "cancelled"
      });
      return null;
    }
    case "approval.answer":
      if (await answerApproval(request.id, request.outcome))
        apply(request.chatId, { type: "approval-resolved", id: request.id, outcome: request.outcome });
      return null;
    case "harness.refresh":
      if (!bridge.connected) await connectBridge();
      else await bridge.request({ type: "detect" });
      return null;
    case "harness.signIn":
      await bridge.request({ type: "harness.authenticate", harnessId: request.harnessId, methodId: request.methodId });
      delete signIn[request.harnessId];
      broadcast();
      return null;
    case "sessions.list":
      return bridge.request({ type: "session.list", harnessId: request.harnessId, cwd: null });
    case "sessions.open": {
      const harness = harnesses.find((entry) => entry.id === request.harnessId);
      if (!harness) throw new Error("That harness is not installed on this machine.");
      const existing = [...chats.values()].find((chat) => chat.acpSessionId === request.session.sessionId);
      if (existing) return existing.id;
      const chat = {
        ...newChat({
          id: crypto.randomUUID(),
          harnessId: harness.id,
          harnessName: harness.name,
          cwd: request.session.cwd,
          now: Date.now()
        }),
        acpSessionId: request.session.sessionId,
        title: request.session.title || "Session from the terminal"
      };
      chats.set(chat.id, chat);
      apply(chat.id, { type: "reset-for-replay" });
      await openSession(chat.id, () =>
        bridge.request({
          type: "session.reopen",
          chatId: chat.id,
          harnessId: harness.id,
          acpSessionId: request.session.sessionId,
          cwd: chat.cwd,
          wantHistory: true
        })
      );
      return chat.id;
    }
    case "settings.cwd": {
      const cwd = request.cwd.trim();
      if (cwd && !cwd.startsWith("/")) throw new Error("Use an absolute folder path, like /Users/you/project.");
      cwdSetting = cwd;
      await saveSettings();
      broadcast();
      return null;
    }
    case "settings.pageToolsOnly": {
      pageToolsOnly = request.on;
      await saveSettings();
      // Harnesses that refresh on list_changed drop or regain the page-reading tools right away.
      if (bridge.connected) bridge.post({ type: "browser.toolsChanged" });
      broadcast();
      return null;
    }
  }
}

/** Both settings live in one record, so each change writes the whole of it. */
async function saveSettings(): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS]: { cwd: cwdSetting, pageToolsOnly } satisfies StoredSettings });
}

async function openSession(chatId: string, open: () => Promise<unknown>): Promise<void> {
  const chat = chats.get(chatId)!;
  try {
    await open();
    delete signIn[chat.harnessId];
  } catch (error) {
    if (error instanceof BridgeError && error.reply && !error.reply.ok && error.reply.authRequired) {
      signIn[chat.harnessId] = { message: error.message, methods: error.reply.authRequired };
    }
    apply(chatId, { type: "error", text: messageOf(error) });
    throw error;
  }
}

/** The chat's session, open in the bridge: reopened after a restart, or made if it never was. */
async function ensureOpen(chatId: string): Promise<void> {
  const chat = chats.get(chatId);
  if (!chat) throw new Error("That chat no longer exists.");
  if (!bridge.connected) await connectBridge();
  if (live.has(chatId)) return;
  if (chat.acpSessionId) {
    await openSession(chatId, () =>
      bridge.request({
        type: "session.reopen",
        chatId,
        harnessId: chat.harnessId,
        acpSessionId: chat.acpSessionId!,
        cwd: chat.cwd,
        wantHistory: false
      })
    );
  } else {
    await openSession(chatId, () =>
      bridge.request({ type: "session.new", chatId, harnessId: chat.harnessId, cwd: chat.cwd })
    );
  }
}

async function send(chatId: string, text: string): Promise<null> {
  const chat = chats.get(chatId);
  if (!chat) throw new Error("That chat no longer exists.");
  if (!text.trim()) return null;
  await ensureOpen(chatId);
  // The page line is a courtesy: a page that is slow to say what it offers must not hold up the message.
  await Promise.race([refreshTab(), new Promise<void>((resolve) => setTimeout(resolve, SEND_PAGE_WAIT_MS))]);
  // The turn works on the tab in view now, and stays there if the user looks elsewhere meanwhile.
  if (tab) turnTabs.set(chatId, tab.tabId);
  else turnTabs.delete(chatId);
  startTurn(chatId);
  const promptId = `u-${Date.now().toString(36)}`;
  apply(chatId, { type: "prompt", id: promptId, text, page: tab ? `${tab.title} (${tab.url})` : null });
  await bridge.request({ type: "session.prompt", chatId, text, pageContext: pageContext(tab, { pageToolsOnly }) });
  return null;
}

// ---------- tabs ----------

let lastToolsKey = "";

/**
 * When to look at a freshly loaded page's tools again, for pages that register them late and whose
 * WebMCP cannot announce it with "toolchange".
 */
const TOOL_RECHECK_MS = [1500, 4000, 10_000, 25_000] as const;

/** The longest a message waits for the page line to be brought up to date. */
const SEND_PAGE_WAIT_MS = LIST_TIMEOUT_MS + 1000;

/** The page load we are watching ("tabId url"); cleared when the tab starts loading again. */
let watchedPage = "";
let recheckTimers: ReturnType<typeof setTimeout>[] = [];

/** With no panel open nothing needs the page's tools, so stop looking. */
function stopWatching(): void {
  for (const timer of recheckTimers) clearTimeout(timer);
  recheckTimers = [];
  watchedPage = "";
}
/** Overlapping refreshes finish out of order; only the newest one may set the tab. */
let refreshGeneration = 0;
let latestRefresh: Promise<void> = Promise.resolve();

/** Brings `tab` up to date. Resolves only once the newest refresh has landed, so callers can read `tab`. */
function refreshTab(): Promise<void> {
  latestRefresh = refreshOnce(++refreshGeneration);
  return latestRefresh;
}

async function refreshOnce(generation: number): Promise<void> {
  const next = await summariseTab().catch(() => null);
  // A newer refresh started meanwhile: wait for it rather than return with `tab` not yet current.
  if (generation !== refreshGeneration) return latestRefresh;
  tab = next;
  const page = tab ? `${tab.tabId} ${tab.url}` : "";
  // Only while a panel is open: nobody needs the page watched otherwise.
  if (tab && page !== watchedPage && panels.size > 0) {
    watchedPage = page;
    const tabId = tab.tabId;
    // Hear about tools the page registers later, and look again a few times for pages whose
    // WebMCP cannot announce changes (or appears late itself, so watch again each time).
    void watchPageTools(tabId).catch(() => undefined);
    for (const timer of recheckTimers) clearTimeout(timer);
    recheckTimers = TOOL_RECHECK_MS.map((ms) =>
      setTimeout(() => {
        if (panels.size === 0) return;
        if (tab?.tabId === tabId) void watchPageTools(tabId).catch(() => undefined);
        void refreshTab();
      }, ms)
    );
  }
  const key = tab ? `${tab.tabId} ${tab.url} ${tab.webmcpTools.join(",")}` : "";
  if (key !== lastToolsKey) {
    lastToolsKey = key;
    if (bridge.connected) bridge.post({ type: "browser.toolsChanged" });
  }
  broadcast();
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void rememberTab(tabId).then(refreshTab);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A reload (even of the same URL) is a new page: its watcher is gone, so watch it again.
  if (info.status === "loading" && tabId === tab?.tabId) watchedPage = "";
  if (info.status === "complete") void rememberTab(tabId).then(refreshTab);
});
chrome.windows.onFocusChanged.addListener(() => void refreshTab());
chrome.runtime.onMessage.addListener((message: { type?: string }, sender) => {
  if (message?.type === TOOL_CHANGE_MESSAGE && sender.tab?.id !== undefined && sender.tab.id === tab?.tabId)
    void refreshTab();
});

chrome.runtime.onStartup.addListener(() => void ready());
chrome.runtime.onInstalled.addListener(() => void ready());
