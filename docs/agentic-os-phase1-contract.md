# Agentic OS Phase 1 Transport Contract

Linux Voice Cockpit remains the microphone/WebRTC owner. OpenClaw remains the identity,
session, tools, and policy plane. Quickshell receives only sanitized state and narrow
start/stop controls; it never receives Gateway, OAuth, or provider credentials.

## State projection

The service publishes the same JSON document at:

- Atomic runtime file: `$COCKPIT_STATE_PATH`, default
  `$XDG_RUNTIME_DIR/linux-voice-cockpit.json`.
- Loopback HTTP: `GET http://127.0.0.1:4280/desktop/state`.

```json
{
  "schemaVersion": 1,
  "phase": "idle|connecting|listening|thinking|speaking|error",
  "transport": "subscription|api|null",
  "model": "string|null",
  "voice": "string|null",
  "error": "string|null",
  "connectedAt": "ISO-8601|null",
  "listeningAt": "ISO-8601|null",
  "browserConnected": true,
  "updatedAt": "ISO-8601"
}
```

The service allowlists fields, bounds strings to 240 characters, strips control characters,
validates timestamps, and never projects session keys, run identifiers, tokens, setup URLs,
SDP, or credentials. The runtime file is mode `0600` and replaced atomically.

## Desktop control

Quickshell sends:

```http
POST /desktop/control
Content-Type: application/json

{"action":"start"}
```

or:

```json
{"action":"stop"}
```

Success is `202 {"accepted":true,"action":"start|stop"}`. The service returns `409`
when no browser microphone owner is connected. Requests must originate from loopback, must
use `application/json`, and must have no web `Origin` header or the cockpit's exact same
origin. There is no CORS opt-in, so another web origin cannot use this endpoint to activate
the microphone.

The service relays the accepted action over the existing same-origin WebSocket. The browser
still calls `getUserMedia`, owns microphone tracks, displays permission/errors, and performs
teardown. QML never handles media or credentials.

## Declarative route preferences

| Environment variable | Proven fallback |
|---|---|
| `COCKPIT_SUBSCRIPTION_MODEL` | `gpt-live-1-boulder-alpha` |
| `COCKPIT_SUBSCRIPTION_VOICE` | `ember` |
| `COCKPIT_API_MODEL` | `gpt-realtime-2.1` |
| `COCKPIT_API_VOICE` | Gateway-selected default, currently `marin` |

Subscription admission retries the proven model/voice only when a configured alternative is
rejected with HTTP 400. Gateway Talk retries without the requested voice when the Gateway
rejects the preference, preserving its proven server-selected default. The state projection
reports the route actually accepted, not merely the requested preference.

