import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CockpitController,
  RealtimeEventBridge,
  type GatewayClient,
  type GatewayEvent,
  type RealtimeChannel,
  OpenClawOAuthRealtime,
} from "../src/index.js";

class FakeGateway implements GatewayClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly listeners = new Set<(event: GatewayEvent) => void>();

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, params });
    if (method === "talk.catalog") return {
      realtime: {
        ready: true,
        providers: [{ id: "openai", configured: true, transports: ["webrtc"] }],
      },
    } as T;
    if (method === "talk.client.create") return {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "ephemeral-test-only",
      model: "gpt-realtime-2.1",
      voice: "marin",
    } as T;
    if (method === "talk.client.toolCall") return { runId: "run-1" } as T;
    if (method === "talk.client.steer") return { ok: true, mode: params.mode } as T;
    throw new Error(`Unexpected request ${method}`);
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeChannel implements RealtimeChannel {
  readonly events: Record<string, unknown>[] = [];
  send(event: Record<string, unknown>): void { this.events.push(event); }
}

test("uses server-mediated OpenClaw OAuth by default", async () => {
  const gateway = new FakeGateway();
  const cockpit = new CockpitController(gateway);
  const launch = await cockpit.createVoiceSession("agent:main:test");

  assert.equal(launch.authMode, "openclaw-oauth");
  assert.equal(launch.sdpExchange, "server-proxy");
  assert.deepEqual(gateway.requests, []);
  assert.equal(JSON.stringify(cockpit.state).includes(launch.clientSecret), false);
});

test("Gateway Talk is an explicit fallback path", async () => {
  const gateway = new FakeGateway();
  const cockpit = new CockpitController(gateway);
  const launch = await cockpit.createVoiceSession("agent:main:test", "gateway-talk");
  assert.equal(launch.clientSecret, "ephemeral-test-only");
  assert.equal(launch.authMode, "gateway-talk");
  assert.deepEqual(gateway.requests.map((request) => request.method), ["talk.catalog", "talk.client.create"]);
});

test("bridges a fragmented consult tool call and returns the final result", async () => {
  const gateway = new FakeGateway();
  const cockpit = new CockpitController(gateway);
  const channel = new FakeChannel();
  const bridge = new RealtimeEventBridge(cockpit, channel);
  await cockpit.createVoiceSession("agent:main:test");
  bridge.start();

  await bridge.handle({
    type: "response.function_call_arguments.delta",
    item_id: "item-1",
    call_id: "call-1",
    name: "openclaw_agent_consult",
    delta: "{\"message\":\"inspect\"}",
  });
  const finishing = bridge.handle({
    type: "response.function_call_arguments.done",
    item_id: "item-1",
    call_id: "call-1",
    name: "openclaw_agent_consult",
    arguments: " ignored by buffered deltas ",
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cockpit.state.activeRunId, "run-1");
  gateway.emit({
    event: "chat",
    payload: {
      runId: "run-1",
      state: "final",
      message: { content: [{ type: "text", text: "Inspection complete" }] },
    },
  });
  await finishing;

  assert.equal(cockpit.state.activeRunId, null);
  assert.equal(channel.events[0]?.type, "conversation.item.create");
  assert.equal(channel.events[1]?.type, "response.create");
  const item = channel.events[0]?.item as { output: string };
  assert.deepEqual(JSON.parse(item.output), { result: "Inspection complete" });
});

test("steering stays bound to the selected OpenClaw session", async () => {
  const gateway = new FakeGateway();
  const cockpit = new CockpitController(gateway);
  const bridge = new RealtimeEventBridge(cockpit, new FakeChannel());
  await cockpit.createVoiceSession("agent:main:test");

  await bridge.steer("stop", "cancel");
  const request = gateway.requests.at(-1);
  assert.equal(request?.method, "talk.client.steer");
  assert.deepEqual(request?.params, {
    sessionKey: "agent:main:test",
    text: "stop",
    mode: "cancel",
  });
});

test("stop removes all session metadata", async () => {
  const gateway = new FakeGateway();
  const cockpit = new CockpitController(gateway);
  await cockpit.createVoiceSession("agent:main:test");
  cockpit.setActiveTool("call-1", "run-1");
  cockpit.stop();

  assert.deepEqual(cockpit.state, {
    phase: "idle",
    sessionKey: null,
    model: null,
    voice: null,
    startedAt: null,
    activeRunId: null,
    activeToolCallId: null,
    lastError: null,
  });
});

test("OAuth refresh and GPT Live admission stay server-side", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-oauth-"));
  const storePath = join(directory, "auth-profiles.json");
  await writeFile(storePath, JSON.stringify({ version: 1, profiles: {
    "openai:default": {
      type: "oauth", provider: "openai", access: "expired", refresh: "refresh-old",
      expires: 1, accountId: "acct-test",
    },
  } }));
  const calls: Array<{
    url: string;
    authorization: string | null;
    account: string | null;
    contentType: string | null;
    protocol: string | null;
    body: string;
  }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get("Authorization"),
      account: headers.get("ChatGPT-Account-ID"),
      contentType: headers.get("Content-Type"),
      protocol: headers.get("OpenAI-Alpha"),
      body: String(init?.body ?? ""),
    });
    if (url.includes("/oauth/token")) return new Response(JSON.stringify({
      access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("answer-sdp", { status: 200 });
  };
  const broker = new OpenClawOAuthRealtime({
    location: { kind: "json", path: storePath }, fetch: fakeFetch, now: () => 10_000,
  });

  assert.equal(await broker.createCall("offer-sdp\r\n"), "answer-sdp");
  assert.match(calls[0]!.body, /grant_type=refresh_token/);
  assert.equal(calls[1]!.url, "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas");
  assert.equal(calls[1]!.authorization, "Bearer access-new");
  assert.equal(calls[1]!.account, "acct-test");
  assert.equal(calls[1]!.contentType, "application/json");
  assert.equal(calls[1]!.protocol, "quicksilver=v1");
  assert.deepEqual(JSON.parse(calls[1]!.body), {
    sdp: "offer-sdp\r\n",
    session: {
      type: "quicksilver",
      model: "gpt-realtime",
      instructions: "",
      audio: {
        input: { format: { type: "audio/pcm", rate: 24_000 } },
        output: { voice: "cove" },
      },
    },
  });
  const persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(persisted.profiles["openai:default"].refresh, "refresh-new");
});

test("GPT Live admission errors expose bounded sanitized provider detail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cockpit-oauth-error-"));
  const storePath = join(directory, "auth-profiles.json");
  await writeFile(storePath, JSON.stringify({ version: 1, profiles: {
    "openai:default": {
      type: "oauth", provider: "openai", access: "current", refresh: "refresh",
      expires: Date.now() + 3_600_000, accountId: "acct-test",
    },
  } }));
  const broker = new OpenClawOAuthRealtime({
    location: { kind: "json", path: storePath },
    fetch: async () => new Response(`bad\nrequest ${"x".repeat(1_000)}`, { status: 400 }),
  });

  await assert.rejects(
    broker.createCall("offer-sdp"),
    (error: Error) => error.message.startsWith("ChatGPT GPT Live admission failed (400): bad request ")
      && !error.message.includes("\n")
      && error.message.length <= 860,
  );
});
