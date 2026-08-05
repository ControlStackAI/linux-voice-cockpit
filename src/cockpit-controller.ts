import type {
  CockpitState,
  GatewayClient,
  StateListener,
  TalkCatalog,
  TalkWebRtcLaunch,
} from "./contracts.js";

const INITIAL_STATE: CockpitState = {
  phase: "idle",
  sessionKey: null,
  model: null,
  voice: null,
  startedAt: null,
  activeRunId: null,
  activeToolCallId: null,
  lastError: null,
};

export class CockpitController {
  readonly #listeners = new Set<StateListener>();
  #state: CockpitState = { ...INITIAL_STATE };

  constructor(readonly gateway: GatewayClient) {}

  get state(): Readonly<CockpitState> {
    return { ...this.#state };
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  async createVoiceSession(sessionKey: string): Promise<TalkWebRtcLaunch> {
    const target = sessionKey.trim();
    if (!target) throw new Error("A non-empty OpenClaw sessionKey is required");

    this.patch({ phase: "connecting", sessionKey: target, lastError: null });
    try {
      const catalog = await this.gateway.request<TalkCatalog>("talk.catalog", {});
      const provider = catalog.realtime?.providers?.find((item) => item.id === "openai");
      if (!catalog.realtime?.ready || !provider?.configured) {
        throw new Error("OpenAI Realtime is not ready on this Gateway");
      }
      if (!provider.transports?.includes("webrtc")) {
        throw new Error("This Gateway does not advertise OpenAI WebRTC Talk");
      }

      const launch = await this.gateway.request<TalkWebRtcLaunch>("talk.client.create", {
        sessionKey: target,
        provider: "openai",
        mode: "realtime",
        transport: "webrtc",
        brain: "agent-consult",
      });
      if (launch.transport !== "webrtc" || !launch.clientSecret) {
        throw new Error("Gateway returned an invalid Realtime WebRTC launch");
      }

      this.patch({
        model: launch.model ?? null,
        voice: launch.voice ?? null,
        startedAt: new Date().toISOString(),
      });
      return launch;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  setPhase(phase: CockpitState["phase"]): void {
    this.patch({ phase, lastError: phase === "error" ? this.#state.lastError : null });
  }

  setActiveTool(callId: string | null, runId: string | null): void {
    this.patch({ activeToolCallId: callId, activeRunId: runId });
  }

  fail(error: unknown): void {
    this.patch({
      phase: "error",
      lastError: error instanceof Error ? error.message : String(error),
    });
  }

  stop(): void {
    this.#state = { ...INITIAL_STATE };
    this.emit();
  }

  private patch(next: Partial<CockpitState>): void {
    this.#state = { ...this.#state, ...next };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.state;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
