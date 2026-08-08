import { createServer } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { GatewayWebSocketClient } from "./gateway-websocket-client.js";
import { OpenClawOAuthRealtime, type OAuthProfileLocation } from "./openclaw-oauth-realtime.js";
import { cockpitContentSecurityPolicy } from "./content-security-policy.js";
import { initialProjection, sanitizeProjection } from "./state-projection.js";
import {
  type ControlFrame,
  helloFrame,
  isTurnMarkerType,
  isValidAudioFrame,
} from "./desktop-audio-protocol.js";
import type { BrowserConfiguration, CockpitProjection } from "./contracts.js";

interface LocalRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

const host = process.env.COCKPIT_HOST ?? "127.0.0.1";
const port = Number(process.env.COCKPIT_PORT ?? "4280");
const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
const sessionKey = process.env.COCKPIT_SESSION_KEY?.trim() ?? "agent:main:project:linux-voice-cockpit";
const allowedMethods = new Set([
  "talk.catalog",
  "talk.client.create",
  "talk.client.toolCall",
  "talk.client.steer",
  "cockpit.realtime.createCall",
]);
const authMode = process.env.COCKPIT_REALTIME_AUTH_MODE ?? "openclaw-oauth";
const allowApiKeyFallback = process.env.COCKPIT_ALLOW_API_KEY_FALLBACK === "true";
const browserConfiguration: BrowserConfiguration = {
  subscription: {
    model: preference("COCKPIT_SUBSCRIPTION_MODEL", "gpt-live-1-boulder-alpha"),
    voice: preference("COCKPIT_SUBSCRIPTION_VOICE", "ember"),
  },
  api: {
    model: preference("COCKPIT_API_MODEL", "gpt-realtime-2.1"),
    voice: preference("COCKPIT_API_VOICE", "marin"),
  },
};
const statePath = process.env.COCKPIT_STATE_PATH
  ?? `${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/linux-voice-cockpit.json`;
const authStorePath = process.env.COCKPIT_OPENCLAW_AUTH_STORE
  ?? `${process.env.HOME}/.openclaw/agents/main/agent/openclaw-agent.sqlite`;
const authLocation: OAuthProfileLocation = {
  kind: authStorePath.endsWith(".json") ? "json" : "sqlite",
  path: authStorePath,
  ...(process.env.COCKPIT_OPENCLAW_AUTH_PROFILE
    ? { profileId: process.env.COCKPIT_OPENCLAW_AUTH_PROFILE }
    : {}),
};
if (authMode !== "openclaw-oauth" && !(authMode === "gateway-talk" && allowApiKeyFallback)) {
  throw new Error("API-key/Gateway Talk mode requires COCKPIT_ALLOW_API_KEY_FALLBACK=true");
}
const oauthRealtime = new OpenClawOAuthRealtime({
  location: authLocation,
  model: browserConfiguration.subscription.model,
  voice: browserConfiguration.subscription.voice,
});
if (!gatewayToken) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required; it is never sent to the browser");
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const contentSecurityPolicy = cockpitContentSecurityPolicy(allowApiKeyFallback);
const assets = new Map<string, { path: string; type: string }>([
  ["/", { path: `${root}/static/canary.html`, type: "text/html; charset=utf-8" }],
  ["/canary.js", { path: `${root}/dist/src/browser-canary.js`, type: "text/javascript; charset=utf-8" }],
  ["/cockpit-controller.js", { path: `${root}/dist/src/cockpit-controller.js`, type: "text/javascript; charset=utf-8" }],
  ["/realtime-event-bridge.js", { path: `${root}/dist/src/realtime-event-bridge.js`, type: "text/javascript; charset=utf-8" }],
  ["/webrtc-transport.js", { path: `${root}/dist/src/webrtc-transport.js`, type: "text/javascript; charset=utf-8" }],
  ["/audio-tap.js", { path: `${root}/dist/src/audio-tap.js`, type: "text/javascript; charset=utf-8" }],
  ["/desktop-audio-protocol.js", { path: `${root}/dist/src/desktop-audio-protocol.js`, type: "text/javascript; charset=utf-8" }],
  ["/audio-tap-worklet.js", { path: `${root}/static/audio-tap-worklet.js`, type: "text/javascript; charset=utf-8" }],
]);

/** ~2 s of audio. Past this a subscriber is not keeping up and oldest audio is dropped. */
const AUDIO_BACKLOG_FRAMES = 50;

interface AudioSubscriber {
  socket: WebSocket;
  queue: Array<{ data: string | Buffer; binary: boolean }>;
  sending: boolean;
}

let projection = initialProjection();
let activeBrowser: WebSocket | null = null;
let projectionWrite = Promise.resolve();
queueProjectionWrite();

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/desktop/state") {
    json(response, 200, projection);
    return;
  }
  if (request.method === "POST" && request.url === "/desktop/control") {
    if (!isLoopback(request.socket.remoteAddress)
      || (request.headers.origin && request.headers.origin !== `http://${host}:${port}`)) {
      json(response, 403, { error: "Desktop control is loopback-only" });
      return;
    }
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      json(response, 415, { error: "Desktop control requires application/json" });
      return;
    }
    try {
      const body = JSON.parse(await readBody(request)) as { action?: unknown };
      if (body.action !== "start" && body.action !== "stop") {
        json(response, 400, { error: "Desktop control action must be start or stop" });
        return;
      }
      if (!activeBrowser || activeBrowser.readyState !== WebSocket.OPEN) {
        json(response, 409, { error: "No browser microphone owner is connected" });
        return;
      }
      activeBrowser.send(JSON.stringify({ type: "desktop-control", action: body.action }));
      json(response, 202, { accepted: true, action: body.action });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.url === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "no-store" }).end();
    return;
  }
  const asset = assets.get(request.url ?? "");
  if (!asset) {
    response.writeHead(404).end("Not found");
    return;
  }
  try {
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy,
      "Referrer-Policy": "no-referrer",
    });
    response.end(await readFile(asset.path));
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  }
});

// Both endpoints use noServer and share one upgrade router. Attaching two path-scoped
// WebSocketServers to the same HTTP server does not work: each aborts the handshake for
// any path that is not its own, so whichever registers first kills the other.
const sockets = new WebSocketServer({ noServer: true });
const audioSockets = new WebSocketServer({ noServer: true });
const audioSubscribers = new Map<WebSocket, AudioSubscriber>();

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "/", `http://${host}:${port}`).pathname;
  if (pathname === "/control") {
    sockets.handleUpgrade(request, socket, head, (client) => {
      sockets.emit("connection", client, request);
    });
    return;
  }
  if (pathname === "/desktop/audio") {
    if (!isLoopback(request.socket.remoteAddress) || !isAllowedAudioOrigin(request.headers.origin)) {
      refuseUpgrade(socket, 403, "Desktop audio is loopback-only");
      return;
    }
    audioSockets.handleUpgrade(request, socket, head, (client) => {
      audioSockets.emit("connection", client, request);
    });
    return;
  }
  refuseUpgrade(socket, 404, "Unknown WebSocket endpoint");
});

/** Answer with a real status line so a rejected consumer sees why, not a bare reset. */
function refuseUpgrade(socket: import("node:stream").Duplex, status: number, reason: string): void {
  const body = `${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Not Found"}\r\n`
    + "Connection: close\r\n"
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

sockets.on("connection", (browser, request) => {
  const origin = request.headers.origin;
  if (origin !== `http://${host}:${port}`) {
    browser.close(1008, "Origin not allowed");
    return;
  }
  void serveBrowser(browser);
});

audioSockets.on("connection", (subscriber) => {
  const state: AudioSubscriber = { socket: subscriber, queue: [], sending: false };
  audioSubscribers.set(subscriber, state);
  // hello precedes every binary frame so the consumer builds its resampler against a
  // known rate instead of guessing one.
  enqueueSubscriber(state, JSON.stringify(helloFrame(projection.phase)), false);
  subscriber.once("close", () => audioSubscribers.delete(subscriber));
  subscriber.on("error", () => audioSubscribers.delete(subscriber));
});

/**
 * Presence connects with the Node `ws` client, which sends no Origin header at all.
 * Reject foreign origins, allow an absent one; the loopback bind is the real boundary.
 */
function isAllowedAudioOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === `http://${host}:${port}`;
}

/** Control frames are never dropped: losing speak.end strands a consumer mid-utterance. */
function broadcastAudioControl(frame: ControlFrame): void {
  const encoded = JSON.stringify(frame);
  for (const subscriber of audioSubscribers.values()) {
    enqueueSubscriber(subscriber, encoded, false);
  }
}

/**
 * Best effort. A stalled subscriber must never backpressure the browser's control
 * socket, so frames are dropped rather than queued; the seq gap tells the consumer.
 */
function broadcastAudioFrame(frame: Buffer): void {
  for (const subscriber of audioSubscribers.values()) {
    const pendingAudio = subscriber.queue.reduce((count, item) => count + Number(item.binary), 0);
    if (pendingAudio >= AUDIO_BACKLOG_FRAMES) {
      const oldestAudio = subscriber.queue.findIndex((item) => item.binary);
      if (oldestAudio >= 0) subscriber.queue.splice(oldestAudio, 1);
    }
    enqueueSubscriber(subscriber, frame, true);
  }
}

/** Per-subscriber queue preserves text/binary ordering without using the socket as storage. */
function enqueueSubscriber(subscriber: AudioSubscriber, data: string | Buffer, binary: boolean): void {
  if (subscriber.socket.readyState !== WebSocket.OPEN) return;
  subscriber.queue.push({ data, binary });
  pumpSubscriber(subscriber);
}

function pumpSubscriber(subscriber: AudioSubscriber): void {
  if (subscriber.sending || subscriber.socket.readyState !== WebSocket.OPEN) return;
  const next = subscriber.queue.shift();
  if (!next) return;
  subscriber.sending = true;
  subscriber.socket.send(next.data, { binary: next.binary }, (error) => {
    subscriber.sending = false;
    if (error) {
      audioSubscribers.delete(subscriber.socket);
      subscriber.socket.terminate();
      return;
    }
    pumpSubscriber(subscriber);
  });
}

async function serveBrowser(browser: WebSocket): Promise<void> {
  const gateway = new GatewayWebSocketClient({ url: gatewayUrl, token: gatewayToken! });
  const unsubscribe = gateway.subscribe((event) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ type: "event", ...event }));
  });
  try {
    await gateway.connect();
    activeBrowser = browser;
    projection = { ...projection, browserConnected: true, updatedAt: new Date().toISOString() };
    queueProjectionWrite();
    browser.send(JSON.stringify({ type: "ready", configuration: browserConfiguration }));
    browser.on("message", async (raw, isBinary) => {
      let request: LocalRequest | undefined;
      if (isBinary) {
        const audio = toBuffer(raw);
        if (isValidAudioFrame(audio)) broadcastAudioFrame(audio);
        return;
      }
      try {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.type === "state") {
          const previousPhase = projection.phase;
          projection = sanitizeProjection(frame.state, true);
          queueProjectionWrite();
          if (projection.phase !== previousPhase) {
            broadcastAudioControl({ type: "phase", phase: projection.phase, t: Date.now() });
          }
          return;
        }
        if (frame.type === "turn") {
          relayTurnMarker(frame.marker);
          return;
        }
        request = frame as unknown as LocalRequest;
        assertAllowedRequest(request);
        if (request.method === "talk.client.create" && !allowApiKeyFallback) {
          throw new Error("OpenAI Realtime API fallback is disabled by cockpit policy");
        }
        const payload = request.method === "cockpit.realtime.createCall"
          ? await oauthRealtime.createCall(String(request.params?.sdp ?? ""))
          : await gateway.request(request.method, request.params ?? {});
        browser.send(JSON.stringify({ type: "response", id: request.id, ok: true, payload }));
      } catch (error) {
        browser.send(JSON.stringify({
          type: "response",
          id: request?.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
  } catch (error) {
    browser.send(JSON.stringify({ type: "fatal", error: error instanceof Error ? error.message : String(error) }));
    browser.close(1011, "Gateway connection failed");
  }
  browser.once("close", () => {
    if (activeBrowser === browser) activeBrowser = null;
    const previousPhase = projection.phase;
    projection = {
      ...projection,
      phase: projection.phase === "idle" ? "idle" : "error",
      error: projection.phase === "idle" ? null : "Browser microphone owner disconnected",
      browserConnected: false,
      updatedAt: new Date().toISOString(),
    };
    queueProjectionWrite();
    // A page that dies mid-utterance sends no speak.end. Publish the phase change so a
    // consumer can tear its own session down instead of waiting on an utterance that
    // will never close.
    if (projection.phase !== previousPhase) {
      broadcastAudioControl({ type: "phase", phase: projection.phase, t: Date.now() });
    }
    unsubscribe();
    void gateway.close();
  });
}

function toBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

/** Re-emits a browser turn marker on the tap, dropping anything not in the vocabulary. */
function relayTurnMarker(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const marker = value as { type?: unknown; id?: unknown };
  if (!isTurnMarkerType(marker.type) || !Number.isInteger(marker.id)) return;
  broadcastAudioControl({
    type: marker.type,
    id: (marker.id as number) >>> 0,
    t: Date.now(),
  });
}

function preference(name: string, fallback: string): string {
  return process.env[name]?.trim().slice(0, 120) || fallback;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 4096) reject(new Error("Desktop control body is too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }).end(`${JSON.stringify(body)}\n`);
}

function queueProjectionWrite(): void {
  const snapshot: CockpitProjection = { ...projection };
  projectionWrite = projectionWrite
    .then(async () => {
      const temporary = `${statePath}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      await rename(temporary, statePath);
    })
    .catch((error) => {
      process.stderr.write(`Failed to publish cockpit state: ${error instanceof Error ? error.message : String(error)}\n`);
    });
}

function assertAllowedRequest(request: LocalRequest): void {
  if (!request || typeof request.id !== "string" || typeof request.method !== "string") {
    throw new Error("Malformed local control request");
  }
  if (!allowedMethods.has(request.method)) {
    throw new Error(`Local control method is not allowed: ${request.method}`);
  }
  if (request.method === "talk.catalog") return;
  if (request.params?.sessionKey !== sessionKey) {
    throw new Error("Local control request targeted an unauthorized OpenClaw session");
  }
}

server.listen(port, host, () => {
  process.stdout.write(`Linux Voice Cockpit canary listening on http://${host}:${port}\n`);
});

async function shutdown(): Promise<void> {
  for (const client of sockets.clients) client.close(1001, "service shutdown");
  for (const client of audioSubscribers.keys()) client.close(1001, "service shutdown");
  sockets.close();
  audioSockets.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown().finally(() => process.exit(0)));
}
