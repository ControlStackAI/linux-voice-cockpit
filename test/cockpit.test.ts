import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CockpitController,
  RealtimeEventBridge,
  type GatewayClient,
  type GatewayEvent,
  type RealtimeChannel,
  cockpitContentSecurityPolicy,
  initialProjection,
  sanitizeProjection,
  FLAG_UTTERANCE_START,
  FRAME_BYTES,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  decodeAudioFrameHeader,
  decodeAudioFrameSamples,
  encodeAudioFrame,
  isValidAudioFrame,
  type TurnMarker,
  withTimeout,
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

test("CSP allows the ephemeral Realtime media endpoint", () => {
  assert.match(cockpitContentSecurityPolicy(), /connect-src 'self' https:\/\/api\.openai\.com;/);
});

test("deadline helper resolves completed work and rejects stalled work", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 100, "fixture"), "ok");
  await assert.rejects(
    withTimeout(new Promise<never>(() => {}), 0, "fixture operation"),
    /fixture operation timed out after 0ms/,
  );
});

test("deadline helper preserves an operation failure", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error("original failure")), 100, "fixture"),
    /original failure/,
  );
});

class FakeChannel implements RealtimeChannel {
  readonly events: Record<string, unknown>[] = [];
  send(event: Record<string, unknown>): void { this.events.push(event); }
}

test("uses Gateway Talk authentication by default", async () => {
  const gateway = new FakeGateway();
  const cockpit = new CockpitController(gateway);
  const launch = await cockpit.createVoiceSession("agent:main:test");

  assert.equal(launch.authMode, "gateway-talk");
  assert.deepEqual(gateway.requests.map((request) => request.method), ["talk.catalog", "talk.client.create"]);
  assert.equal(cockpit.state.transport, "gateway-talk");
  assert.equal(JSON.stringify(cockpit.state).includes(launch.clientSecret), false);
});

test("Gateway Talk forwards explicit route preferences", async () => {
  const gateway = new FakeGateway();
  const cockpit = new CockpitController(gateway);
  const launch = await cockpit.createVoiceSession("agent:main:test", {
    model: "gpt-realtime-2.1",
    voice: "marin",
  });
  assert.equal(launch.clientSecret, "ephemeral-test-only");
  assert.equal(launch.authMode, "gateway-talk");
  assert.deepEqual(gateway.requests.map((request) => request.method), ["talk.catalog", "talk.client.create"]);
  assert.equal(gateway.requests[1]?.params.voice, "marin");
  assert.equal(gateway.requests[1]?.params.model, "gpt-realtime-2.1");
  assert.equal(cockpit.state.transport, "gateway-talk");
});

test("Gateway Talk retries proven server defaults when a preferred voice is rejected", async () => {
  class RejectingGateway extends FakeGateway {
    override async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (method === "talk.client.create" && params.voice) {
        this.requests.push({ method, params });
        throw new Error("voice not supported");
      }
      return super.request<T>(method, params);
    }
  }
  const gateway = new RejectingGateway();
  const cockpit = new CockpitController(gateway);
  const launch = await cockpit.createVoiceSession("agent:main:test", {
    model: "gpt-realtime-2.1",
    voice: "preferred-female-voice",
  });
  assert.equal(launch.voice, "marin");
  assert.deepEqual(gateway.requests.map((request) => [request.method, request.params.voice ?? null]), [
    ["talk.catalog", null],
    ["talk.client.create", "preferred-female-voice"],
    ["talk.client.create", null],
  ]);
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
  });
});

test("sanitized projection exposes only bounded shell-safe state", () => {
  const now = new Date("2026-08-05T02:00:00.000Z");
  assert.deepEqual(initialProjection(now), {
    schemaVersion: 1,
    phase: "idle",
    transport: null,
    model: null,
    voice: null,
    error: null,
    connectedAt: null,
    listeningAt: null,
    browserConnected: false,
    updatedAt: now.toISOString(),
  });
  const projected = sanitizeProjection({
    phase: "listening",
    transport: "gateway-talk",
    model: "gpt-live\nmodel",
    voice: "ember",
    error: `bad\u0000${"x".repeat(400)}`,
    connectedAt: "2026-08-05T01:59:00Z",
    listeningAt: "not-a-date",
    clientSecret: "must-not-project",
    sessionKey: "must-not-project",
  }, true, now);
  assert.equal(projected.model, "gpt-live model");
  assert.equal(projected.error?.length, 240);
  assert.equal(projected.connectedAt, "2026-08-05T01:59:00.000Z");
  assert.equal(projected.listeningAt, null);
  assert.equal(projected.browserConnected, true);
  assert.equal("clientSecret" in projected, false);
  assert.equal("sessionKey" in projected, false);
});

test("audio frames round-trip the 40 ms header contract", () => {
  const samples = new Float32Array(FRAME_SAMPLES);
  for (let index = 0; index < FRAME_SAMPLES; index += 1) {
    samples[index] = Math.sin(index / 32) * 0.5;
  }
  const frame = encodeAudioFrame(samples, { seq: 7, id: 9, flags: FLAG_UTTERANCE_START });

  assert.equal(frame.byteLength, FRAME_BYTES);
  assert.deepEqual(decodeAudioFrameHeader(frame), {
    version: 1,
    flags: FLAG_UTTERANCE_START,
    sampleRate: SAMPLE_RATE,
    seq: 7,
    id: 9,
  });
  assert.deepEqual(decodeAudioFrameSamples(frame), samples);
  assert.equal(FRAME_SAMPLES / SAMPLE_RATE, 0.04);
  assert.equal(FRAME_SAMPLES % 128, 0);
});

test("malformed audio frames are rejected rather than relayed", () => {
  const samples = new Float32Array(FRAME_SAMPLES);
  assert.equal(isValidAudioFrame(encodeAudioFrame(samples, { seq: 1, id: 1 })), true);
  assert.equal(isValidAudioFrame(new ArrayBuffer(8)), false);
  assert.equal(isValidAudioFrame(new ArrayBuffer(FRAME_BYTES - 4)), false);

  const wrongVersion = encodeAudioFrame(samples, { seq: 1, id: 1 });
  new DataView(wrongVersion).setUint8(0, 2);
  assert.equal(isValidAudioFrame(wrongVersion), false);

  const wrongRate = encodeAudioFrame(samples, { seq: 1, id: 1 });
  new DataView(wrongRate).setUint32(4, 44_100, true);
  assert.equal(isValidAudioFrame(wrongRate), false);

  assert.throws(() => encodeAudioFrame(new Float32Array(128), { seq: 1, id: 1 }), /exactly 1920/);
});

async function markersFor(
  events: Array<Record<string, unknown>>,
  after?: (bridge: RealtimeEventBridge) => void,
): Promise<TurnMarker[]> {
  const markers: TurnMarker[] = [];
  const cockpit = new CockpitController(new FakeGateway());
  const bridge = new RealtimeEventBridge(cockpit, new FakeChannel(), (marker) => markers.push(marker));
  await cockpit.createVoiceSession("agent:main:test");
  for (const event of events) await bridge.handle(event);
  after?.(bridge);
  return markers;
}

test("turn markers track one clean listen-then-speak exchange", async () => {
  const markers = await markersFor([
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.speech_stopped" },
    { type: "response.created" },
    { type: "response.output_audio.delta", delta: "aa" },
    { type: "response.output_audio.delta", delta: "bb" },
    { type: "response.done" },
  ]);

  assert.deepEqual(markers.map((marker) => marker.type), [
    "listen.start",
    "listen.stop",
    "speak.start",
    "speak.end",
  ]);
  // Ids are monotonic across markers, and an utterance closes under the id it opened
  // with so a consumer can match end to start.
  assert.deepEqual(markers.map((marker) => marker.id), [1, 2, 3, 3]);
});

test("barge-in cancels the open utterance before the new listen turn", async () => {
  const markers = await markersFor([
    { type: "response.output_audio.delta", delta: "aa" },
    { type: "input_audio_buffer.speech_started" },
    { type: "response.cancelled" },
  ]);

  assert.deepEqual(markers.map((marker) => marker.type), [
    "speak.start",
    "speak.cancel",
    "listen.start",
  ]);
  assert.equal(markers[0]?.id, markers[1]?.id);
  // response.cancelled arrives after the utterance is already closed and must not
  // produce a second cancel for the same utterance.
  assert.equal(markers.filter((marker) => marker.type === "speak.cancel").length, 1);
});

test("a transcript-only response never opens an utterance", async () => {
  const markers = await markersFor([
    { type: "response.created" },
    { type: "response.output_audio_transcript.delta", delta: "text only" },
    { type: "response.done" },
  ]);

  assert.deepEqual(markers, []);
});

test("WebRTC playback boundaries keep response.done from clipping the media tail", async () => {
  const markers = await markersFor([
    { type: "output_audio_buffer.started" },
    { type: "response.done" },
    { type: "output_audio_buffer.stopped" },
  ]);
  assert.deepEqual(markers.map(({ type, id }) => ({ type, id })), [
    { type: "speak.start", id: 1 },
    { type: "speak.end", id: 1 },
  ]);
});

test("a cleared WebRTC playback buffer cancels the open utterance", async () => {
  const markers = await markersFor([
    { type: "output_audio_buffer.started" },
    { type: "output_audio_buffer.cleared" },
    { type: "output_audio_buffer.stopped" },
  ]);
  assert.deepEqual(markers.map(({ type, id }) => ({ type, id })), [
    { type: "speak.start", id: 1 },
    { type: "speak.cancel", id: 1 },
  ]);
});

test("stopping mid-utterance closes it instead of stranding the consumer", async () => {
  const markers = await markersFor(
    [{ type: "response.output_audio.delta", delta: "aa" }],
    (bridge) => bridge.stop(),
  );

  assert.deepEqual(markers.map((marker) => marker.type), ["speak.start", "speak.cancel"]);
  assert.equal(markers[0]?.id, markers[1]?.id);
});
