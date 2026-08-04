# GPT Live in a Third-Party OpenClaw App

Status: implementation research for CON-197  
Verified: 2026-08-04 against OpenClaw `v2026.7.1-2` (`0790d9f`)  
Target: Linux Voice Cockpit and other trusted third-party OpenClaw clients

## Bottom line

Do not obtain a ChatGPT/Codex OAuth token in the third-party app and do not copy one out
of OpenClaw's credential store. Connect the app to the OpenClaw Gateway and use its Talk
RPC contract:

1. Authenticate and pair the app as an OpenClaw Gateway device.
2. Read `talk.catalog` and require a ready OpenAI realtime provider.
3. Call `talk.client.create` for the target OpenClaw `sessionKey`.
4. Receive a short-lived OpenAI Realtime client secret from the Gateway.
5. Use that secret once to establish a direct WebRTC session with OpenAI.
6. Forward the Realtime model's `openclaw_agent_consult` tool calls to
   `talk.client.toolCall`, then return the result through the WebRTC data channel.
7. Use `talk.client.steer` to steer or cancel an active OpenClaw consult.

This is the supported third-party boundary already used by OpenClaw's browser and iOS
Talk clients. It gives the client low-latency provider audio without exposing the
Gateway's durable API key or Codex OAuth bearer.

## What “GPT Live” means here

Three related paths are easy to conflate:

- **OpenAI Realtime API:** the public, supported speech-to-speech API. In OpenClaw
  `v2026.7.1-2`, the configured default on this host is `gpt-realtime-2.1` over
  client-owned WebRTC. This is the production path Linux Voice Cockpit should build.
- **OpenClaw Talk with agent consult:** OpenAI Realtime handles the live audio loop and
  can call `openclaw_agent_consult`. The Gateway executes that consult through the
  selected OpenClaw session, including its tools and policy, and the Realtime model
  speaks the returned result.
- **Codex GPT-Live / Frameless Bidi:** a separate Codex-owned conversation surface with
  private model identifiers and admission. Voice.Claw's published research recorded
  `Voice session access denied` or unavailable routes for its V3 tests. It must remain
  capability-gated and must not be presented as the working public Realtime path.

Codex-OAuth GPT Live is also not a general OpenClaw tool surface. The production
architecture below is the tool-capable route.

## Reference architecture

```text
Linux Voice Cockpit
  |  authenticated Gateway WebSocket
  |  talk.catalog / talk.client.create / talk.client.toolCall / talk.client.steer
  v
OpenClaw Gateway
  |  resolves provider credential (API key or Codex OAuth)
  |  mints short-lived Realtime client secret
  |  runs agent consults in the requested OpenClaw session
  v
OpenAI Realtime API <------ WebRTC audio + oai-events data channel ------ Cockpit
```

The media plane is client-to-OpenAI WebRTC. The control and tool plane is an
authenticated connection to OpenClaw. A remote phone can reach the Gateway through
Tailscale, but the ephemeral OpenAI session still connects directly from the phone.

## Preconditions

### Gateway configuration

The Gateway must have a usable OpenAI realtime provider. A minimal shape is:

```json
{
  "talk": {
    "realtime": {
      "provider": "openai",
      "model": "gpt-realtime-2.1",
      "mode": "realtime",
      "transport": "webrtc",
      "brain": "agent-consult",
      "consultRouting": "provider-direct"
    }
  }
}
```

OpenClaw can resolve the provider credential from a configured OpenAI API-key source or
from an OpenAI/Codex OAuth profile. The third-party app should not know which source was
used. `provider-direct` is intentional for the GPT-Live-style experience: the Realtime
provider answers ordinary conversation directly and calls OpenClaw only when it needs an
agent/tool consult. `force-agent-consult` sends every finalized utterance through the
agent and changes both latency and cost.

The app must treat the Gateway's configured prompt, tools, provider, and security policy
as authoritative. `talk.client.create` deliberately does not accept caller-supplied
instructions.

### Gateway authentication

Use OpenClaw's device pairing and device-token flow, preferably through the published
`@openclaw/gateway-client` package rather than a hand-written WebSocket protocol. The
connection needs `operator.write` for `talk.client.create`, `talk.client.toolCall`, and
steering. Do not ship the Gateway's master token or a provider credential inside the app.

For a remote client:

- use `wss://` through an authenticated private path such as Tailscale;
- pin the paired OpenClaw device identity to the cockpit instance;
- store the resulting device credential in the OS credential store;
- make device revocation visible from both sides.

## Session bootstrap

First discover the runtime instead of hard-coding provider capabilities:

```ts
const catalog = await gateway.request("talk.catalog", {});
const openai = catalog.realtime?.providers?.find((p) => p.id === "openai");

if (!catalog.realtime?.ready || !openai?.configured) {
  throw new Error("OpenAI realtime Talk is not ready on this Gateway");
}
if (!openai.transports?.includes("webrtc")) {
  throw new Error("This Gateway does not advertise OpenAI WebRTC Talk");
}
```

Then create the client-owned session:

```ts
const launch = await gateway.request("talk.client.create", {
  sessionKey: "agent:main:project:linux-voice-cockpit",
  provider: "openai",
  mode: "realtime",
  transport: "webrtc",
  brain: "agent-consult"
});

if (launch.transport !== "webrtc") {
  throw new Error(`Unexpected Talk transport: ${launch.transport}`);
}
```

The WebRTC result contract is:

```ts
type TalkWebRtcLaunch = {
  provider: string;
  transport: "webrtc";
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  model?: string;
  voice?: string;
  expiresAt?: number;
};
```

The Gateway has already bound the model instructions, voice configuration, VAD settings,
and allowed tools into the ephemeral session. Treat `clientSecret` as sensitive and
single-purpose: keep it in memory, never log or persist it, and discard it immediately
after the SDP exchange.

## WebRTC handshake

The browser/Tauri webview flow is standard OpenAI WebRTC:

```ts
const pc = new RTCPeerConnection();
const remoteAudio = new Audio();
remoteAudio.autoplay = true;
pc.ontrack = (event) => { remoteAudio.srcObject = event.streams[0]; };

const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);

const events = pc.createDataChannel("oai-events");
events.onmessage = (message) => handleRealtimeEvent(JSON.parse(message.data));

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const response = await fetch(
  launch.offerUrl ?? "https://api.openai.com/v1/realtime/calls",
  {
    method: "POST",
    body: offer.sdp,
    headers: {
      ...launch.offerHeaders,
      Authorization: `Bearer ${launch.clientSecret}`,
      "Content-Type": "application/sdp"
    }
  }
);
if (!response.ok) throw new Error(`Realtime SDP failed: ${response.status}`);

await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
```

Preserve SDP bytes exactly. Voice.Claw's published interoperability notes found that
removing the terminal CRLF caused OpenAI to reject an otherwise valid offer.

## Agent consult bridge

The Realtime session includes an `openclaw_agent_consult` function tool. Accumulate
`response.function_call_arguments.delta` events and act when
`response.function_call_arguments.done` arrives:

```ts
const accepted = await gateway.request("talk.client.toolCall", {
  sessionKey,
  name: "openclaw_agent_consult",
  callId,
  args: JSON.parse(argumentsJson)
});
```

The RPC first acknowledges the embedded OpenClaw run. Consume the corresponding Gateway
events until its final result is available, then send the tool output back to Realtime:

```ts
events.send(JSON.stringify({
  type: "conversation.item.create",
  item: {
    type: "function_call_output",
    call_id: callId,
    output: JSON.stringify(finalConsultResult)
  }
}));
events.send(JSON.stringify({ type: "response.create" }));
```

Correlate at least these identifiers in memory and telemetry: Gateway connection,
OpenClaw `sessionKey`, Realtime session, Realtime `item_id`, tool `call_id`, OpenClaw
`runId`, and `idempotencyKey`. Redact the utterance and tool result from default logs.

While a consult is running, pass user steering through:

```ts
await gateway.request("talk.client.steer", {
  sessionKey,
  text: transcript,
  mode: "auto"
});
```

The Gateway classifies or applies status, steering, cancellation, and follow-up behavior
against the active run. Only the Gateway connection that owns the browser Talk run may
steer it.

## Lifecycle and recovery

- Stop microphone tracks, close the data channel, close the peer connection, and discard
  the ephemeral secret when the user ends Talk.
- If SDP creation fails because the secret expired, request a new session with
  `talk.client.create`; never retry with a persisted secret.
- If the provider connection dies, surface the loss. Do not silently relabel a
  Gateway-relay or Codex V2 fallback as GPT Live.
- A new voice session may resume the same OpenClaw `sessionKey`, but it is a new provider
  conversation unless explicit provider state migration is implemented.
- Use `talk.event` for unified transcript and session telemetry when the client needs it;
  do not scrape OpenClaw session files.

## Security rules

- Durable OpenAI keys, ChatGPT/Codex OAuth access tokens, and refresh tokens stay on the
  Gateway. Never put them in setup QR codes or mobile storage.
- A Realtime `clientSecret` is still a bearer credential. Keep it in memory only and bind
  its minting to an authenticated, authorized device request.
- Do not expose an unauthenticated “mint token” HTTP endpoint through Tailscale or a public
  tunnel. Tailnet membership is transport security, not app authorization.
- Keep consequential tool execution behind normal OpenClaw policy. Voice-originated
  outbound messages, node control, destructive shell actions, and publication require
  fresh spoken confirmation.
- Do not let the client override the provider prompt or tool schema. That would turn a
  voice client into a policy-injection surface.
- Close or rotate long-lived sessions deliberately. Realtime API billing continues while
  a live session remains open, including an idle Talk tab.

## Voice.Claw comparison and clean-room conclusion

Voice.Claw's public materials describe the same high-level split: realtime conversation
stays on the live provider, while local-file or agent work routes through a companion
bridge. Its source-visible implementation also mints an ephemeral Realtime secret and
keeps a separate Codex/GPT-Live experiment. Those are interoperability observations only;
the repository had no declared license when reviewed, and no Voice.Claw code, schemas,
tests, or UI text are incorporated here.

Linux Voice Cockpit should implement OpenClaw's documented Talk RPC and OpenAI's public
WebRTC protocol independently. That route is already live on this host: `talk.catalog`
reports OpenAI ready, `gpt-realtime-2.1`, WebRTC support, barge-in, and tool calls.

## Verification plan

1. Connect a paired test client and confirm `talk.catalog` advertises OpenAI WebRTC.
2. Call `talk.client.create`; assert the result contains an ephemeral secret but no durable
   API key or OAuth token.
3. Complete SDP exchange and verify microphone audio, output audio, final user transcript,
   assistant transcript, and barge-in.
4. Trigger `openclaw_agent_consult`; verify the exact selected `sessionKey` receives the
   turn and the result returns through `function_call_output`.
5. Steer and cancel a long consult from speech; verify ownership enforcement.
6. Revoke the paired device and prove it can no longer mint a session.
7. Expire or invalidate a client secret and verify clean re-minting without secret logs.
8. Inspect network traffic: Gateway control stays on the private authenticated path and
   WebRTC goes only to the advertised OpenAI endpoint.
9. Measure first-audio latency, interruption latency, idle billing behavior, and recovery
   across Wi-Fi/Tailscale transitions.

## Sources

- [OpenAI Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
  — official ephemeral-secret and SDP flow.
- [OpenAI voice agents](https://developers.openai.com/api/docs/guides/voice-agents)
  — official live-audio session architecture.
- [OpenClaw Talk mode at v2026.7.1-2](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/docs/nodes/talk.md)
  — supported client/Gateway methods and transports.
- [OpenClaw Talk client handler at v2026.7.1-2](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/src/gateway/server-methods/talk-client.ts)
  — authoritative `talk.client.create`, tool-call, and steering behavior.
- [OpenClaw OpenAI realtime provider at v2026.7.1-2](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/extensions/openai/realtime-voice-provider.ts)
  — ephemeral-session minting and returned WebRTC contract.
- [VoiceClaw Realtime Companion README](https://github.com/bdjben/Voice.Claw-Companion/blob/main/README.md)
  and [Codex Realtime integration notes](https://github.com/bdjben/Voice.Claw-Companion/blob/main/docs/CODEX_REALTIME_INTEGRATION.md)
  — unlicensed reference-only product and interoperability observations.
