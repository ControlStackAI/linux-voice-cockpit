export type CockpitPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export interface CockpitState {
  phase: CockpitPhase;
  transport: "gateway-talk" | null;
  sessionKey: string | null;
  model: string | null;
  voice: string | null;
  startedAt: string | null;
  connectedAt: string | null;
  listeningAt: string | null;
  activeRunId: string | null;
  activeToolCallId: string | null;
  lastError: string | null;
}

export interface TalkCatalog {
  realtime?: {
    ready?: boolean;
    providers?: Array<{
      id: string;
      configured?: boolean;
      transports?: string[];
    }>;
  };
}

export interface TalkWebRtcLaunch {
  authMode?: "gateway-talk";
  provider: string;
  transport: "webrtc";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  voice?: string;
  expiresAt?: number;
}

export interface ToolCallAccepted {
  runId?: string;
  idempotencyKey?: string;
}

export interface GatewayEvent {
  event: string;
  payload?: unknown;
}

export interface GatewayClient {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  subscribe(listener: (event: GatewayEvent) => void): () => void;
}

export interface GatewayConnection extends GatewayClient {
  connect(): Promise<void>;
  close(): Promise<void> | void;
}

export interface RealtimeChannel {
  send(event: Record<string, unknown>): void;
}

export interface RealtimeToolCall {
  itemId: string;
  callId: string;
  name: string;
  argumentsJson: string;
}

export type StateListener = (state: Readonly<CockpitState>) => void;

export interface VoiceRoutePreference {
  model: string;
  voice: string;
}

export interface BrowserConfiguration {
  realtime: VoiceRoutePreference;
}

export interface CockpitProjection {
  schemaVersion: 1;
  phase: CockpitPhase;
  transport: "gateway-talk" | null;
  model: string | null;
  voice: string | null;
  error: string | null;
  connectedAt: string | null;
  listeningAt: string | null;
  browserConnected: boolean;
  updatedAt: string;
}
