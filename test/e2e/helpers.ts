import type { Page } from "@playwright/test";
import { expect } from "./fixtures.js";

/** Open the panel's "new chat" page and start a chat with the scripted agent. */
export async function startChat(panel: Page): Promise<void> {
  const agents = panel.getByRole("list", { name: "Agents on this computer" });
  const newChat = panel.getByRole("button", { name: "New chat", exact: true });
  await expect(agents.or(newChat).first()).toBeVisible();
  if (!(await agents.isVisible())) await newChat.click();
  await agents.getByRole("button", { name: /Scripted test agent/ }).click();
  await expect(composer(panel)).toBeVisible();
}

export const composer = (panel: Page) => panel.getByRole("textbox", { name: /Message Scripted test agent/ });

/** Type a message and press Enter, as a person would. */
export async function say(panel: Page, text: string): Promise<void> {
  await expect(composer(panel)).toBeEnabled();
  await composer(panel).fill(text);
  await composer(panel).press("Enter");
}

export const lastReply = (panel: Page) => panel.locator(".msg-agent").last();
export const slip = (panel: Page) => panel.locator(".dock .slip");

/** Opens the settings (on the chat list) from whatever view the panel shows. */
export async function openSettings(panel: Page): Promise<void> {
  const toggle = panel.getByRole("checkbox", { name: /Page tools only/ });
  if (await toggle.isVisible()) return;
  const ways = [
    panel.getByRole("button", { name: /Show all chats/ }),
    panel.getByRole("button", { name: /^(Chats and settings|Settings)$/ })
  ];
  for (const way of ways) {
    if (await way.isVisible()) {
      await way.click();
      break;
    }
  }
  await expect(toggle).toBeVisible();
}

/** Turns "Page tools only" on or off through the panel, as a person would. */
export async function setPageToolsOnly(panel: Page, on: boolean): Promise<void> {
  await openSettings(panel);
  const toggle = panel.getByRole("checkbox", { name: /Page tools only/ });
  if (on) await toggle.check();
  else await toggle.uncheck();
}

/** Deletes every chat through the panel's own port, whatever view the panel shows. */
export async function deleteAllChats(panel: Page): Promise<void> {
  await panel.evaluate(async () => {
    const ids = Object.keys(await chrome.storage.local.get(null))
      .filter((key) => key.startsWith("chat:"))
      .map((key) => key.slice("chat:".length));
    const port = chrome.runtime.connect({ name: "panel" });
    await Promise.all(
      ids.map(
        (chatId, index) =>
          new Promise<void>((resolve) => {
            const id = 9000 + index;
            const onMessage = (message: { type: string; id?: number }) => {
              if (message.type !== "reply" || message.id !== id) return;
              port.onMessage.removeListener(onMessage);
              resolve();
            };
            port.onMessage.addListener(onMessage);
            port.postMessage({ type: "request", id, request: { type: "chat.delete", chatId } });
          })
      )
    );
    port.disconnect();
  });
}
