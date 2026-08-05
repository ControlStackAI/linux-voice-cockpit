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

```bash
npm install
npm test
```

The concrete Gateway transport/device-pairing adapter and live microphone canary are the
next implementation step. Architecture and security context live under `docs/`.

Linux-first realtime voice and session-control client for OpenClaw.

Project context: `/home/matthew/.openclaw/projects/linux-voice-cockpit/context.md`

## Documentation

- [Clean-room product requirements](docs/clean-room-product-requirements.md)
- [GPT Live in a third-party OpenClaw app](docs/gpt-live-third-party-integration.md)
- [Agentic Desktop and mobile integration plan](docs/agentic-desktop-mobile-integration-plan.md)
