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
      const fail = (error: Error) => {
        this.#ready = null;
        reject(error);
      };
      socket.once("error", fail);
      socket.on("message", (data) => {
        let frame: GatewayResponse | GatewayWireEvent;
        try {
          frame = JSON.parse(String(data)) as GatewayResponse | GatewayWireEvent;
        } catch {
          return;
        }
        if (frame.type === "event" && frame.event === "connect.challenge") {
          const payload = frame.payload as { nonce?: unknown } | undefined;
          if (typeof payload?.nonce !== "string") {
            fail(new Error("Gateway challenge did not include a nonce"));
            return;
          }
          const id = randomUUID();
          this.#pending.set(id, {
            resolve: () => {
              socket.off("error", fail);
              resolve();
            },
            reject: fail,
            timer: setTimeout(() => fail(new Error("Gateway handshake timed out")), this.timeoutMs),
          });
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
          return;
        }
        this.onFrame(frame);
      });
      socket.on("close", () => {
        const error = new Error("Gateway connection closed");
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.#pending.clear();
        this.#ready = null;
        this.#socket = null;
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

  private get timeoutMs(): number {
    return this.options.requestTimeoutMs ?? 15_000;
  }
}
