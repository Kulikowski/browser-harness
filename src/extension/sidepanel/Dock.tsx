/**
 * The bottom of the chat: whatever needs the user's decision right now, then the composer.
 * A decision slip names who is asking, what exactly would happen, and offers the choices the
 * asker gave (ACP permission options), or Allow once / Always on this site / Decline for the
 * extension's own browser approvals.
 */
import { useEffect, useRef } from "preact/hooks";
import { actsOnItsOwn } from "../../shared/modes.js";
import { pendingDecisions, type Chat } from "../../shared/transcript.js";
import { folderName, hostOf, pretty, browserActionPhrase, stepTitle } from "./format.js";
import { Icon } from "./icons.js";
import { isBusy, type Outbox } from "./outbox.js";

export interface DockActions {
  setDraft(text: string): void;
  /** Send what is typed, or queue it while the agent is busy. */
  submit(): void;
  cancelQueued(): void;
  stop(): void;
  /** Rejects when the agent refused the mode. */
  setMode(modeId: string): Promise<unknown>;
  answerPermission(requestId: string, optionId: string | null): void;
  answerApproval(id: string, outcome: "allowed" | "always" | "denied"): void;
}

export function Dock({ chat, box, actions }: { chat: Chat; box: Outbox; actions: DockActions }) {
  const decisions = pendingDecisions(chat);
  const decision = decisions[0];
  return (
    <div class="dock">
      {decision?.kind === "permission" && (
        <section class="slip" data-slip-kind="permission" aria-labelledby={`slip-${decision.id}`} role="group">
          <div class="slip-head">
            <p class="who">
              <span class="who-icon" aria-hidden="true">
                <Icon name="hand" size={12} />
              </span>
              <span>Needs you</span>
            </p>
            {decisions.length > 1 && <span class="slip-queue">+{decisions.length - 1} waiting</span>}
          </div>
          <h2 id={`slip-${decision.id}`}>{stepTitle(decision.title, decision.input)}</h2>
          <p class="why">{chat.harnessName} asks before it runs this.</p>
          {pretty(decision.input) && <pre class="mono">{pretty(decision.input)}</pre>}
          <div class="choices">
            {decision.options.map((option, index) => (
              <button
                key={option.optionId}
                type="button"
                class={`btn btn-sm ${option.kind.startsWith("allow") ? (index === 0 ? "primary" : "") : "quiet reject"}`}
                onClick={() => actions.answerPermission(decision.id, option.optionId)}
              >
                {option.name}
              </button>
            ))}
          </div>
        </section>
      )}
      {decision?.kind === "approval" && (
        <section class="slip" data-slip-kind="approval" aria-labelledby={`slip-${decision.id}`} role="group">
          <div class="slip-head">
            <p class="who">
              <span class="who-icon" aria-hidden="true">
                <Icon name="shield" size={12} />
              </span>
              <span>Browser check</span>
            </p>
            {decisions.length > 1 && <span class="slip-queue">+{decisions.length - 1} waiting</span>}
          </div>
          <h2 id={`slip-${decision.id}`}>
            {chat.harnessName} wants to {browserActionPhrase(decision.tool, decision.args)} on {hostOf(decision.origin)}
          </h2>
          <p class="why">{decision.reason}</p>
          <pre class="mono">{pretty({ tool: decision.tool, ...decision.args })}</pre>
          <div class="choices">
            <button
              type="button"
              class="btn btn-sm primary"
              onClick={() => actions.answerApproval(decision.id, "allowed")}
            >
              {decision.category === "webmcp-first-use"
                ? "Allow for now"
                : decision.category === "other-tab"
                  ? "Allow this turn"
                  : "Allow once"}
            </button>
            <button
              type="button"
              class="btn btn-sm"
              title={`Always allow this on ${hostOf(decision.origin)}`}
              onClick={() => actions.answerApproval(decision.id, "always")}
            >
              Always on this site
            </button>
            <button
              type="button"
              class="btn btn-sm quiet reject"
              onClick={() => actions.answerApproval(decision.id, "denied")}
            >
              Decline
            </button>
          </div>
        </section>
      )}
      <Composer chat={chat} box={box} actions={actions} />
    </div>
  );
}

function Composer({ chat, box, actions }: { chat: Chat; box: Outbox; actions: DockActions }) {
  const area = useRef<HTMLTextAreaElement>(null);
  // A message on its way counts as busy too: the next one waits behind it, and the controls say so.
  const busy = isBusy(chat) || box.sending;

  useEffect(() => {
    area.current?.focus();
  }, [chat.id]);

  const currentMode = chat.modes.find((mode) => mode.id === chat.currentModeId);
  const waitingFor =
    chat.state === "starting" ? `${chat.harnessName} is starting` : `${chat.harnessName} finishes this turn`;

  return (
    <form
      class="composer"
      onSubmit={(event) => {
        event.preventDefault();
        actions.submit();
      }}
    >
      <div class="composer-card">
        {box.queued !== null && (
          <p class="queued" role="status">
            <span class="queued-text" title={box.queued}>
              <Icon name="clock" size={12} />
              <span>
                Sends when {waitingFor}: <q>{box.queued}</q>
              </span>
            </span>
            <button type="button" class="btn quiet btn-xs" onClick={() => actions.cancelQueued()}>
              Cancel
            </button>
          </p>
        )}
        <label for="message" class="visually-hidden">
          Message {chat.harnessName}
        </label>
        <textarea
          id="message"
          ref={area}
          rows={1}
          value={box.draft}
          placeholder={
            chat.state === "starting"
              ? `Starting ${chat.harnessName}…`
              : busy
                ? "Working… Enter queues"
                : `Message ${chat.harnessName}`
          }
          onInput={(event) => actions.setDraft((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (event.isComposing || event.keyCode === 229) return;
              (event.currentTarget as HTMLTextAreaElement).form?.requestSubmit();
            }
          }}
        />
        <div class="composer-foot">
          <div class="composer-context">
            <span class="composer-meta" title={`${chat.harnessName} works in ${chat.cwd}`}>
              <Icon name="folder" size={11} />
              <span class="mono">{folderName(chat.cwd)}</span>
            </span>
            {chat.modes.length > 1 && (
              <label
                class="mode-picker"
                data-unattended={currentMode && actsOnItsOwn(currentMode) ? "" : undefined}
                title={
                  currentMode && actsOnItsOwn(currentMode)
                    ? `In ${currentMode.name} mode ${chat.harnessName} runs its own tools, shell included, without asking you each time. Pages it reads are written by strangers.`
                    : undefined
                }
              >
                <span class="visually-hidden">Mode</span>
                <select
                  value={chat.currentModeId ?? ""}
                  onChange={(event) => {
                    const select = event.target as HTMLSelectElement;
                    // A refused mode must not stay on show: the select goes back to the one in force.
                    actions.setMode(select.value).catch(() => {
                      select.value = chat.currentModeId ?? "";
                    });
                  }}
                >
                  {chat.modes.map((mode) => (
                    <option key={mode.id} value={mode.id} title={mode.description ?? undefined}>
                      {mode.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {/* Separate keys: Stop hands queued words back, which turns this slot into a submit button
              before the click is done; reusing the element would let that same click send them. */}
          {busy && !box.draft.trim() ? (
            <button key="stop" type="button" class="btn btn-sm btn-stop" onClick={() => actions.stop()}>
              <Icon name="stop" size={10} />
              <span>Stop</span>
            </button>
          ) : (
            <button key="send" type="submit" class="btn btn-sm primary btn-send" disabled={!box.draft.trim()}>
              <Icon name="send" size={12} />
              <span>{busy ? "Queue" : "Send"}</span>
            </button>
          )}
        </div>
      </div>
      {box.error && (
        <p class="notice error composer-error" role="alert">
          {box.error}
        </p>
      )}
    </form>
  );
}
