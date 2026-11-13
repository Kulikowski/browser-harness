/**
 * The local harnesses the bridge knows how to start as ACP agents, and how it finds them.
 * We only ever run what is already installed and signed in on this machine; no keys pass through.
 *
 * Evidence for each launch line (checked 12 Nov 2026):
 *  - Claude Code: @agentclientprotocol/claude-agent-acp (Apache-2.0), the ACP adapter for the Claude
 *    Agent SDK; CLAUDE_CODE_EXECUTABLE points it at the user's own `claude`.
 *  - Codex: @agentclientprotocol/codex-acp (Apache-2.0); CODEX_PATH points it at the user's `codex`.
 *  - Antigravity CLI: `agy acp`, built in since 1.5.0 (antigravity.google/docs/cli/acp).
 */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { HarnessId, HarnessInfo, MissingHarness } from "../shared/protocol.js";

export const CLAUDE_ADAPTER = "@agentclientprotocol/claude-agent-acp@0.106.0";
export const CODEX_ADAPTER = "@agentclientprotocol/codex-acp@2.6.0";

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface HarnessDefinition {
  id: HarnessId;
  name: string;
  /** Executable names to look for, in order. */
  binaries: string[];
  installHint: string;
  /** How to sign in, in the harness's own terminal UI. Shown when a session says auth is required. */
  signInHint: string;
  launch(found: string, lookup: (name: string) => Promise<string | null>): Promise<LaunchSpec>;
}

const npx = () => join(dirname(process.execPath), process.platform === "win32" ? "npx.cmd" : "npx");

export const HARNESSES: readonly HarnessDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    binaries: ["claude"],
    installHint: "npm install -g @anthropic-ai/claude-code, then run claude once to sign in",
    signInHint: "Run claude in a terminal and sign in with /login, then try again.",
    async launch(found, lookup) {
      const adapter = await lookup("claude-agent-acp");
      const env = { CLAUDE_CODE_EXECUTABLE: found };
      return adapter ? { command: adapter, args: [], env } : { command: npx(), args: ["-y", CLAUDE_ADAPTER], env };
    }
  },
  {
    id: "codex",
    name: "Codex",
    binaries: ["codex"],
    installHint: "npm install -g @openai/codex, then run codex login",
    signInHint: "Run codex login in a terminal (ChatGPT sign-in), then try again.",
    async launch(found, lookup) {
      const adapter = await lookup("codex-acp");
      const env = { CODEX_PATH: found, NO_BROWSER: "1" };
      return adapter ? { command: adapter, args: [], env } : { command: npx(), args: ["-y", CODEX_ADAPTER], env };
    }
  },
  {
    id: "antigravity",
    name: "Antigravity CLI",
    binaries: ["agy", "antigravity"],
    installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash, then run agy once to sign in",
    signInHint: "Run agy in a terminal and sign in with Google (or agy acp --login), then try again.",
    async launch(found) {
      return { command: found, args: ["acp"], env: {} };
    }
  }
];

/** Chrome starts the host with a thin PATH (especially on macOS), so also look where installers put things. */
export function searchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  // Tests pin the search to exactly these folders, so what is installed on the machine never leaks in.
  if (env.BROWSER_HARNESS_SEARCH_PATH !== undefined)
    return env.BROWSER_HARNESS_SEARCH_PATH.split(delimiter).filter(Boolean);
  const home = homedir();
  const extra = [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".antigravity", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    dirname(process.execPath)
  ];
  const fromEnv = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...fromEnv, ...extra])];
}

export function makeLookup(dirs: readonly string[]): (name: string) => Promise<string | null> {
  return async (name) => {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
    return null;
  };
}

export function readVersion(binary: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: timeoutMs, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout) => {
      if (error) return resolve(null);
      const line = stdout.toString().trim().split("\n")[0] ?? "";
      const match = line.match(/\d+\.\d+\.\d+[\w.-]*/);
      resolve(match ? match[0] : line.slice(0, 40) || null);
    });
  });
}

export interface DetectOptions {
  lookup?: (name: string) => Promise<string | null>;
  version?: (binary: string) => Promise<string | null>;
  /** Test-only: also offer the scripted fake agent. Enabled with BROWSER_HARNESS_FAKE_AGENT=<path to fakeAgent.js>. */
  fakeAgent?: string | null;
}

export interface Detected {
  found: (HarnessInfo & { definition: HarnessDefinition | null; spec: LaunchSpec })[];
  missing: MissingHarness[];
}

export async function detectHarnesses(options: DetectOptions = {}): Promise<Detected> {
  const lookup = options.lookup ?? makeLookup(searchPath());
  const version = options.version ?? readVersion;
  const found: Detected["found"] = [];
  const missing: MissingHarness[] = [];
  await Promise.all(
    HARNESSES.map(async (definition) => {
      let path: string | null = null;
      for (const binary of definition.binaries) {
        path = await lookup(binary);
        if (path) break;
      }
      if (!path) {
        missing.push({ id: definition.id, name: definition.name, installHint: definition.installHint });
        return;
      }
      const spec = await definition.launch(path, lookup);
      found.push({
        id: definition.id,
        name: definition.name,
        foundAt: path,
        version: await version(path),
        launch: [spec.command, ...spec.args].join(" "),
        definition,
        spec
      });
    })
  );
  if (options.fakeAgent) {
    found.push({
      id: "fake",
      name: "Scripted test agent",
      foundAt: options.fakeAgent,
      version: null,
      launch: `node ${options.fakeAgent}`,
      definition: null,
      spec: { command: process.execPath, args: [options.fakeAgent], env: {} }
    });
  }
  const order = (id: HarnessId) => ["claude", "codex", "antigravity", "fake"].indexOf(id);
  found.sort((a, b) => order(a.id) - order(b.id));
  missing.sort((a, b) => order(a.id) - order(b.id));
  return { found, missing };
}

export function signInHint(id: HarnessId): string {
  return (
    HARNESSES.find((harness) => harness.id === id)?.signInHint ??
    "Sign in to the harness in a terminal, then try again."
  );
}

/** Auth methods that would make us handle a key are never offered: the extension holds zero keys. */
export function isKeylessAuthMethod(method: { id: string; name: string; _meta?: unknown }): boolean {
  const text = `${method.id} ${method.name}`.toLowerCase();
  if (/api[- ]?key|gateway|vertex|agent-platform/.test(text)) return false;
  const meta = method._meta as Record<string, unknown> | undefined;
  return !(meta && ("api-key" in meta || "gateway" in meta));
}
