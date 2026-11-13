/**
 * Messages between the extension's service worker and the local bridge (native messaging host).
 * One JSON object per native-messaging frame. Requests carry `id`; the reply echoes it.
 * Keep this file the single contract: both sides import it, and tests check it round-trips.
 */
import type { PermissionOption, SessionInfo, SessionMode, SessionUpdate, StopReason, ToolCallFields } from "./acp.js";

export const NATIVE_HOST_NAME = "com.kulikowski.browser_harness";
export const BRIDGE_PROTOCOL_VERSION = 1;

export type HarnessId = "claude" | "codex" | "antigravity" | "fake";

export interface HarnessInfo {
  id: HarnessId;
  name: string;
  /** The program we found on this machine, e.g. /opt/homebrew/bin/claude. */
  foundAt: string;
  version: string | null;
  /** What the bridge runs to speak ACP, shown so nothing is hidden. */
  launch: string;
}

export interface MissingHarness {
  id: HarnessId;
  name: string;
  installHint: string;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

/** MCP-style tool result the extension returns for a browser tool call. */
export interface ToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

export interface McpToolDescription {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
}

// ---------- extension -> bridge ----------

export type ToBridge =
  | { type: "hello"; id: string; extensionVersion: string }
  | { type: "detect"; id: string }
  | { type: "session.new"; id: string; chatId: string; harnessId: HarnessId; cwd: string }
  /** Reattach a chat to its harness session after a restart, or open one made in the harness's own UI (wantHistory). */
  | {
      type: "session.reopen";
      id: string;
      chatId: string;
      harnessId: HarnessId;
      acpSessionId: string;
      cwd: string;
      wantHistory: boolean;
    }
  | { type: "session.list"; id: string; harnessId: HarnessId; cwd: string | null }
  | { type: "session.prompt"; id: string; chatId: string; text: string; pageContext: string | null }
  | { type: "session.cancel"; id: string; chatId: string }
  | { type: "session.close"; id: string; chatId: string }
  | { type: "session.setMode"; id: string; chatId: string; modeId: string }
  /** Run one of the harness's own keyless sign-in methods (e.g. "Log in with Google"). Never a key. */
  | { type: "harness.authenticate"; id: string; harnessId: HarnessId; methodId: string }
  | { type: "permission.respond"; requestId: string; optionId: string | null }
  | { type: "browser.toolsResult"; callId: string; tools: McpToolDescription[] }
  | { type: "browser.callResult"; callId: string; result: ToolResult }
  | { type: "browser.toolsChanged" };

// ---------- bridge -> extension ----------

export type FromBridge =
  | { type: "reply"; id: string; ok: true; data?: unknown }
  | { type: "reply"; id: string; ok: false; error: string; authRequired?: AuthMethod[] }
  | { type: "harnesses"; found: HarnessInfo[]; missing: MissingHarness[] }
  | {
      type: "session.ready";
      chatId: string;
      acpSessionId: string;
      modes: SessionMode[];
      currentModeId: string | null;
      replayed: boolean;
    }
  | { type: "session.update"; chatId: string; update: SessionUpdate; replay: boolean }
  | {
      type: "session.turnEnded";
      chatId: string;
      stopReason: StopReason | "error";
      error?: string;
      authRequired?: AuthMethod[];
    }
  | { type: "session.exited"; chatId: string; reason: string }
  | {
      type: "permission.request";
      requestId: string;
      chatId: string;
      toolCall: ToolCallFields;
      options: PermissionOption[];
    }
  | { type: "permission.withdrawn"; requestId: string; chatId: string }
  | { type: "browser.listTools"; callId: string; chatId: string | null }
  | {
      type: "browser.call";
      callId: string;
      chatId: string | null;
      harnessId: HarnessId | null;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export interface SessionListData {
  sessions: SessionInfo[];
  supported: boolean;
}
