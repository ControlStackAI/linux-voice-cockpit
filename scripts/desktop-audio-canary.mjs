#!/usr/bin/env node
/**
 * Live canary for the loopback `/desktop/audio` tap.
 *
 * Unit tests cover the wire format and the turn-marker state machine. This exercises what
 * they cannot: the shared upgrade router, the Origin policy an out-of-browser consumer
 * actually hits, and the ordering guarantee that motivated putting audio and markers on
 * one socket.
 *
 * Usage: node scripts/desktop-audio-canary.mjs [port]
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";
import {
  FRAME_SAMPLES,
  encodeAudioFrame,
} from "../dist/src/desktop-audio-protocol.js";

const port = Number(process.argv[2] ?? 4283);
const origin = `http://127.0.0.1:${port}`;
const checks = [];

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function collect(socket) {
  const received = [];
  socket.on("error", (error) => process.stderr.write(`[socket] ${error.message}\n`));
  socket.on("message", (data, isBinary) => {
    received.push(isBinary ? { binary: true, bytes: data.length } : JSON.parse(String(data)));
  });
  return received;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

const service = spawn(process.execPath, ["dist/src/canary-server.js"], {
  env: { ...process.env, COCKPIT_PORT: String(port), COCKPIT_ALLOW_API_KEY_FALLBACK: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
service.stderr.on("data", (chunk) => process.stderr.write(`[service] ${chunk}`));

try {
  await Promise.race([
    once(service.stdout, "data"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("service did not start")), 10_000)),
  ]);

  // A foreign Origin must be refused even on loopback.
  const foreign = new WebSocket(`ws://127.0.0.1:${port}/desktop/audio`, { origin: "http://evil.example" });
  const foreignOutcome = await new Promise((resolve) => {
    foreign.on("open", () => resolve("opened"));
    foreign.on("error", (error) => resolve(error.message));
  });
  check("foreign Origin is refused on /desktop/audio", /403/.test(String(foreignOutcome)), String(foreignOutcome));
  foreign.terminate();

  // Presence connects with the Node ws client, which sends no Origin header at all.
  const tap = new WebSocket(`ws://127.0.0.1:${port}/desktop/audio`);
  const fromTap = collect(tap);
  await once(tap, "open");
  await settle();
  const hello = fromTap[0];
  check(
    "absent Origin is accepted and greeted with hello",
    hello?.type === "hello" && hello.sampleRate === 48_000 && hello.frameSamples === FRAME_SAMPLES,
    JSON.stringify(hello),
  );

  const browser = new WebSocket(`ws://127.0.0.1:${port}/control`, { origin });
  const fromBrowser = collect(browser);
  await once(browser, "open");
  await settle();
  check(
    "the browser control socket still upgrades on the shared router",
    fromBrowser.some((frame) => frame.type === "ready"),
    JSON.stringify(fromBrowser[0] ?? null),
  );

  fromTap.length = 0;
  browser.send(JSON.stringify({ type: "state", state: { phase: "speaking", transport: "subscription" } }));
  await settle();
  check(
    "a cockpit phase change is published to the tap",
    fromTap.some((frame) => frame.type === "phase" && frame.phase === "speaking"),
    JSON.stringify(fromTap),
  );

  // The ordering guarantee: speak.end must land after the final audio frame.
  fromTap.length = 0;
  const samples = new Float32Array(FRAME_SAMPLES).fill(0.25);
  browser.send(JSON.stringify({ type: "turn", marker: { type: "speak.start", id: 9, t: Date.now() } }));
  for (let seq = 1; seq <= 3; seq += 1) {
    browser.send(encodeAudioFrame(samples, { seq, id: 9, flags: seq === 1 ? 1 : 0 }));
  }
  browser.send(JSON.stringify({ type: "turn", marker: { type: "speak.end", id: 9, t: Date.now() } }));
  await settle();
  const shape = fromTap.map((frame) => (frame.binary ? `audio:${frame.bytes}` : frame.type));
  check(
    "audio and markers arrive interleaved in publish order",
    JSON.stringify(shape) === JSON.stringify(["speak.start", "audio:7696", "audio:7696", "audio:7696", "speak.end"]),
    shape.join(" → "),
  );

  fromTap.length = 0;
  browser.send(Buffer.alloc(64));
  browser.send(JSON.stringify({ type: "turn", marker: { type: "not.a.marker", id: 1 } }));
  await settle();
  check("malformed audio and unknown markers are dropped", fromTap.length === 0, JSON.stringify(fromTap));

  const state = await fetch(`http://127.0.0.1:${port}/desktop/state`).then((response) => response.json());
  check("the state projection still serves", state.phase === "speaking" && state.browserConnected === true, JSON.stringify(state));

  const worklet = await fetch(`http://127.0.0.1:${port}/audio-tap-worklet.js`);
  check(
    "the audio worklet module is served same-origin",
    worklet.status === 200 && (await worklet.text()).includes("registerProcessor(\"audio-tap\""),
    `HTTP ${worklet.status}`,
  );

  // A page that dies mid-utterance must not leave a consumer waiting forever.
  fromTap.length = 0;
  browser.close();
  await settle();
  check(
    "a browser disconnect publishes a phase change",
    fromTap.some((frame) => frame.type === "phase"),
    JSON.stringify(fromTap),
  );

  tap.close();
} finally {
  service.kill("SIGTERM");
}

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
