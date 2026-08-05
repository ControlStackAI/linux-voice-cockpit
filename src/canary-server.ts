import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { GatewayWebSocketClient } from "./gateway-websocket-client.js";
import { OpenClawOAuthRealtime, type OAuthProfileLocation } from "./openclaw-oauth-realtime.js";

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
const oauthRealtime = new OpenClawOAuthRealtime({ location: authLocation });
if (!gatewayToken) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required; it is never sent to the browser");
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const assets = new Map<string, { path: string; type: string }>([
  ["/", { path: `${root}/static/canary.html`, type: "text/html; charset=utf-8" }],
  ["/canary.js", { path: `${root}/dist/src/browser-canary.js`, type: "text/javascript; charset=utf-8" }],
  ["/cockpit-controller.js", { path: `${root}/dist/src/cockpit-controller.js`, type: "text/javascript; charset=utf-8" }],
  ["/realtime-event-bridge.js", { path: `${root}/dist/src/realtime-event-bridge.js`, type: "text/javascript; charset=utf-8" }],
  ["/webrtc-transport.js", { path: `${root}/dist/src/webrtc-transport.js`, type: "text/javascript; charset=utf-8" }],
]);

const server = createServer(async (request, response) => {
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
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; media-src 'self' blob:; style-src 'self' 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
    });
    response.end(await readFile(asset.path));
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  }
});

const sockets = new WebSocketServer({ server, path: "/control" });
sockets.on("connection", (browser, request) => {
  const origin = request.headers.origin;
  if (origin !== `http://${host}:${port}`) {
    browser.close(1008, "Origin not allowed");
    return;
  }
  void serveBrowser(browser);
});

async function serveBrowser(browser: WebSocket): Promise<void> {
  const gateway = new GatewayWebSocketClient({ url: gatewayUrl, token: gatewayToken! });
  const unsubscribe = gateway.subscribe((event) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ type: "event", ...event }));
  });
  try {
    await gateway.connect();
    browser.send(JSON.stringify({ type: "ready" }));
    browser.on("message", async (raw) => {
      let request: LocalRequest | undefined;
      try {
        request = JSON.parse(String(raw)) as LocalRequest;
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
    unsubscribe();
    void gateway.close();
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
  sockets.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown().finally(() => process.exit(0)));
}
