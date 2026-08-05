import {
  CockpitController,
  RealtimeEventBridge,
  WebRtcTransport,
  type GatewayClient,
  type GatewayEvent,
} from "./index.js";

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
      this.#socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type === "ready") {
          resolve();
          return;
        }
        if (frame.type === "fatal") {
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
      this.#socket.addEventListener("error", () => reject(new Error("Local control proxy connection failed")), { once: true });
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
  detail.textContent = state.lastError ?? [state.model, state.voice, state.activeRunId].filter(Boolean).join(" · ");
  start.disabled = state.phase !== "idle" && state.phase !== "error";
  stop.disabled = state.phase === "idle";
});

start.addEventListener("click", async () => {
  await teardown();
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
    cockpit.fail(error);
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
