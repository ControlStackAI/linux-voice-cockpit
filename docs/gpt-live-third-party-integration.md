# Realtime voice in a third-party OpenClaw app

## Supported authentication contract

Linux Voice Cockpit uses OpenClaw Gateway Talk as its only supported realtime
admission path. The cockpit service authenticates to the gateway; the gateway
owns provider credential resolution and returns a short-lived WebRTC launch.

The cockpit intentionally does not read OpenClaw's internal SQLite or JSON auth
stores. Those stores are implementation details and may contain encrypted,
fenced, or indirect values rather than reusable bearer tokens. Depending on
their schema or mutating refresh tokens outside OpenClaw is unsupported and is
not portable across installations.

```text
Browser -- same-origin control --> cockpit service -- Gateway protocol v4 --> OpenClaw
Browser <-- ephemeral launch ---- cockpit service <-- talk.client.create --- OpenClaw
Browser -- WebRTC media/events --------------------------------------------> provider
Browser -- toolCall / steer ------> cockpit service -----------------------> OpenClaw
```

The gateway token remains in the service. The browser receives only the
ephemeral client secret and launch metadata required for the WebRTC exchange.
The provider credential and its refresh lifecycle remain inside OpenClaw.

## Preconditions

- A compatible OpenClaw gateway with Realtime Talk configured.
- A server-side `OPENCLAW_GATEWAY_TOKEN` supplied through a protected
  environment or credential source.
- `talk.catalog` reports the OpenAI provider configured with WebRTC support.
- The browser origin can reach the provider launch URL returned by the gateway.
- Microphone permission for the intended device.

This prototype supports the gateway's shared-token backend-client flow. It
does not yet implement device pairing or an OS credential-store integration.
Remote deployment therefore requires additional authentication and origin
hardening; the included canary should remain loopback-only.

## Session bootstrap

The service first checks the provider catalog:

```ts
const catalog = await gateway.request("talk.catalog", {});
const openai = catalog.realtime?.providers?.find((provider) => provider.id === "openai");
if (!catalog.realtime?.ready || !openai?.configured) {
  throw new Error("OpenAI Realtime is not ready on this Gateway");
}
if (!openai.transports?.includes("webrtc")) {
  throw new Error("This Gateway does not advertise OpenAI WebRTC Talk");
}
```

It then requests a client-owned session:

```ts
const launch = await gateway.request("talk.client.create", {
  sessionKey,
  provider: "openai",
  mode: "realtime",
  transport: "webrtc",
  brain: "agent-consult",
  model,
  voice,
});
```

Caller model and voice values are preferences. If a preferred voice is
rejected, the cockpit retries once without caller overrides so the gateway can
apply its configured defaults.

The returned `clientSecret` is sensitive and single-purpose. Keep it in memory,
never log or persist it, and discard it when the transport closes.

## WebRTC lifecycle

The browser:

1. obtains microphone media;
2. creates a peer connection and `oai-events` data channel;
3. creates and installs the local SDP offer;
4. posts the unmodified SDP to the launch URL with the ephemeral secret;
5. installs the remote SDP answer; and
6. waits for `RTCPeerConnection.connectionState === "connected"`.

Each stage has a bounded deadline. Timeout or failure closes the data channel,
peer, and microphone tracks and projects an explicit error. This prevents a
browser-specific `createOffer` or connection stall from leaving the cockpit in
`connecting` forever.

## Agent consult bridge

Realtime `openclaw_agent_consult` calls are forwarded through
`talk.client.toolCall` with the selected `sessionKey`. The bridge correlates the
accepted OpenClaw run with gateway chat events and returns only the final tool
result through the Realtime data channel. Steering and cancellation use
`talk.client.steer` against the same session.

The local proxy allowlists only:

- `talk.catalog`
- `talk.client.create`
- `talk.client.toolCall`
- `talk.client.steer`

It rejects other gateway methods and session keys. Logs contain request ids,
method names, outcomes, and elapsed time, but no SDP, launch payload, model
output, tokens, or provider error bodies.

## Qualification boundary

Unit tests and synthetic fixtures do not make provider calls and do not prove
live endpoint compatibility, account authorization, audio quality, or billing.
Use the separate live canary procedure and record versioned, redacted evidence
before making any live-acceptance claim.
