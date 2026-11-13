import { describe, expect, it } from "vitest";
import {
  CLAUDE_ADAPTER,
  CODEX_ADAPTER,
  detectHarnesses,
  isKeylessAuthMethod,
  searchPath,
  signInHint
} from "../../src/bridge/harnesses.js";

const lookupFrom = (present: Record<string, string>) => async (name: string) => present[name] ?? null;
const noVersion = async () => "1.0.0";

describe("detectHarnesses", () => {
  it("offers only what is installed, in a stable order, and lists the rest as not found", async () => {
    const { found, missing } = await detectHarnesses({
      lookup: lookupFrom({ agy: "/u/agy", claude: "/u/claude" }),
      version: noVersion
    });
    expect(found.map((h) => h.id)).toEqual(["claude", "antigravity"]);
    expect(missing.map((h) => h.id)).toEqual(["codex"]);
  });

  it("runs Claude Code through the ACP adapter, preferring one on PATH and pointing it at the found CLI", async () => {
    const viaNpx = await detectHarnesses({ lookup: lookupFrom({ claude: "/u/claude" }), version: noVersion });
    expect(viaNpx.found[0]!.spec.args).toEqual(["-y", CLAUDE_ADAPTER]);
    expect(viaNpx.found[0]!.spec.env).toEqual({ CLAUDE_CODE_EXECUTABLE: "/u/claude" });
    const local = await detectHarnesses({
      lookup: lookupFrom({ claude: "/u/claude", "claude-agent-acp": "/u/claude-agent-acp" }),
      version: noVersion
    });
    expect(local.found[0]!.spec).toMatchObject({ command: "/u/claude-agent-acp", args: [] });
  });

  it("runs Codex through codex-acp without opening a browser", async () => {
    const { found } = await detectHarnesses({ lookup: lookupFrom({ codex: "/u/codex" }), version: noVersion });
    expect(found[0]!.spec).toMatchObject({
      args: ["-y", CODEX_ADAPTER],
      env: { CODEX_PATH: "/u/codex", NO_BROWSER: "1" }
    });
  });

  it("runs Antigravity natively in ACP mode", async () => {
    const { found } = await detectHarnesses({
      lookup: lookupFrom({ antigravity: "/u/antigravity" }),
      version: noVersion
    });
    expect(found.map((h) => [h.spec.command, ...h.spec.args])).toEqual([["/u/antigravity", "acp"]]);
  });

  it("adds the scripted agent only when asked", async () => {
    const without = await detectHarnesses({ lookup: lookupFrom({}), version: noVersion });
    expect(without.found).toEqual([]);
    const withFake = await detectHarnesses({
      lookup: lookupFrom({}),
      version: noVersion,
      fakeAgent: "/x/fakeAgent.js"
    });
    expect(withFake.found.map((h) => h.id)).toEqual(["fake"]);
  });
});

describe("isKeylessAuthMethod", () => {
  it.each([
    [{ id: "oauth-personal", name: "Log in with Google" }, true],
    [{ id: "claude-login", name: "Log in with Claude" }, true],
    [{ id: "chatgpt", name: "Login with ChatGPT" }, true],
    [{ id: "gemini-api-key", name: "Use Gemini API key" }, false],
    [{ id: "api-key", name: "API key" }, false],
    [{ id: "vertex-ai", name: "Vertex AI" }, false],
    [{ id: "gateway", name: "AI gateway" }, false],
    [{ id: "agent-platform", name: "Agent Platform" }, false],
    [{ id: "x", name: "Something", _meta: { "api-key": {} } }, false]
  ])("%o -> %s", (method, keyless) => {
    expect(isKeylessAuthMethod(method)).toBe(keyless);
  });
});

describe("signInHint", () => {
  it("tells the user to sign in in the harness's own terminal UI", () => {
    expect(signInHint("codex")).toContain("codex login");
    expect(signInHint("antigravity")).toContain("agy");
  });
});

describe("searchPath", () => {
  it("looks on PATH first, then where installers put things", () => {
    const dirs = searchPath({ PATH: "/custom/bin:/usr/bin" });
    expect(dirs.slice(0, 2)).toEqual(["/custom/bin", "/usr/bin"]);
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("searches only the folders a test names, so the machine's own agents stay out", () => {
    expect(searchPath({ PATH: "/usr/bin", BROWSER_HARNESS_SEARCH_PATH: "/a:/b" })).toEqual(["/a", "/b"]);
    expect(searchPath({ PATH: "/usr/bin", BROWSER_HARNESS_SEARCH_PATH: "" })).toEqual([]);
  });
});
