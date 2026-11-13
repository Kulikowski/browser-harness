import { describe, expect, it } from "vitest";
import { handBack, isBusy, joinQueued, queuedAction } from "../../src/extension/sidepanel/outbox.js";

describe("the composer's outbox rules", () => {
  it("counts starting, working and waiting as busy", () => {
    for (const state of ["starting", "working", "waiting"] as const) expect(isBusy({ state })).toBe(true);
    for (const state of ["idle", "error", "closed"] as const) expect(isBusy({ state })).toBe(false);
  });

  it("joins messages written while one waits, in order", () => {
    expect(joinQueued(null, "first")).toBe("first");
    expect(joinQueued("first", "second")).toBe("first\n\nsecond");
  });

  it("puts handed-back words in front of what is being typed, never over it", () => {
    expect(handBack("queued", "")).toBe("queued");
    expect(handBack("queued", "typing now")).toBe("queued\n\ntyping now");
  });

  it("sends a queued message only once the agent is free, and gives it back if it never will be", () => {
    expect(queuedAction({ state: "idle" })).toBe("send");
    expect(queuedAction({ state: "starting" })).toBe("wait");
    expect(queuedAction({ state: "working" })).toBe("wait");
    expect(queuedAction({ state: "waiting" })).toBe("wait");
    expect(queuedAction({ state: "error" })).toBe("hand-back");
    expect(queuedAction({ state: "closed" })).toBe("hand-back");
    expect(queuedAction(undefined)).toBe("drop");
  });
});
