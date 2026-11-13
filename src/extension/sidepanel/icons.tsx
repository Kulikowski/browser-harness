/** Small line icons, drawn with currentColor, plus the unified 22 px brand and agent micro-tiles. */
import type { ToolKind } from "../../shared/acp.js";
import type { HarnessId } from "../../shared/protocol.js";

const paths = {
  read: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  edit: "M10.5 2.5l3 3L6 13H3v-3l7.5-7.5Z",
  delete: "M3 4.5h10 M6 4.5V3h4v1.5 M4.5 4.5l.7 8.5h5.6l.7-8.5",
  move: "M2.5 8h11 M10 4.5 13.5 8 10 11.5",
  search: "M7 11.8a4.8 4.8 0 1 0 0-9.6 4.8 4.8 0 0 0 0 9.6Z M10.5 10.5 13.8 13.8",
  execute: "M3.2 5.2 6.2 8l-3 2.8 M8 11h4.8",
  think: "M8 2.2a4.2 4.2 0 0 0-2.5 7.6v1.4h5V9.8A4.2 4.2 0 0 0 8 2.2Z M6.2 13.6h3.6",
  fetch:
    "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z M2.2 8h11.6 M8 2c1.7 1.6 2.5 3.6 2.5 6S9.7 12.4 8 14 M8 2C6.3 3.6 5.5 5.6 5.5 8s.8 4.4 2.5 6",
  switch_mode: "M3 5.2h9.5l-2.2-2.2 M13 10.8H3.5l2.2 2.2",
  other:
    "M8 8.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z M4.5 8.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z M11.5 8.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z",
  chevron: "M5.2 6.3 8 9.1l2.8-2.8",
  arrow: "M3.2 8h9.6 M9.3 4.5 12.8 8l-3.5 3.5",
  back: "M12.8 8H3.2 M6.7 4.5 3.2 8l3.5 3.5",
  plus: "M8 3.2v9.6 M3.2 8h9.6",
  refresh:
    "M13.2 4.2v3.3H9.9 M2.8 11.8V8.5h3.3 M3.5 6.2a5 5 0 0 1 8.6-1.5l1.1 1.1 M12.5 9.8a5 5 0 0 1-8.6 1.5l-1.1-1.1",
  folder:
    "M2.2 4.5a1.2 1.2 0 0 1 1.2-1.2h2.7l1.3 1.5h5.2a1.2 1.2 0 0 1 1.2 1.2v5.8a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.5Z",
  sliders: "M2.5 5h11 M2.5 11h11 M5.5 3.2v3.6 M10.5 9.2v3.6",
  send: "M8 12.8V3.5 M4.5 7 8 3.5 11.5 7",
  stop: "M5 5h6v6H5Z",
  clock: "M8 13.8a5.8 5.8 0 1 0 0-11.6 5.8 5.8 0 0 0 0 11.6Z M8 4.8V8l2.2 1.4",
  check: "M3.5 8.4 6.5 11.4 12.6 4.8",
  activity: "M1.8 8h2.6l1.7-4.2 3.4 8.4 1.9-4.2h2.8",
  hand: "M5 8V3.8a1 1 0 0 1 2 0V7 M7 7V2.8a1 1 0 0 1 2 0V7 M9 7V3.5a1 1 0 0 1 2 0V8 M11 6.5a1 1 0 0 1 2 0V9a5 5 0 0 1-5 5H7.5A4 4 0 0 1 4 12L2.6 9.4a1 1 0 0 1 1.7-1L5 9.5",
  shield: "M8 1.8 13 3.6v4c0 3-2.1 5.3-5 6.6-2.9-1.3-5-3.6-5-6.6v-4L8 1.8Z"
} as const satisfies Record<ToolKind, string> & Record<string, string>;

export type IconName = keyof typeof paths;

export function Icon({ name, label, size = 14 }: { name: IconName; label?: string; size?: number }) {
  const d = Object.hasOwn(paths, name) ? paths[name] : paths.other;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={name === "stop" ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={name === "stop" ? "1.1" : "1.45"}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      <path d={d} />
    </svg>
  );
}

/** The extension's 22 px mark, matching HarnessMark and step glyph tiles in scale and corner radius. */
export function BrandMark() {
  return (
    <span class="tile-mark brand-tile" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path
          d="M3.6 5l3.2 3-3.2 3"
          stroke="currentColor"
          stroke-width="1.65"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <rect x="8.5" y="9.6" width="4" height="1.8" rx="0.9" class="brand-cursor" />
      </svg>
    </span>
  );
}

/** 22 px geometric micro-tile for each local coding agent CLI, shared across header, lists, and chat. */
export function HarnessMark({ id }: { id: HarnessId }) {
  return (
    <span class="tile-mark agent-mark" data-harness={id} aria-hidden="true">
      {id === "claude" && (
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.55"
          stroke-linecap="round"
        >
          <path d="M8 2.4v11.2M3.2 5.2l9.6 5.6M12.8 5.2l-9.6 5.6" />
        </svg>
      )}
      {id === "codex" && (
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polygon points="8,2.2 13,5.1 13,10.9 8,13.8 3,10.9 3,5.1" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      )}
      {id === "antigravity" && (
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.55"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M8 2.5 13 12.8H3L8 2.5Z" />
          <path d="M5.4 9.5h5.2" />
        </svg>
      )}
      {id === "fake" && (
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.55"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M3.5 5.2 6.8 8l-3.3 2.8M8.4 11h4.1" />
        </svg>
      )}
    </span>
  );
}
