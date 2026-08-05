# Linux Voice Cockpit

Linux-first realtime voice cockpit for OpenClaw. The initial implementation is a typed,
headless control plane for ChatGPT Codex GPT Live plus OpenClaw agent consult/control.

## Current slice

- discovers and refreshes OpenClaw's OpenAI OAuth profile server-side;
- admits GPT Live through ChatGPT's Codex realtime endpoint with the selected account ID;
- connects browser/Tauri WebRTC without exposing OAuth or Gateway credentials;
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

The service accepts only same-origin WebSocket clients, only the required control methods,
and only `COCKPIT_SESSION_KEY` (default: this project's canonical session). The browser
receives only SDP/session material, never the Gateway token or provider OAuth material.

Gateway Talk/API-key mode is disabled unless explicitly enabled as fallback/test coverage.
ChatGPT subscription billing remains **unproven until the live endpoint and account-side
evidence pass**; see `docs/live-linux-canary.md`.

Linux-first realtime voice and session-control client for OpenClaw.

Project context: `/home/matthew/.openclaw/projects/linux-voice-cockpit/context.md`

## Documentation

- [Clean-room product requirements](docs/clean-room-product-requirements.md)
- [GPT Live in a third-party OpenClaw app](docs/gpt-live-third-party-integration.md)
- [Agentic Desktop and mobile integration plan](docs/agentic-desktop-mobile-integration-plan.md)
