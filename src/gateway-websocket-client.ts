import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { GatewayConnection, GatewayEvent } from "./contracts.js";

interface GatewayResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
}

interface GatewayWireEvent {
  type: "event";
  event: string;
  payload?: unknown;
}

interface GatewayHelloOk {
  type: "hello-ok";
  protocol: 4;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GatewayWebSocketOptions {
  url: string;
  token: string;
  requestTimeoutMs?: number;
}

/**
 * Loopback backend transport for OpenClaw Gateway protocol v4.
 *
 * This deliberately uses the Gateway's backend-client path: the durable shared
 * token remains in the service process and is never exposed to browser code.
 */
export class GatewayWebSocketClient implements GatewayConnection {
  readonly #listeners = new Set<(event: GatewayEvent) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #socket: WebSocket | null = null;
  #ready: Promise<void> | null = null;

  constructor(readonly options: GatewayWebSocketOptions) {}

  connect(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.url);
      this.#socket = socket;
      let admitted = false;
      let admissionSettled = false;
      let disconnected = false;
      let challengeReceived = false;
      const admissionTimer = setTimeout(() => {
        failAdmission(new Error("Gateway handshake timed out"));
      }, this.timeoutMs);

      const disconnect = (error: Error) => {
        if (disconnected) return;
        disconnected = true;
        this.rejectPending(error);
        if (this.#socket === socket) {
          this.#socket = null;
          this.#ready = null;
        }
      };
      const terminate = () => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      };
      const failAdmission = (error: Error) => {
        if (admissionSettled) return;
        admissionSettled = true;
        clearTimeout(admissionTimer);
        disconnect(error);
        reject(error);
        terminate();
      };
      socket.on("error", (error) => {
        const connectionError = new Error(`Gateway connection error: ${error.message}`);
        if (!admitted) {
          failAdmission(connectionError);
          return;
        }
        disconnect(connectionError);
        terminate();
      });
      socket.on("message", (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          if (!admitted) failAdmission(new Error("Gateway handshake was not valid JSON"));
          return;
        }
        if (!isGatewayResponse(parsed) && !isGatewayWireEvent(parsed)) {
          if (!admitted) failAdmission(new Error("Gateway handshake was not a valid Gateway frame"));
          return;
        }
        const frame = parsed;
        if (frame.type === "event" && frame.event === "connect.challenge") {
          if (admitted) {
            const error = new Error("Gateway sent an unexpected connect challenge");
            disconnect(error);
            terminate();
            return;
          }
          if (challengeReceived) {
            failAdmission(new Error("Gateway sent an unexpected connect challenge"));
            return;
          }
          challengeReceived = true;
          const payload = frame.payload as { nonce?: unknown } | undefined;
          if (!isNonEmptyString(payload?.nonce)) {
            failAdmission(new Error("Gateway challenge did not include a nonce"));
            return;
          }
          const id = randomUUID();
          this.#pending.set(id, {
            resolve: (value) => {
              if (!isGatewayHelloOk(value)) {
                failAdmission(new Error("Gateway connect response was not a valid hello-ok envelope"));
                return;
              }
              admitted = true;
              admissionSettled = true;
              clearTimeout(admissionTimer);
              resolve();
            },
            reject: failAdmission,
            timer: admissionTimer,
          });
          try {
            socket.send(JSON.stringify({
              type: "req",
              id,
              method: "connect",
              params: {
                minProtocol: 4,
                maxProtocol: 4,
                client: {
                  id: "gateway-client",
                  version: "0.1.0",
                  platform: process.platform,
                  mode: "backend",
                },
                role: "operator",
                scopes: ["operator.read", "operator.write"],
                caps: [],
                commands: [],
                permissions: {},
                auth: { token: this.options.token },
                locale: "en-US",
                userAgent: "linux-voice-cockpit/0.1.0",
              },
            }));
          } catch (error) {
            failAdmission(asError(error, "Gateway connect request failed"));
          }
          return;
        }
        this.onFrame(frame);
      });
      socket.on("close", () => {
        const error = new Error("Gateway connection closed");
        if (!admitted) {
          failAdmission(error);
          return;
        }
        disconnect(error);
      });
    });
    return this.#ready;
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await this.connect();
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway connection is not open");
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, this.timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    socket.close(1000, "cockpit shutdown");
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  }

  private onFrame(frame: GatewayResponse | GatewayWireEvent): void {
    if (frame.type === "event") {
      for (const listener of this.#listeners) {
        listener({ event: frame.event, payload: frame.payload });
      }
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) pending.resolve(frame.payload);
    else pending.reject(new Error(frame.error?.message ?? "Gateway request failed"));
  }

  private rejectPending(error: Error): void {
    const pendingRequests = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private get timeoutMs(): number {
    return this.options.requestTimeoutMs ?? 15_000;
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGatewayResponse(value: unknown): value is GatewayResponse {
  return isRecord(value)
    && value.type === "res"
    && typeof value.id === "string"
    && typeof value.ok === "boolean";
}

function isGatewayWireEvent(value: unknown): value is GatewayWireEvent {
  return isRecord(value)
    && value.type === "event"
    && typeof value.event === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isGatewayHelloOk(value: unknown): value is GatewayHelloOk {
  if (!isRecord(value) || value.type !== "hello-ok" || value.protocol !== 4) return false;

  const { server, features, snapshot, auth, policy } = value;
  return isRecord(server)
    && isNonEmptyString(server.version)
    && isNonEmptyString(server.connId)
    && isRecord(features)
    && isStringArray(features.methods)
    && isStringArray(features.events)
    && isRecord(snapshot)
    && isRecord(auth)
    && isNonEmptyString(auth.role)
    && isStringArray(auth.scopes)
    && isRecord(policy)
    && isPositiveInteger(policy.maxPayload)
    && isPositiveInteger(policy.maxBufferedBytes)
    && isPositiveInteger(policy.tickIntervalMs);
}
