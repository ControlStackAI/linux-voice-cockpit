import type {
  CockpitState,
  GatewayClient,
  StateListener,
  TalkCatalog,
  TalkWebRtcLaunch,
} from "./contracts.js";

const INITIAL_STATE: CockpitState = {
  phase: "idle",
  transport: null,
  sessionKey: null,
  model: null,
  voice: null,
  startedAt: null,
  connectedAt: null,
  listeningAt: null,
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

  async createVoiceSession(
    sessionKey: string,
    authMode: "gateway-talk" | "openclaw-oauth" = "openclaw-oauth",
    preference?: { model?: string; voice?: string },
  ): Promise<TalkWebRtcLaunch> {
    const target = sessionKey.trim();
    if (!target) throw new Error("A non-empty OpenClaw sessionKey is required");

    this.patch({
      phase: "connecting",
      transport: authMode === "openclaw-oauth" ? "subscription" : "api",
      sessionKey: target,
      model: preference?.model ?? null,
      voice: preference?.voice ?? null,
      lastError: null,
    });
    try {
      if (authMode === "openclaw-oauth") {
        const launch: TalkWebRtcLaunch = {
          authMode,
          provider: "openai",
          transport: "webrtc",
          clientSecret: "server-mediated",
          sdpExchange: "server-proxy",
        };
        this.patch({ startedAt: new Date().toISOString() });
        return launch;
      }
      const catalog = await this.gateway.request<TalkCatalog>("talk.catalog", {});
      const provider = catalog.realtime?.providers?.find((item) => item.id === "openai");
      if (!catalog.realtime?.ready || !provider?.configured) {
        throw new Error("OpenAI Realtime is not ready on this Gateway");
      }
      if (!provider.transports?.includes("webrtc")) {
        throw new Error("This Gateway does not advertise OpenAI WebRTC Talk");
      }

      const params = {
        sessionKey: target,
        provider: "openai",
        mode: "realtime",
        transport: "webrtc",
        brain: "agent-consult",
        ...(preference?.model ? { model: preference.model } : {}),
        ...(preference?.voice ? { voice: preference.voice } : {}),
      };
      let launch: TalkWebRtcLaunch;
      try {
        launch = await this.gateway.request<TalkWebRtcLaunch>("talk.client.create", params);
      } catch (error) {
        if (!preference?.voice) throw error;
        launch = await this.gateway.request<TalkWebRtcLaunch>("talk.client.create", {
          sessionKey: target,
          provider: "openai",
          mode: "realtime",
          transport: "webrtc",
          brain: "agent-consult",
        });
      }
      launch.authMode = "gateway-talk";
      launch.sdpExchange = "client-secret";
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
    this.patch({
      phase,
      lastError: phase === "error" ? this.#state.lastError : null,
      ...(phase === "listening" && !this.#state.listeningAt
        ? { listeningAt: new Date().toISOString() }
        : {}),
    });
  }

  markConnected(): void {
    if (!this.#state.connectedAt) this.patch({ connectedAt: new Date().toISOString() });
  }

  setRoute(model: string | null, voice: string | null): void {
    this.patch({ model, voice });
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
