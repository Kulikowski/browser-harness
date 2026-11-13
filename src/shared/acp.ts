/**
 * The slice of the Agent Client Protocol (v1, https://agentclientprotocol.com/protocol/v1/schema)
 * that the side panel renders. The bridge forwards `session/update` payloads unchanged, so these
 * types mirror the spec's names; anything the panel does not know is kept as `unknown` and ignored.
 * Kept separate from @agentclientprotocol/sdk so the extension bundle never pulls the SDK in.
 */

export type ToolKind =
  "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name?: string; title?: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: string; [key: string]: unknown };

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string }
  | { type: string; [key: string]: unknown };

export interface ToolCallFields {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[] | null;
  locations?: { path: string; line?: number | null }[] | null;
  _meta?: Record<string, unknown> | null;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock; messageId?: string | null }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock; messageId?: string | null }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock; messageId?: string | null }
  | ({ sessionUpdate: "tool_call" } & ToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallFields)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: string; [key: string]: unknown };

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}
