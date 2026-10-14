# Linux Voice Cockpit

A typed, headless voice control plane connecting browser audio, realtime sessions, and OpenClaw agent tools.

**Status:** Prototype.

## Bridge voice and tools

Route realtime consult and control calls through the OpenClaw gateway.

## Keep credentials server-side

The canary service handles provider authentication and gateway credentials outside the browser.

## Observe session state

Consume a redacted state projection and explicitly close audio and transport resources.

## How it fits together

Microphone → WebRTC session → Tool bridge → OpenClaw agent.

## Current boundaries

A headless control plane and local microphone canary, not a packaged desktop or mobile app. Live endpoint compatibility and subscription billing require separate qualification.

## Get started

See the [README](../README.md) for prerequisites, setup, configuration, and development checks.

## Further reading

- [Live canary guide](../docs/live-linux-canary.md)
- [Audio protocol](../docs/desktop-audio-protocol.md)
- [Product requirements](../docs/clean-room-product-requirements.md)

## Landing page

The companion [static landing page](site/index.html) is self-contained HTML/CSS with local assets and no analytics, external fonts, or JavaScript dependencies. Serve `docs/site/` from a static host to render it. GitHub file view shows its source. No hosting or repository-visibility change is implied by committing these files.
