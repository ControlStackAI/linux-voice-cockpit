# Live Linux microphone canary

## Implemented slice

The canary is split across the intended production boundary:

- `GatewayWebSocketClient` opens OpenClaw protocol v4 over loopback as a backend client.
- `canary-server` keeps `OPENCLAW_GATEWAY_TOKEN` in the Node service and exposes a narrow,
  same-origin local proxy for `talk.catalog`, `talk.client.create`,
  `talk.client.toolCall`, and `talk.client.steer`.
- `browser-canary` owns microphone permission, WebRTC negotiation, remote audio, Realtime
  events, consult/control tool calls, and deterministic teardown.
- The proxy rejects other Gateway methods and any `sessionKey` except
  `COCKPIT_SESSION_KEY`.

## Verified on OpenClaw v2026.7.1-2

On 2026-08-04, the live loopback service completed:

1. Gateway protocol v4 challenge/response and authenticated backend connection.
2. `talk.catalog`, confirming OpenAI Realtime ready with WebRTC and agent consult.
3. `talk.client.create`, returning `provider=openai`, `transport=webrtc`,
   `model=gpt-realtime-2.1`, `voice=marin`, and a non-empty ephemeral client secret.
4. Response-field inspection showing no durable API-key, OAuth-token, or Gateway-token
   fields in the browser launch payload.

The in-app browser was unavailable in the implementing session. Real microphone capture,
SDP exchange, output audio, consult, steering, cancellation, and teardown must still be
run interactively before this milestone is called complete.

The browser availability check was repeated after the 2026-08-04 Gateway restart and again
returned no controllable browser instance. This is an environment/test-harness blocker, not a
passing or failing result for the cockpit client.

## Credential and billing finding

OpenAI's public WebRTC documentation describes the supported third-party flow as a backend
minting the ephemeral client secret with a **standard OpenAI API key**. It does not document
ChatGPT/Codex OAuth or ChatGPT subscription billing for third-party Realtime sessions:
<https://developers.openai.com/api/docs/guides/realtime-webrtc#connecting-using-an-ephemeral-token>.

OpenClaw v2026.7.1-2 separately implements an OAuth/external-Codex fallback for Talk. That is
an OpenClaw capability, not public OpenAI documentation that Realtime usage is included in a
ChatGPT subscription. Keep these claims separate: an OAuth-only mint can prove the OpenClaw
fallback authenticates, but subscription billing is proven only by account-side usage evidence
attributable to the canary session.

OpenClaw v2026.7.1-2 resolves Realtime platform auth in this order:

1. `talk.realtime.providers.openai.apiKey`
2. configured OpenAI `api_key` auth profile
3. `OPENAI_API_KEY`
4. OpenAI OAuth profile or external Codex login

The live host at the time of the backend canary had both a Talk `apiKey` SecretRef targeting `OPENAI_API_KEY` and
`OPENAI_API_KEY` in the Gateway process environment. The successful session mint was
therefore Platform API-key-backed. It is not evidence that ChatGPT subscription billing
works for Realtime, and no documentation or UI should claim otherwise.

To test the OAuth fallback honestly, the declarative OpenClaw owner must remove the Talk
API-key override and prevent `OPENAI_API_KEY` from reaching the Gateway, while preserving a
valid OpenAI OAuth profile/external Codex login. If the key is required by other Gateway
features, v2026.7.1-2 needs credential isolation or an upstream explicit Talk auth selector.

After activation and restart, rerun `talk.catalog`, `talk.client.create`, and the full audio
canary. Billing is proven only with provider/account evidence attributable to that session;
a successful WebRTC connection alone proves authentication, not the billing bucket.

## Interactive acceptance procedure

```bash
npm install
npm test
OPENCLAW_GATEWAY_TOKEN='...' npm run canary
```

Open `http://127.0.0.1:4280` in the graphical session and:

1. Start the microphone and approve the intended device.
2. Ask a normal question; verify audible output and barge-in.
3. Ask the voice model to consult OpenClaw on a bounded repository question.
4. While the consult runs, send steering and then cancellation.
5. Click **Stop and tear down**; verify the microphone indicator disappears, output stops,
   the peer/data channel close, and cockpit state returns to `idle`.
6. Inspect the page/network state for absence of the Gateway token and durable provider
   credentials. Record the Realtime session/account evidence separately with secrets
   redacted.

## Declarative integration requirements

- Node.js 22 and the packaged `linux-voice-cockpit` build.
- Loopback HTTP/WebSocket listener on port 4280.
- `OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789`.
- `OPENCLAW_GATEWAY_TOKEN` supplied through a systemd credential or protected environment
  source; never embedded in the package or browser bundle.
- `COCKPIT_SESSION_KEY=agent:main:project:linux-voice-cockpit` for the demo.
- Outbound access from the graphical browser to `https://api.openai.com` and microphone
  permission for the intended PipeWire device.
- No Quickshell dependency in the cockpit package. Agentic Desktop should consume a later
  sanitized status/control API from its own pen-owned repository.
