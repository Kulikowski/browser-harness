/** Modes where the agent runs tools without asking each time. New chats avoid them, and the panel marks them. */
export function actsOnItsOwn(mode: { id: string; name: string }): boolean {
  return /auto|bypass|full|yolo|dont.?ask/i.test(`${mode.id} ${mode.name}`);
}
