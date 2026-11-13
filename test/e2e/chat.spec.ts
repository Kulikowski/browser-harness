import { expect, lookAt, test } from "./fixtures.js";
import { deleteAllChats, lastReply, say, startChat } from "./helpers.js";

test("shows only the harnesses found on this computer", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  const agents = panel.getByRole("list", { name: "Agents on this computer" });
  const newChat = panel.getByRole("button", { name: "New chat", exact: true });
  await expect(agents.or(newChat).first()).toBeVisible();
  if (!(await agents.isVisible())) await newChat.click();
  await expect(agents.getByRole("button")).toHaveCount(1);
  await expect(agents.getByRole("button", { name: /Scripted test agent/ })).toBeVisible();
  await expect(panel.getByText("3 more agents not installed")).toBeVisible();
});

test("a chat is a harness session: the reply streams in and the turn ends", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  await startChat(panel);
  await say(panel, "hello from the side panel");
  await expect(panel.locator(".msg-user")).toContainText("hello from the side panel");
  await expect(lastReply(panel)).toHaveText("You said: hello from the side panel");
  await expect(panel.getByText(/^Finished in/)).toBeVisible();
  await expect(panel.locator(".thought summary").first()).toHaveText(/Thought for/);
  await expect(panel.getByRole("region", { name: "Plan" })).toContainText("Read the message");
});

test("the New chat view leads to the settings, named for whether chats exist", async ({ panel, env, site }) => {
  await lookAt(site, env.fixtureUrl("form.html"));
  await deleteAllChats(panel);
  await panel.reload();
  await expect(panel.getByRole("list", { name: "Agents on this computer" })).toBeVisible();
  await panel.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(panel.getByRole("checkbox", { name: /Page tools only/ })).toBeVisible();

  await panel.getByRole("button", { name: "New chat", exact: true }).click();
  await startChat(panel);
  await panel.getByRole("button", { name: "New chat", exact: true }).click();
  await panel.getByRole("button", { name: "Chats and settings", exact: true }).click();
  await expect(panel.getByRole("checkbox", { name: /Page tools only/ })).toBeVisible();
});
