# Linux Voice Cockpit — Clean-Room Product Requirements

Status: discovery draft for CON-197  
Last updated: 2026-08-04

## Clean-room boundary

This document records product behavior and requirements, not an implementation recipe.
Voice.Claw Realtime and VoiceClaw Realtime Companion are reference products. The public
Companion repository has no declared license as of 2026-08-04, so its source must be
treated as all-rights-reserved. Do not copy code, tests, schemas, UI text, or other
substantial expression from it.

Allowed evidence:

- `PUBLIC-PRODUCT`: statements and screenshots published in the App Store listing or
  public product documentation.
- `BLACK-BOX`: behavior directly observed while operating the installed iPhone app or
  a released Companion binary.
- `SOURCE-VISIBLE`: facts visible in the unlicensed public repository. These may identify
  interoperability questions and security properties, but must not be translated into
  copied implementation.
- `PROJECT`: requirements selected independently for Linux Voice Cockpit.

Every factual Voice.Claw claim below carries one of those provenance labels. Unlabeled
normative statements are Linux Voice Cockpit requirements.

## Product intent

Linux Voice Cockpit should provide a Linux-first, realtime voice surface for OpenClaw
that keeps conversation fluid while delegated agent work continues. The desktop owns
local integration and secure access; phone access is a remote client, not the source of
truth for sessions, files, or credentials.

## Core requirements

### Desktop cockpit

- Provide an always-available Linux desktop surface for connection state, active voice
  route, transcript, delegated tasks, sessions, and transferred files. (`PROJECT`)
- Expose setup, pairing, diagnostics, and recovery without requiring users to hand-edit
  configuration files. (`PROJECT`)
- Keep the local service independently restartable and observable through the Linux
  service manager. (`PROJECT`)
- Default the bridge to loopback and publish it remotely only through an explicitly
  configured authenticated transport. (`PROJECT`)
- The reference Companion advertises setup, pairing, Tailscale, diagnostics, readiness,
  task, and file views. (`PUBLIC-PRODUCT`, public README)

### Realtime voice

- Support continuous, low-latency two-way speech with partial transcripts. (`PROJECT`)
- Support interruption/barge-in, mute, end-session, and recovery from route failure
  without losing the entire conversation. (`PROJECT`)
- Separate ordinary conversational turns from delegated tool or agent work so a long task
  does not block ongoing voice interaction. (`PROJECT`)
- Make the selected voice/model route and its cost/auth mode visible before a session starts.
  (`PROJECT`)
- The App Store listing advertises continuous live voice while computer-side agents work,
  plus transcript updates during handoffs and task progress. (`PUBLIC-PRODUCT`)

### OpenClaw sessions and task control

- Enumerate available OpenClaw agents and resumable sessions through supported OpenClaw
  interfaces rather than scraping mutable runtime files. (`PROJECT`)
- Allow starting a new session, selecting/resuming an existing session, steering an active
  task, and canceling a delegated task. (`PROJECT`)
- Display task lifecycle states and preserve enough correlation metadata to connect voice
  utterances, transcript events, OpenClaw turns, and returned artifacts. (`PROJECT`)
- Treat agent/task routing as explicit structured data; spoken names must resolve to a
  visible target before consequential work is dispatched. (`PROJECT`)
- The App Store listing advertises selecting agents/sessions, simultaneous delegation,
  progress monitoring, and task cancellation. (`PUBLIC-PRODUCT`)

### Files and media

- Support phone-to-desktop uploads and desktop-to-phone returned artifacts with explicit
  task/session association. (`PROJECT`)
- Verify declared size and a cryptographic digest before exposing an uploaded file to an
  agent. (`PROJECT`)
- Enforce per-file, per-task, and total storage limits; define expiry and deletion behavior;
  never silently evict files the user has not acknowledged. (`PROJECT`)
- Keep inbound uploads separate from returned-artifact storage and prevent user-supplied
  filenames from selecting filesystem paths. (`PROJECT`)
- The public product materials advertise attachments, camera captures, an artifact inbox,
  and task-scoped verified uploads. (`PUBLIC-PRODUCT`, `SOURCE-VISIBLE` README)

### Remote phone access

- Primary remote access must work over a private Tailscale path; public tunnels are advanced,
  opt-in, and visibly increase exposure. (`PROJECT`)
- Pairing must bind a phone to a specific cockpit instance using a short-lived or revocable
  credential. Pairing payloads must not embed durable provider secrets. (`PROJECT`)
- Authenticate every control, transcript, task, and file operation; do not rely on tailnet
  membership as the only authorization layer. (`PROJECT`)
- Provide revocation, device inventory, last-seen data, and audit receipts for remote actions.
  (`PROJECT`)
- The reference architecture advertises a private Tailscale HTTPS URL forwarding to a
  loopback service, with an optional public HTTPS tunnel. (`PUBLIC-PRODUCT`, public README)

### Credentials and privacy

- Store provider and pairing credentials using OS credential facilities, never plaintext
  project configuration or logs. (`PROJECT`)
- Redact secrets, bearer tokens, private hostnames, and pairing data from diagnostics and
  screenshots by default. (`PROJECT`)
- Make network destinations and data flow visible to the user, especially when cloud speech
  or model providers are selected. (`PROJECT`)
- Keep local OpenClaw capabilities local unless an authenticated request explicitly invokes
  them. (`PROJECT`)

## Observable reference flows

These flows are hypotheses derived from public product material and require black-box
confirmation before being treated as compatibility facts.

1. Install/start desktop Companion, verify prerequisites, and expose a local bridge through
   Tailscale. (`PUBLIC-PRODUCT`)
2. Pair a phone by QR code, setup link, or setup JSON. (`PUBLIC-PRODUCT`)
3. Select a realtime, OpenClaw, Hermes, or Codex route. (`PUBLIC-PRODUCT`)
4. Continue live voice conversation while dispatching and monitoring delegated work.
   (`PUBLIC-PRODUCT`)
5. Upload task inputs before dispatch and receive generated artifacts into a file inbox.
   (`PUBLIC-PRODUCT`, `SOURCE-VISIBLE` README)

## Black-box test backlog

No black-box results have been recorded yet. Capture screenshots or notes without secrets,
record the app version and timestamp, and tag each result `BLACK-BOX`.

- Pairing payload shape and credential lifetime.
- Network endpoints, HTTP methods, WebSocket/SSE use, and reconnect behavior observable from
  traffic generated by the installed app.
- Authentication failures, revocation, and multi-device behavior.
- Agent/session enumeration and session resume semantics.
- Voice interruption, mute, route switching, and recovery after bridge/agent failure.
- Upload ordering, limits, cancellation, artifact download, and deletion semantics.
- Backgrounding, lock-screen, Live Activity, Watch, and network-transition behavior.
- Compatibility against a clean-room Linux probe server before implementing a full bridge.

## Unknowns and legal constraints

- The public Companion repository reports no license through GitHub metadata. Until the owner
  grants a license, it is reference-only and must not be copied or adapted.
- Public product claims do not prove protocol compatibility; only controlled black-box testing
  can establish what the installed iPhone build actually sends and accepts.
- The stability and publication status of any protocol are unknown.
- Subscription mode uses server-side OpenClaw OAuth and ChatGPT Codex realtime admission;
  live endpoint and account-side billing evidence remain required before calling it proven.
- Contacting the upstream developer is an external action and remains blocked until Matt gives
  explicit approval. Proposed questions: licensing intent, availability of protocol docs, and
  willingness to support a clean-room Linux companion.

## Source register

| ID | Provenance | Reference | Used for |
|---|---|---|---|
| S1 | `PUBLIC-PRODUCT` | [VoiceClaw Realtime — App Store](https://apps.apple.com/us/app/voiceclaw-realtime/id6769243723) | Advertised voice, agent/session, file, remote-access, and platform capabilities |
| S2 | `PUBLIC-PRODUCT` / `SOURCE-VISIBLE` | [VoiceClaw Realtime Companion README](https://github.com/bdjben/Voice.Claw-Companion/blob/main/README.md) | Published architecture and product behavior; no code copied |
| S3 | `SOURCE-VISIBLE` | [Voice.Claw-Companion repository](https://github.com/bdjben/Voice.Claw-Companion) | License absence and future interoperability questions only |

## Completion checklist for CON-197

- [x] Initial desktop, voice, session-control, file, and remote-access requirements recorded.
- [x] Provenance vocabulary and source register established.
- [x] Explicit `openclaw-oauth` design and API-key fallback gate recorded.
- [ ] Live ChatGPT GPT Live endpoint and subscription-account evidence recorded.
- [x] Unknowns and current legal boundary explicit.
- [ ] Installed iPhone app black-box observations captured.
- [ ] Upstream licensing/protocol questions sent after Matt explicitly approves outreach.
- [ ] Requirements updated with verified black-box results and reviewed for clean-room leakage.
