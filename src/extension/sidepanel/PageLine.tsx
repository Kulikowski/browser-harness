/** The live page lens at the top of a chat: which tab "this page" is, and what WebMCP tools it offers. */
import { useState } from "preact/hooks";
import type { TabSummary } from "../../shared/panel.js";
import { pageLineNote } from "./format.js";

const COLLAPSED_TOOLS = 4;

export function PageLine({ tab, pageToolsOnly }: { tab: TabSummary | null; pageToolsOnly: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (!tab) {
    return (
      <div class="page-lens" data-state="empty">
        <p class="context">No web page in view. Open one and the agent can work on it.</p>
      </div>
    );
  }

  const count = tab.webmcpTools.length;
  const lensState = count > 0 ? "active" : pageToolsOnly ? "restricted" : "dom";
  const shownTools = expanded ? tab.webmcpTools : tab.webmcpTools.slice(0, COLLAPSED_TOOLS);
  const hiddenCount = count - shownTools.length;

  return (
    <div class="page-lens" data-state={lensState}>
      <p
        class="context"
        title={count ? `${tab.url}\n${tab.webmcpTools.join(", ")}` : tab.url}
        data-tools={count ? "" : undefined}
      >
        <strong>{count ? `${count} WebMCP tool${count === 1 ? "" : "s"}` : "No WebMCP tools"}</strong>{" "}
        <span>
          on {tab.title || tab.url}
          {pageLineNote(tab, pageToolsOnly)}
        </span>
      </p>
      {count > 0 && (
        <div class="lens-tools" aria-label="WebMCP tools on this page">
          {shownTools.map((tool) => (
            <code key={tool} class="tool-chip">
              {tool}
            </code>
          ))}
          {count > COLLAPSED_TOOLS && (
            <button type="button" class="tool-chip tool-chip-more" onClick={() => setExpanded((open) => !open)}>
              {expanded ? "Show fewer" : `+${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
