# Live Linux microphone canary

## Supported boundary

The canary supports one authentication and admission path:

1. The local Node service connects to an OpenClaw gateway with
   `OPENCLAW_GATEWAY_TOKEN`.
2. It verifies `talk.catalog` and requests an ephemeral WebRTC launch through
   `talk.client.create`.
3. The browser sends its SDP offer to the launch URL with the ephemeral client
   secret.
4. Realtime consult and steering requests return through the service's
   allowlisted Gateway proxy.

Provider authentication remains inside OpenClaw. The cockpit does not open,
parse, or update OpenClaw auth stores. It never receives durable provider
access tokens, refresh tokens, or API keys. The gateway token remains in the
Node service and is not sent to browser code.

The gateway's provider configuration determines which provider credential and
billing route are used. A successful session does not by itself prove a
particular billing route.

## Local verification boundary

The automated suite uses synthetic gateway and timeout fixtures. It verifies
request shape, state projection, lifecycle cleanup, tool bridging, and bounded
timeouts without creating a provider session or invoking a model.

Historical backend-only canary evidence against OpenClaw `v2026.7.1-2`
covered the protocol v4 handshake, `talk.catalog`, and `talk.client.create`.
That evidence did not exercise browser microphone capture, SDP exchange,
remote audio, or a model response. It is not current live acceptance.

## Run locally

Use a current Node.js/npm toolchain, a compatible OpenClaw gateway with
Realtime Talk configured, and a browser with microphone access.

```sh
npm ci
npm run check
npm test
OPENCLAW_GATEWAY_TOKEN='...' npm run canary
```

Supply the token through a protected environment or service credential source;
do not commit it or pass it to browser JavaScript.

| Variable | Purpose |
| --- | --- |
| `OPENCLAW_GATEWAY_TOKEN` | Required server-side gateway credential |
| `OPENCLAW_GATEWAY_URL` | Gateway WebSocket URL; defaults to `ws://127.0.0.1:18789` |
| `COCKPIT_SESSION_KEY` | OpenClaw session admitted by the narrow proxy |
| `COCKPIT_REALTIME_MODEL` | Optional model preference for `talk.client.create` |
| `COCKPIT_REALTIME_VOICE` | Optional voice preference for `talk.client.create` |
| `COCKPIT_HOST` | Loopback listener host; keep `127.0.0.1` for the canary |
| `COCKPIT_PORT` | Listener port; defaults to `4280` |
| `COCKPIT_STATE_PATH` | Optional redacted state-projection path |

The browser and local-control request paths use 15-second deadlines. A stalled
gateway request, microphone prompt, SDP offer, SDP exchange, remote
description, or peer connection transitions to an explicit error instead of
leaving the UI indefinitely in `connecting`. The service logs request id,
allowlisted method, outcome, and elapsed time; it does not log request or
response payloads.

## Interactive acceptance procedure

1. Open `http://127.0.0.1:4280` on the same machine.
2. Select **Start microphone** and approve the intended device.
3. Verify that the state reaches `listening` within the configured deadline.
4. Ask a normal question and verify audible output and barge-in.
5. Ask the voice model to consult OpenClaw on a bounded question.
6. While the consult runs, exercise steering and cancellation.
7. Select **Stop and tear down** and verify the microphone indicator, peer,
   data channel, audio tap, and session state all close.
8. Inspect browser state and network requests for absence of the gateway token
   and durable provider credentials.

Record the OpenClaw version, browser version, operating system, result, and
redacted network evidence. Do not call the canary accepted until all steps are
observed. Automated tests and backend-only fixtures are not substitutes.
