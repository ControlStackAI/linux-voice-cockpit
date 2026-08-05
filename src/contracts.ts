export type CockpitPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export interface CockpitState {
  phase: CockpitPhase;
  sessionKey: string | null;
  model: string | null;
  voice: string | null;
  startedAt: string | null;
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
