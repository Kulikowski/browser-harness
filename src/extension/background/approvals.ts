/**
 * The extension's own approval gate for browser actions, on top of the harness's permission
 * prompts. A pending approval lives in the chat transcript (so the panel draws it) and here (so
 * the waiting tool call resumes when the user answers).
 */
import { alwaysKey, type ApprovalCategory } from "../../shared/policy.js";
import type { ApprovalOutcome } from "../../shared/transcript.js";

const ALWAYS = "alwaysAllowed";
const TIMEOUT_MS = 10 * 60_000;

const waiting = new Map<
  string,
  {
    chatId: string;
    resolve(outcome: ApprovalOutcome): void;
    onExpire(): void;
    key: string;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let seq = 0;

export async function isAlwaysAllowed(origin: string, category: ApprovalCategory, scope?: string): Promise<boolean> {
  const stored = ((await chrome.storage.local.get(ALWAYS))[ALWAYS] as string[] | undefined) ?? [];
  return stored.includes(alwaysKey(origin, category, scope));
}

export function newApprovalId(): string {
  seq += 1;
  return `ap-${Date.now().toString(36)}-${seq}`;
}

export function waitForApproval(
  chatId: string,
  id: string,
  origin: string,
  category: ApprovalCategory,
  scope: string | undefined,
  onExpire: () => void
): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      onExpire();
      resolve("expired");
    }, TIMEOUT_MS);
    waiting.set(id, { chatId, resolve, onExpire, key: alwaysKey(origin, category, scope), timer });
  });
}

export async function answerApproval(id: string, outcome: Exclude<ApprovalOutcome, "expired">): Promise<boolean> {
  const entry = waiting.get(id);
  if (!entry) return false;
  waiting.delete(id);
  clearTimeout(entry.timer);
  if (outcome === "always") {
    const stored = ((await chrome.storage.local.get(ALWAYS))[ALWAYS] as string[] | undefined) ?? [];
    if (!stored.includes(entry.key)) await chrome.storage.local.set({ [ALWAYS]: [...stored, entry.key] });
  }
  entry.resolve(outcome);
  return true;
}

/** End the waits of one chat (its turn was cancelled), or of every chat (the bridge is gone). Each open slip is marked expired. */
export function expireApprovals(chatId?: string): void {
  for (const [id, entry] of waiting) {
    if (chatId !== undefined && entry.chatId !== chatId) continue;
    clearTimeout(entry.timer);
    waiting.delete(id);
    entry.onExpire();
    entry.resolve("expired");
  }
}
