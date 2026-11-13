/// <reference types="chrome" />
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("chrome", { storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } } });
const { expireApprovals, waitForApproval, answerApproval } =
  await import("../../src/extension/background/approvals.js");

describe("expireApprovals", () => {
  it("ends only the named chat's waits, and marks each slip", async () => {
    const expiredA = vi.fn();
    const expiredB = vi.fn();
    const a = waitForApproval("chat-a", "ap-a", "https://a.example", "submit", undefined, expiredA);
    const b = waitForApproval("chat-b", "ap-b", "https://a.example", "submit", undefined, expiredB);

    expireApprovals("chat-a");
    await expect(a).resolves.toBe("expired");
    expect(expiredA).toHaveBeenCalledOnce();
    expect(expiredB).not.toHaveBeenCalled();

    expect(await answerApproval("ap-b", "allowed")).toBe(true);
    await expect(b).resolves.toBe("allowed");
  });

  it("ends every wait when no chat is named", async () => {
    const c = waitForApproval("chat-c", "ap-c", "https://a.example", "submit", undefined, vi.fn());
    const d = waitForApproval("chat-d", "ap-d", "https://a.example", "submit", undefined, vi.fn());
    expireApprovals();
    await expect(Promise.all([c, d])).resolves.toEqual(["expired", "expired"]);
  });
});
