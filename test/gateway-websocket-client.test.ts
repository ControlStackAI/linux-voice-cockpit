import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { GatewayWebSocketClient } from "../src/gateway-websocket-client.js";

interface GatewayRequest {
  type: "req";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface GatewayFixture {
  url: string;
  close(): Promise<void>;
}

async function createGatewayFixture(
  onConnection: (socket: WebSocket) => void,
): Promise<GatewayFixture> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Set<WebSocket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function sendChallenge(socket: WebSocket): void {
  socket.send(JSON.stringify({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "fixture-nonce" },
  }));
}

function parseRequest(data: WebSocket.RawData): GatewayRequest {
  return JSON.parse(String(data)) as GatewayRequest;
}

function helloOk(): Record<string, unknown> {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "fixture", connId: "fixture-connection" },
    features: { methods: ["talk.catalog"], events: ["talk"] },
    snapshot: {},
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    policy: { maxPayload: 1024, maxBufferedBytes: 2048, tickIntervalMs: 1000 },
  };
}

function sendResponse(socket: WebSocket, id: string, payload: unknown): void {
  socket.send(JSON.stringify({ type: "res", id, ok: true, payload }));
}

test("Gateway WebSocket admission sends the backend auth payload", async (context) => {
  let receivedRequest: GatewayRequest | undefined;
  const fixture = await createGatewayFixture((socket) => {
    sendChallenge(socket);
    socket.once("message", (data) => {
      receivedRequest = parseRequest(data);
      sendResponse(socket, receivedRequest.id, helloOk());
    });
  });
  context.after(() => fixture.close());
  const client = new GatewayWebSocketClient({
    url: fixture.url,
    token: "fixture-token",
    requestTimeoutMs: 250,
  });

  await client.connect();

  assert.equal(receivedRequest?.method, "connect");
  assert.equal(receivedRequest?.params.minProtocol, 4);
  assert.equal(receivedRequest?.params.maxProtocol, 4);
  assert.deepEqual(receivedRequest?.params.auth, { token: "fixture-token" });
  assert.equal((receivedRequest?.params.client as { mode?: unknown }).mode, "backend");
  await client.close();
});

test("Gateway WebSocket admission times out before a challenge and closes the socket", async (context) => {
  let peerClosed: Promise<unknown[]> | undefined;
  const fixture = await createGatewayFixture((socket) => {
    peerClosed = once(socket, "close");
  });
  context.after(() => fixture.close());
  const client = new GatewayWebSocketClient({
    url: fixture.url,
    token: "fixture-token",
    requestTimeoutMs: 50,
  });

  await assert.rejects(client.connect(), /Gateway handshake timed out/);
  assert.ok(peerClosed);
  await peerClosed;
});

test("Gateway WebSocket admission rejects an early peer close", async (context) => {
  const fixture = await createGatewayFixture((socket) => {
    socket.close(1000, "fixture early close");
  });
  context.after(() => fixture.close());
  const client = new GatewayWebSocketClient({
    url: fixture.url,
    token: "fixture-token",
    requestTimeoutMs: 250,
  });

  await assert.rejects(client.connect(), /Gateway connection closed/);
});

test("Gateway WebSocket admission rejects a malformed hello-ok envelope", async (context) => {
  const fixture = await createGatewayFixture((socket) => {
    sendChallenge(socket);
    socket.once("message", (data) => {
      const request = parseRequest(data);
      sendResponse(socket, request.id, { type: "hello-ok", protocol: 4 });
    });
  });
  context.after(() => fixture.close());
  const client = new GatewayWebSocketClient({
    url: fixture.url,
    token: "fixture-token",
    requestTimeoutMs: 250,
  });

  await assert.rejects(client.connect(), /not a valid hello-ok envelope/);
});

test("Gateway WebSocket rejects an in-flight RPC when the peer closes", async (context) => {
  const fixture = await createGatewayFixture((socket) => {
    sendChallenge(socket);
    socket.on("message", (data) => {
      const request = parseRequest(data);
      if (request.method === "connect") {
        sendResponse(socket, request.id, helloOk());
        return;
      }
      assert.equal(request.method, "talk.catalog");
      socket.close(1011, "fixture mid-RPC close");
    });
  });
  context.after(() => fixture.close());
  const client = new GatewayWebSocketClient({
    url: fixture.url,
    token: "fixture-token",
    requestTimeoutMs: 250,
  });

  await client.connect();
  await assert.rejects(client.request("talk.catalog", {}), /Gateway connection closed/);
});
