import { describe, expect, it } from "vitest";
import { askFirstMode } from "../../src/bridge/bridge.js";
import { actsOnItsOwn } from "../../src/shared/modes.js";

// The modes claude-agent-acp 0.106.0 reports.
const claude = [
  { id: "default", name: "Manual" },
  { id: "acceptEdits", name: "Accept edits" },
  { id: "plan", name: "Plan" },
  { id: "auto", name: "Auto" },
  { id: "bypassPermissions", name: "Bypass permissions" }
];

describe("askFirstMode", () => {
  it("moves a new chat from a mode that acts on its own to the one that asks", () => {
    expect(askFirstMode(claude, "auto")).toBe("default");
    expect(askFirstMode(claude, "bypassPermissions")).toBe("default");
  });

  it("leaves a chat alone when it already asks, or when the agent offers nothing that does", () => {
    expect(askFirstMode(claude, "default")).toBeNull();
    expect(askFirstMode(claude, "plan")).toBeNull();
    expect(askFirstMode([{ id: "auto", name: "Auto" }], "auto")).toBeNull();
    expect(askFirstMode([], null)).toBeNull();
  });
});

describe("actsOnItsOwn", () => {
  it("marks Auto and Bypass, not Manual or Plan", () => {
    expect(claude.filter(actsOnItsOwn).map((mode) => mode.id)).toEqual(["auto", "bypassPermissions"]);
  });
});
