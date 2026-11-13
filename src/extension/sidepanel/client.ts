/** The panel's port to the service worker. Reconnects if the worker restarts. */
import { PANEL_PORT, type FromPanel, type PanelRequest, type PanelState, type ToPanel } from "../../shared/panel.js";

export class PanelClient {
  private port: chrome.runtime.Port | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(private readonly onState: (state: PanelState) => void) {
    this.connect();
  }

  private connect(): void {
    const port = chrome.runtime.connect({ name: PANEL_PORT });
    this.port = port;
    port.onMessage.addListener((message: ToPanel) => {
      if (message.type === "state") this.onState(message.state);
      else {
        const entry = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (!entry) return;
        if (message.reply.ok) entry.resolve(message.reply.data);
        else entry.reject(new Error(message.reply.error));
      }
    });
    port.onDisconnect.addListener(() => {
      this.port = null;
      for (const entry of this.waiting.values()) entry.reject(new Error("The extension restarted; try again."));
      this.waiting.clear();
      setTimeout(() => this.connect(), 250);
    });
  }

  request<T = unknown>(request: PanelRequest): Promise<T> {
    if (!this.port) return Promise.reject(new Error("Reconnecting to the extension…"));
    this.seq += 1;
    const id = this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.port!.postMessage({ type: "request", id, request } satisfies FromPanel);
    });
  }
}
