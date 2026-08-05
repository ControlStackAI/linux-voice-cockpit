# Linux Voice Cockpit

Linux-first realtime voice cockpit for OpenClaw. The initial implementation is a typed,
headless control plane for the supported OpenClaw Talk + OpenAI Realtime WebRTC path.

## Current slice

- discovers Realtime readiness through `talk.catalog`;
- mints ephemeral sessions with `talk.client.create`;
- connects browser/Tauri WebRTC without exposing a durable OpenAI key;
- bridges `openclaw_agent_consult` and `openclaw_agent_control` tool calls;
- publishes a redacted state model suitable for desktop and phone clients;
- closes microphone, data-channel, peer, and in-memory session state explicitly.
- runs a loopback-only canary service with an allowlisted Gateway RPC proxy.

```bash
npm install
npm test
```

To run the Linux microphone canary, load only the Gateway credential into the service:

```bash
OPENCLAW_GATEWAY_TOKEN='...' npm run canary
# open http://127.0.0.1:4280 and click Start microphone
```

The service accepts only same-origin WebSocket clients, only the four required Talk RPCs,
and only `COCKPIT_SESSION_KEY` (default: this project's canonical session). The browser
receives the ephemeral Realtime secret, never the Gateway token or durable provider auth.

The current host's Talk path is still API-key-backed because its declarative config and
Gateway environment provide `OPENAI_API_KEY`. ChatGPT/Codex OAuth subscription billing is
therefore **not proven**; see `docs/live-linux-canary.md`.

Linux-first realtime voice and session-control client for OpenClaw.

Project context: `/home/matthew/.openclaw/projects/linux-voice-cockpit/context.md`

## Documentation

- [Clean-room product requirements](docs/clean-room-product-requirements.md)
- [GPT Live in a third-party OpenClaw app](docs/gpt-live-third-party-integration.md)
- [Agentic Desktop and mobile integration plan](docs/agentic-desktop-mobile-integration-plan.md)
