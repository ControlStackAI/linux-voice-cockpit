import { CockpitController } from "./cockpit-controller.js";
import { RealtimeEventBridge } from "./realtime-event-bridge.js";
import { WebRtcTransport } from "./webrtc-transport.js";
import type { GatewayClient, GatewayEvent } from "./contracts.js";

interface PendingLocalRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class LocalGatewayProxy implements GatewayClient {
  readonly #socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/control`);
  readonly #pending = new Map<string, PendingLocalRequest>();
  readonly #listeners = new Set<(event: GatewayEvent) => void>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      this.#socket.addEventListener("message", (event) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          reject(new Error("Local control WebSocket returned an invalid response"));
          return;
        }
        if (frame.type === "ready") {
          settled = true;
          resolve();
          return;
        }
        if (frame.type === "fatal") {
          settled = true;
          reject(new Error(String(frame.error ?? "Local control proxy failed")));
          return;
        }
        if (frame.type === "event" && typeof frame.event === "string") {
          for (const listener of this.#listeners) {
            listener({ event: frame.event, payload: frame.payload });
          }
          return;
        }
        if (frame.type !== "response" || typeof frame.id !== "string") return;
        const pending = this.#pending.get(frame.id);
        if (!pending) return;
        this.#pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.payload);
        else pending.reject(new Error(String(frame.error ?? "Local control request failed")));
      });
      this.#socket.addEventListener("error", () => {
        settled = true;
        reject(new Error("Local control WebSocket connection failed"));
      }, { once: true });
      this.#socket.addEventListener("close", (event) => {
        const reason = event.reason ? `: ${event.reason}` : "";
        const error = new Error(`Local control WebSocket closed (${event.code})${reason}`);
        if (!settled) reject(error);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
      });
    });
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.ready;
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#socket.close(1000, "page shutdown");
  }
}

const gateway = new LocalGatewayProxy();
const cockpit = new CockpitController(gateway);
const status = required<HTMLElement>("status");
const detail = required<HTMLElement>("detail");
const statusPanel = required<HTMLElement>("status-panel");
const session = required<HTMLInputElement>("session");
const start = required<HTMLButtonElement>("start");
const stop = required<HTMLButtonElement>("stop");
const steer = required<HTMLButtonElement>("steer");
const cancel = required<HTMLButtonElement>("cancel");
const steeringText = required<HTMLInputElement>("steering-text");
const audio = required<HTMLAudioElement>("remote-audio");

let transport: WebRtcTransport | null = null;
let bridge: RealtimeEventBridge | null = null;

cockpit.subscribe((state) => {
  status.textContent = state.phase;
  const stateDetail = [state.model, state.voice, state.activeRunId].filter(Boolean).join(" · ");
  detail.textContent = state.lastError
    ?? (stateDetail || (state.phase === "idle"
      ? "Ready. Starting will ask this browser for microphone access."
      : "Preparing the realtime voice session."));
  statusPanel.dataset.tone = state.phase === "error" ? "error" : "neutral";
  start.disabled = state.phase !== "idle" && state.phase !== "error";
  stop.disabled = state.phase === "idle" || state.phase === "error";
});

start.addEventListener("click", async () => {
  await teardown();
  renderProgress("preparing microphone", "Connecting to the local cockpit before requesting browser microphone access.");
  start.disabled = true;
  stop.disabled = false;
  try {
    const launch = await cockpit.createVoiceSession(session.value);
    let activeBridge: RealtimeEventBridge;
    transport = new WebRtcTransport({
      onEvent: (raw) => activeBridge.handle(raw),
      onRemoteStream: (stream) => {
        audio.srcObject = stream;
        void audio.play();
      },
      onConnectionState: (state) => {
        if (state === "connected") cockpit.setPhase("listening");
        if (state === "failed" || state === "disconnected") cockpit.fail(`WebRTC ${state}`);
      },
      onMicrophoneState: (state) => {
        if (state === "requesting") {
          renderProgress("microphone permission", "Waiting for the browser permission prompt. Choose Allow to continue.");
        } else {
          renderProgress("microphone ready", "Access granted. Establishing the secure realtime audio connection.");
        }
      },
      exchangeOffer: (sdp) => gateway.request<string>("cockpit.realtime.createCall", {
        sessionKey: session.value,
        sdp,
      }),
    });
    activeBridge = new RealtimeEventBridge(cockpit, transport);
    bridge = activeBridge;
    bridge.start();
    await transport.connect(launch);
  } catch (error) {
    cockpit.fail(describeStartError(error));
    await teardown(false);
  }
});

stop.addEventListener("click", () => void teardown());
steer.addEventListener("click", async () => {
  try {
    await bridge?.steer(steeringText.value, "steer");
  } catch (error) {
    cockpit.fail(error);
  }
});
cancel.addEventListener("click", async () => {
  try {
    await bridge?.steer("Cancel the active work", "cancel");
  } catch (error) {
    cockpit.fail(error);
  }
});

window.addEventListener("pagehide", () => {
  void teardown().finally(() => gateway.close());
}, { once: true });

async function teardown(reset = true): Promise<void> {
  bridge?.stop();
  bridge = null;
  transport?.close();
  transport = null;
  audio.pause();
  audio.srcObject = null;
  if (reset) cockpit.stop();
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function renderProgress(label: string, message: string): void {
  status.textContent = label;
  detail.textContent = message;
  statusPanel.dataset.tone = "neutral";
}

function describeStartError(error: unknown): Error {
  if (!(error instanceof DOMException)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  switch (error.name) {
    case "NotAllowedError":
      return new Error("Microphone access was denied. Allow microphone access for 127.0.0.1 in browser site settings, then try again.");
    case "NotFoundError":
      return new Error("No microphone was found. Connect or enable an input device, then try again.");
    case "NotReadableError":
      return new Error("The microphone is busy or unavailable to the browser. Close other audio capture apps and try again.");
    case "SecurityError":
      return new Error("The browser blocked microphone access for this page. Open the cockpit directly at http://127.0.0.1:4280.");
    case "OverconstrainedError":
      return new Error("The selected microphone cannot satisfy the requested audio settings.");
    default:
      return new Error(`Microphone request failed (${error.name}): ${error.message}`);
  }
}
