import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CockpitController,
  RealtimeEventBridge,
  type GatewayClient,
  type GatewayEvent,
  type RealtimeChannel,
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

test("mints a WebRTC session through the supported Talk boundary", async () => {
  const gateway = new FakeGateway();
  const cockpit = new CockpitController(gateway);
  const launch = await cockpit.createVoiceSession("agent:main:test");

  assert.equal(launch.clientSecret, "ephemeral-test-only");
  assert.equal(cockpit.state.model, "gpt-realtime-2.1");
  assert.deepEqual(gateway.requests.map((request) => request.method), [
    "talk.catalog",
    "talk.client.create",
  ]);
  assert.equal(JSON.stringify(cockpit.state).includes(launch.clientSecret), false);
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
