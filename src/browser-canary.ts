import { AudioTap } from "./audio-tap.js";
import { CockpitController } from "./cockpit-controller.js";
import { RealtimeEventBridge } from "./realtime-event-bridge.js";
import { WebRtcTransport } from "./webrtc-transport.js";
import type { TurnMarker } from "./desktop-audio-protocol.js";
import type { BrowserConfiguration, CockpitState, GatewayClient, GatewayEvent } from "./contracts.js";

interface PendingLocalRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

class LocalGatewayProxy implements GatewayClient {
  readonly #socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/control`);
  readonly #pending = new Map<string, PendingLocalRequest>();
  readonly #listeners = new Set<(event: GatewayEvent) => void>();
  readonly #controlListeners = new Set<(action: "start" | "stop") => void>();
  readonly ready: Promise<BrowserConfiguration>;

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
          resolve(frame.configuration as unknown as BrowserConfiguration);
          return;
        }
        if (frame.type === "desktop-control" && (frame.action === "start" || frame.action === "stop")) {
          for (const listener of this.#controlListeners) listener(frame.action);
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

  onControl(listener: (action: "start" | "stop") => void): () => void {
    this.#controlListeners.add(listener);
    return () => this.#controlListeners.delete(listener);
  }

  async publishState(state: Readonly<CockpitState>): Promise<void> {
    await this.ready;
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({
      type: "state",
      state: {
        phase: state.phase,
        transport: state.transport,
        model: state.model,
        voice: state.voice,
        error: state.lastError,
        connectedAt: state.connectedAt,
        listeningAt: state.listeningAt,
      },
    }));
  }

  /**
   * Audio and turn markers share this one socket deliberately: WebSocket orders data
   * messages per connection regardless of type, so speak.end cannot overtake the last
   * audio frame of its utterance and clip the final word.
   */
  publishAudioFrame(frame: ArrayBuffer): void {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(frame);
  }

  publishTurnMarker(marker: TurnMarker): void {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ type: "turn", marker }));
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

const audioTap = new AudioTap({ publish: (frame) => gateway.publishAudioFrame(frame) });

let transport: WebRtcTransport | null = null;
let bridge: RealtimeEventBridge | null = null;
let startInFlight = false;

function onTurnMarker(marker: TurnMarker): void {
  // Marker first, then arm. speak.start must reach the socket ahead of the utterance's
  // first audio frame, and arming is what starts producing those frames.
  gateway.publishTurnMarker(marker);
  if (marker.type === "speak.start") audioTap.arm(marker.id);
  else if (marker.type === "speak.end" || marker.type === "speak.cancel") audioTap.disarm();
}

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
  void gateway.publishState(state);
});

start.addEventListener("click", () => void startVoice());
gateway.onControl((action) => {
  if (action === "start") void startVoice();
  else void teardown();
});

async function startVoice(): Promise<void> {
  if (startInFlight || (cockpit.state.phase !== "idle" && cockpit.state.phase !== "error")) return;
  startInFlight = true;
  await teardown();
  renderProgress("preparing microphone", "Connecting to the local cockpit before requesting browser microphone access.");
  start.disabled = true;
  stop.disabled = false;
  try {
    const configuration = await gateway.ready;
    try {
      await connectVoice("openclaw-oauth", configuration.subscription);
    } catch (error) {
      if (!isSubscriptionAdmissionDenied(error)) throw error;
      await teardown(false);
      renderProgress(
        "API fallback",
        "ChatGPT subscription admission was denied. Connecting through the configured OpenAI Realtime API route.",
      );
      await connectVoice("gateway-talk", configuration.api);
    }
  } catch (error) {
    cockpit.fail(describeStartError(error));
    await teardown(false);
  } finally {
    startInFlight = false;
  }
}

async function connectVoice(authMode: "openclaw-oauth" | "gateway-talk", preference: { model: string; voice: string }): Promise<void> {
  const launch = await cockpit.createVoiceSession(session.value, authMode, preference);
  let activeBridge: RealtimeEventBridge;
  const nextTransport = new WebRtcTransport({
    onEvent: (raw) => activeBridge.handle(raw),
    onRemoteStream: (stream) => {
      audio.srcObject = stream;
      void audio.play();
      // The tap is lip-sync only and must never break voice: a failure here degrades the
      // avatar, it does not end the call.
      void audioTap.attach(stream).catch((error: unknown) => {
        console.warn("Desktop audio tap unavailable:", error);
      });
    },
    onConnectionState: (state) => {
      if (state === "connected") {
        cockpit.markConnected();
        cockpit.setPhase("listening");
      }
      if (state === "failed" || state === "disconnected") cockpit.fail(`WebRTC ${state}`);
    },
    onMicrophoneState: (state) => {
      if (state === "requesting") {
        renderProgress("microphone permission", "Waiting for the browser permission prompt. Choose Allow to continue.");
      } else {
        renderProgress("microphone ready", "Access granted. Establishing the secure realtime audio connection.");
      }
    },
    exchangeOffer: async (sdp) => {
      const call = await gateway.request<{ sdp: string; model: string; voice: string }>("cockpit.realtime.createCall", {
        sessionKey: session.value,
        sdp,
      });
      cockpit.setRoute(call.model, call.voice);
      return call.sdp;
    },
  });
  transport = nextTransport;
  activeBridge = new RealtimeEventBridge(cockpit, nextTransport, onTurnMarker);
  bridge = activeBridge;
  bridge.start();
  await nextTransport.connect(launch);
}

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
  // stop() first: it emits speak.cancel for an open utterance, and that marker has to go
  // out while the tap and socket are still live.
  bridge?.stop();
  bridge = null;
  await audioTap.detach();
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

function isSubscriptionAdmissionDenied(error: unknown): boolean {
  return error instanceof Error
    && /ChatGPT GPT Live admission failed \((?:401|403|404)\)/.test(error.message);
}
