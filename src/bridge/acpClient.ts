/**
 * One running harness, spoken to over the Agent Client Protocol (v1, stdio JSON-RPC).
 * Each extension chat is one ACP session on it: session/new, then session/prompt per message;
 * session/load or session/resume to reopen; session/list to find sessions made elsewhere.
 * The harness's permission requests (session/request_permission) are handed to the extension and
 * answered with whatever the user picked.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  PermissionOption,
  SessionInfo,
  SessionMode,
  SessionUpdate,
  StopReason,
  ToolCallFields
} from "../shared/acp.js";
import { messageOf } from "../shared/errors.js";
import type { AuthMethod, HarnessId } from "../shared/protocol.js";
import { isKeylessAuthMethod, type LaunchSpec } from "./harnesses.js";

export interface AcpEvents {
  update(chatId: string, update: SessionUpdate, replay: boolean): void;
  permission(request: {
    requestId: string;
    chatId: string;
    toolCall: ToolCallFields;
    options: PermissionOption[];
  }): void;
  permissionWithdrawn(requestId: string, chatId: string): void;
  exited(chatIds: string[], reason: string): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export class AuthRequiredError extends Error {
  constructor(
    message: string,
    readonly methods: AuthMethod[],
    readonly harnessId: HarnessId
  ) {
    super(message);
  }
}

interface SessionBinding {
  chatId: string;
  acpSessionId: string;
  replaying: boolean;
}

interface PendingPermission {
  chatId: string;
  acpSessionId: string;
  resolve(response: acp.RequestPermissionResponse): void;
}

export interface OpenedSession {
  acpSessionId: string;
  modes: SessionMode[];
  currentModeId: string | null;
  replayed: boolean;
}

const AUTH_REQUIRED = -32000;

export class HarnessConnection {
  private child: ChildProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  private init: acp.InitializeResponse | null = null;
  private starting: Promise<void> | null = null;
  private readonly bindings = new Map<string, SessionBinding>(); // by acpSessionId
  private readonly permissions = new Map<string, PendingPermission>();
  private permissionSeq = 0;
  private stderrTail = "";

  constructor(
    readonly harnessId: HarnessId,
    private readonly spec: LaunchSpec,
    private readonly events: AcpEvents,
    private readonly clientName = "browser-harness"
  ) {}

  get capabilities(): acp.AgentCapabilities | undefined {
    return this.init?.agentCapabilities;
  }

  get authMethods(): AuthMethod[] {
    return (this.init?.authMethods ?? [])
      .filter(isKeylessAuthMethod)
      .map((m) => ({ id: m.id, name: m.name, description: m.description ?? null }));
  }

  chatFor(acpSessionId: string): string | undefined {
    return this.bindings.get(acpSessionId)?.chatId;
  }

  private async ensureStarted(): Promise<acp.ClientConnection> {
    if (this.connection) return this.connection;
    this.starting ??= this.start();
    await this.starting;
    if (!this.connection) throw new Error("The harness did not start.");
    return this.connection;
  }

  private async start(): Promise<void> {
    const pathWithNode = [this.spec.env.PATH ?? process.env.PATH ?? "", dirname(process.execPath)]
      .filter(Boolean)
      .join(delimiter);
    const child = spawn(this.spec.command, this.spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.spec.env, PATH: pathWithNode }
    });
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(new Error(`Could not start ${this.spec.command}: ${error.message}`)));
    });
    child.once("exit", (code, signal) => this.onExit(code, signal));
    await spawned;

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!),
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    );
    const connection = acp
      .client({ name: this.clientName })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const binding = this.bindings.get(ctx.params.sessionId);
        if (!binding) return;
        this.events.update(binding.chatId, ctx.params.update as SessionUpdate, binding.replaying);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
      .connect(stream);
    this.connection = connection;
    try {
      this.init = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // We read no files and run no terminals for the agent: it brings its own tools, and the
        // browser arrives as an MCP server.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: this.clientName, version: "0.1.0" }
      });
    } catch (error) {
      this.stop();
      throw new Error(`The harness did not answer initialize: ${messageOf(error)}${this.stderrHint()}`);
    }
  }

  private onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const binding = this.bindings.get(params.sessionId);
    if (!binding) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    this.permissionSeq += 1;
    const requestId = `${this.harnessId}-perm-${this.permissionSeq}`;
    return new Promise((resolve) => {
      this.permissions.set(requestId, { chatId: binding.chatId, acpSessionId: params.sessionId, resolve });
      this.events.permission({
        requestId,
        chatId: binding.chatId,
        toolCall: params.toolCall as ToolCallFields,
        options: params.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind }))
      });
    });
  }

  answerPermission(requestId: string, optionId: string | null): boolean {
    const pending = this.permissions.get(requestId);
    if (!pending) return false;
    this.permissions.delete(requestId);
    pending.resolve(
      optionId === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } }
    );
    return true;
  }

  async newSession(
    chatId: string,
    request: { cwd: string; mcpServers: acp.McpServer[]; systemPrompt: string | null }
  ): Promise<OpenedSession> {
    const connection = await this.ensureStarted();
    const params: acp.NewSessionRequest = { cwd: request.cwd, mcpServers: request.mcpServers };
    if (request.systemPrompt && this.capabilities?.sessionCapabilities?.systemPrompt) {
      params.systemPrompt = { mode: "append", content: [{ type: "text", text: request.systemPrompt }] };
    }
    const response = await this.withAuth(() => connection.agent.request(acp.methods.agent.session.new, params));
    this.bindings.set(response.sessionId, { chatId, acpSessionId: response.sessionId, replaying: false });
    return { acpSessionId: response.sessionId, ...modesOf(response.modes), replayed: false };
  }

  /**
   * Reopen a session after the bridge restarted, or open one made in the harness's own UI.
   * With `wantHistory`, prefer session/load (it replays the conversation); otherwise prefer
   * session/resume, which skips the replay because the extension still has the transcript.
   */
  async reopenSession(
    chatId: string,
    acpSessionId: string,
    request: { cwd: string; mcpServers: acp.McpServer[]; systemPrompt: string | null; wantHistory: boolean }
  ): Promise<OpenedSession> {
    const connection = await this.ensureStarted();
    const caps = this.capabilities;
    const canResume = !!caps?.sessionCapabilities?.resume;
    const canLoad = !!caps?.loadSession;
    const useLoad = canLoad && (request.wantHistory || !canResume);
    if (!useLoad && !canResume)
      throw new Error(
        "This harness cannot reopen past sessions (it supports neither session/load nor session/resume). Start a new chat."
      );
    const binding: SessionBinding = { chatId, acpSessionId, replaying: useLoad };
    this.bindings.set(acpSessionId, binding);
    const base: acp.ResumeSessionRequest = {
      sessionId: acpSessionId,
      cwd: request.cwd,
      mcpServers: request.mcpServers
    };
    if (request.systemPrompt && caps?.sessionCapabilities?.systemPrompt) {
      base.systemPrompt = { mode: "append", content: [{ type: "text", text: request.systemPrompt }] };
    }
    try {
      const response = useLoad
        ? await this.withAuth(() => connection.agent.request(acp.methods.agent.session.load, base))
        : await this.withAuth(() => connection.agent.request(acp.methods.agent.session.resume, base));
      return {
        acpSessionId,
        ...modesOf((response as { modes?: acp.SessionModeState | null } | null)?.modes ?? null),
        replayed: useLoad
      };
    } catch (error) {
      this.bindings.delete(acpSessionId);
      throw error;
    } finally {
      binding.replaying = false;
    }
  }

  async listSessions(cwd: string | null): Promise<{ supported: boolean; sessions: SessionInfo[] }> {
    const connection = await this.ensureStarted();
    if (!this.capabilities?.sessionCapabilities?.list) return { supported: false, sessions: [] };
    const sessions: SessionInfo[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 5; page += 1) {
      const params: acp.ListSessionsRequest = {};
      if (cwd) params.cwd = cwd;
      if (cursor) params.cursor = cursor;
      const response = await this.withAuth(() => connection.agent.request(acp.methods.agent.session.list, params));
      for (const session of response.sessions) {
        sessions.push({
          sessionId: session.sessionId,
          cwd: session.cwd,
          title: session.title ?? null,
          updatedAt: session.updatedAt ?? null
        });
      }
      cursor = response.nextCursor;
      if (!cursor) break;
    }
    return { supported: true, sessions };
  }

  async prompt(acpSessionId: string, text: string): Promise<StopReason> {
    const connection = await this.ensureStarted();
    // Some harnesses (Claude Code) only find out they are signed out on the first prompt.
    const response = await this.withAuth(() =>
      connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: acpSessionId,
        prompt: [{ type: "text", text }]
      })
    );
    return response.stopReason;
  }

  async cancel(acpSessionId: string): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    // ACP: on cancel the client answers every open permission request of the session with "cancelled".
    for (const [requestId, pending] of this.permissions) {
      if (pending.acpSessionId !== acpSessionId) continue;
      this.permissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.events.permissionWithdrawn(requestId, pending.chatId);
    }
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: acpSessionId });
  }

  async setMode(acpSessionId: string, modeId: string): Promise<void> {
    const connection = await this.ensureStarted();
    await connection.agent.request(acp.methods.agent.session.setMode, { sessionId: acpSessionId, modeId });
  }

  async closeSession(acpSessionId: string): Promise<void> {
    const binding = this.bindings.get(acpSessionId);
    this.bindings.delete(acpSessionId);
    if (!binding || !this.connection) return;
    if (this.capabilities?.sessionCapabilities?.close) {
      await this.connection.agent
        .request(acp.methods.agent.session.close, { sessionId: acpSessionId })
        .catch(() => undefined);
    }
  }

  async authenticate(methodId: string): Promise<void> {
    const connection = await this.ensureStarted();
    if (!this.authMethods.some((method) => method.id === methodId))
      throw new Error(`Sign-in method ${methodId} is not offered without a key.`);
    await connection.agent.request(acp.methods.agent.authenticate, { methodId });
  }

  /** Make sure the harness process is up and initialized; returns the keyless sign-in methods it offers. */
  async probe(): Promise<AuthMethod[]> {
    await this.ensureStarted();
    return this.authMethods;
  }

  private async withAuth<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (
        codeOf(error) === AUTH_REQUIRED ||
        /auth(entication)? required|not (signed|logged) in|api key is missing/i.test(messageOf(error))
      ) {
        throw new AuthRequiredError(messageOf(error), this.authMethods, this.harnessId);
      }
      throw error;
    }
  }

  stop(): void {
    this.child?.kill("SIGTERM");
    const child = this.child;
    setTimeout(() => child?.kill("SIGKILL"), 2000).unref();
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const chats = [...new Set([...this.bindings.values()].map((binding) => binding.chatId))];
    for (const [requestId, pending] of this.permissions) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.events.permissionWithdrawn(requestId, pending.chatId);
    }
    this.permissions.clear();
    this.bindings.clear();
    this.connection?.close(new Error("harness exited"));
    this.connection = null;
    this.child = null;
    this.starting = null;
    this.init = null;
    const how = signal ? `was stopped (${signal})` : `exited with code ${code}`;
    this.events.log(
      code === 0 || signal === "SIGTERM" ? "info" : "warn",
      `${this.harnessId} ${how}${this.stderrHint()}`
    );
    if (chats.length) this.events.exited(chats, `The harness ${how}. Send a message to reopen the session.`);
  }

  private stderrHint(): string {
    const tail = redact(this.stderrTail.trim().split("\n").slice(-3).join(" "));
    return tail ? ` (stderr: ${tail})` : "";
  }
}

function modesOf(modes: acp.SessionModeState | null | undefined): {
  modes: SessionMode[];
  currentModeId: string | null;
} {
  if (!modes) return { modes: [], currentModeId: null };
  return {
    modes: modes.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description ?? null
    })),
    currentModeId: modes.currentModeId
  };
}

function codeOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

/** Strip anything that looks like a token before it reaches a log or the panel. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|ghp|gho|ghu|xox[abp]|AIza)[-_A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/\b(Bearer)(\s+)\S+/g, "$1$2[redacted]")
    .replace(/\b(api[_-]?key|token|key|secret|password)(\s*[=:]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}
