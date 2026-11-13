/** Messages between the side panel and the service worker (one long-lived runtime port). */
import type { SessionInfo } from "./acp.js";
import type { AuthMethod, HarnessId, HarnessInfo, MissingHarness } from "./protocol.js";
import type { ApprovalOutcome, Chat } from "./transcript.js";

export const PANEL_PORT = "panel";

export type BridgeStatus =
  | { state: "connecting" }
  | { state: "connected"; bridgeVersion: number; defaultCwd: string }
  | { state: "not-installed"; detail: string }
  | { state: "failed"; detail: string };

export interface TabSummary {
  tabId: number;
  title: string;
  url: string;
  origin: string;
  webmcpTools: string[];
  /** "native" when Chrome provides document.modelContext, "page" when the page brought its own. */
  webmcpSource: "native" | "page" | "none" | "unavailable";
}

export interface ActivityEntry {
  at: number;
  chatId: string | null;
  harness: string;
  tool: string;
  origin: string;
  /** "blocked": refused by a setting (Page tools only), not by the user. */
  outcome: "done" | "failed" | "denied" | "blocked";
  ms: number;
}

export interface PanelState {
  bridge: BridgeStatus;
  harnesses: HarnessInfo[];
  missing: MissingHarness[];
  chats: Chat[];
  tab: TabSummary | null;
  cwd: string;
  /** When on, the agent gets only the page's own WebMCP tools: no reading, clicking or typing on the page. */
  pageToolsOnly: boolean;
  activity: ActivityEntry[];
  /** Sign-in needed, by harness: what the harness said and the keyless methods it offers. */
  signIn: Partial<Record<HarnessId, { message: string; methods: AuthMethod[] }>>;
  /** Set when chats could not be saved (e.g. storage is full), so it is never silent. */
  storageError: string | null;
}

export type PanelRequest =
  | { type: "chat.new"; harnessId: HarnessId }
  | { type: "chat.send"; chatId: string; text: string }
  | { type: "chat.cancel"; chatId: string }
  | { type: "chat.delete"; chatId: string }
  | { type: "chat.setMode"; chatId: string; modeId: string }
  | { type: "permission.answer"; chatId: string; requestId: string; optionId: string | null }
  | { type: "approval.answer"; chatId: string; id: string; outcome: Exclude<ApprovalOutcome, "expired"> }
  | { type: "harness.refresh" }
  | { type: "harness.signIn"; harnessId: HarnessId; methodId: string }
  | { type: "sessions.list"; harnessId: HarnessId }
  | { type: "sessions.open"; harnessId: HarnessId; session: SessionInfo }
  | { type: "settings.cwd"; cwd: string }
  | { type: "settings.pageToolsOnly"; on: boolean };

export type PanelReply = { ok: true; data?: unknown } | { ok: false; error: string };

export type ToPanel = { type: "state"; state: PanelState } | { type: "reply"; id: number; reply: PanelReply };
export type FromPanel = { type: "request"; id: number; request: PanelRequest };
