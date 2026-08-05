# Agentic Voice Integration Plan

Status: proposed execution plan  
Updated: 2026-08-04  
Depends on: [GPT Live third-party integration](gpt-live-third-party-integration.md)

## Outcome

Deliver one continuous voice surface across Matt's agentic system:

- **Agentic Desktop:** always-available status, launch, transcript, task progress,
  interruption, steering, and confirmation controls.
- **Linux Voice Cockpit:** owns realtime audio, the OpenClaw Gateway connection, session
  correlation, credentials, and the full cockpit UI.
- **Phone:** acts as a secure remote microphone and cockpit over Tailscale, using the same
  OpenClaw sessions and agentic task state as the desktop.
- **OpenClaw:** remains the source of truth for agents, sessions, tools, policy, and task
  execution. OpenAI Realtime is the low-latency conversational front end, not a second
  agent runtime.

The first proof must be a real vertical slice: speak into a Linux microphone, hear a
Realtime response, trigger an `openclaw_agent_consult` in the selected project session,
watch its task/tool progress on the desktop, steer it by voice, and hear the result.

## Recommended architecture

```text
                           OpenAI Realtime API
                           WebRTC audio + events
                                  ^
                                  |
Phone/PWA ---- Tailscale ---- Voice Cockpit service ---- OpenClaw Gateway
                                  |                      agents/sessions/tools
                                  |
                    local authenticated IPC/event stream
                                  |
                     Tauri cockpit + Agentic Desktop HUD
```

### Process boundaries

1. **Cockpit service**
   - Long-lived background process managed by `systemd --user`.
   - Owns the paired OpenClaw device identity and Gateway connection.
   - Calls `talk.catalog`, `talk.client.create`, `talk.client.toolCall`, and
     `talk.client.steer`.
   - Correlates voice sessions, OpenClaw `sessionKey`, runs, tool calls, approvals, and
     artifacts.
   - Exposes a small authenticated local IPC/API to the desktop UI and Agentic Desktop HUD.
   - Serves the phone UI only on an explicitly configured Tailscale HTTPS origin.

2. **Tauri desktop app**
   - Owns PipeWire device selection, microphone UX, WebRTC, playback, transcript rendering,
     and interactive confirmations.
   - Receives only the short-lived Realtime `clientSecret`; it never receives durable
     OpenAI or OpenClaw credentials.
   - Uses the shared workspace UI component library and semantic design tokens.

3. **Agentic Desktop adapter**
   - A thin Quickshell surface, not a second voice engine.
   - Reads the cockpit's sanitized state projection: connected/listening/thinking/speaking,
     selected agent/session, active run, cost meter, pending confirmation, and error state.
   - Launches/focuses the full cockpit and exposes safe immediate controls: mute, stop
     output, cancel turn, and open confirmation.
   - Desktop-module implementation belongs to the `#agentic-desktop` lane; this project
     defines and tests the IPC contract.

4. **Phone client**
   - Start with an installable responsive PWA using the same frontend state model and
     WebRTC transport as the desktop.
   - Pair explicitly with one cockpit service; store a revocable device credential in the
     platform credential store.
   - Use direct phone-to-OpenAI WebRTC after the service mints an ephemeral session secret.
   - Promote to a native iOS app only if background audio, lock-screen controls, Watch,
     CallKit, or platform microphone limitations make the PWA inadequate.

This split avoids putting realtime media in Quickshell, avoids duplicating the OpenClaw
Gateway protocol, and lets desktop and mobile share one trusted control plane.

## Agentic behavior model

### Conversation and execution

- Ordinary conversational turns stay in OpenAI Realtime for minimum latency.
- Requests requiring tools, durable reasoning, local files, or an agent lane invoke
  `openclaw_agent_consult` and bind to a visible OpenClaw `sessionKey`.
- The selected session determines project context, billing lane, workflow, model, memory,
  and pen ownership. Voice must never invent or silently switch that target.
- Long agent runs stream status and tool progress without blocking the live voice session.
- A new utterance during a run is classified as status, steer, cancel, or follow-up through
  `talk.client.steer`.

### Session selection

The UI should present project-first targets instead of raw session keys:

```text
Project -> agent/lane -> existing session or new session -> active workflow/model
```

Resolve projects through the OpenClaw project registry and sessions through supported
Gateway methods. Show the exact destination before the microphone becomes live. A spoken
route change requires a visible confirmation when it changes project, billing lane, or
authority.

### Confirmation policy

Voice-originated high-impact actions require a fresh confirmation: outbound messages,
publication, node/computer control, destructive shell operations, credential changes, and
other consequential actions.

The cockpit should render the exact structured action and destination on the active trusted
device, read a concise summary aloud, accept an explicit spoken confirmation, and provide a
tap/click deny path. The approval must bind to the exact action and expire after one use;
generic “yes” state must not authorize later actions. Locked desktop sessions should route
confirmation to the paired unlocked phone or fail closed.

## Delivery phases

### Phase 0 — Prove the existing OpenClaw path

Goal: eliminate provider, account, microphone, and Gateway uncertainty before building UI.

- Run a live microphone canary against the installed OpenClaw `v2026.7.1-2` Talk path.
- Verify direct conversation, partial/final transcripts, playback, barge-in, one real
  `openclaw_agent_consult`, tool progress, steering, cancellation, and cleanup.
- Capture latency, session duration, reconnect behavior, and Realtime usage/cost.
- Confirm the configured serving origin is in `controlUi.allowedOrigins` for browser testing.
- Prove an idle closed cockpit stops billing; make session age/cost visible.

Exit gate: one recorded end-to-end run with no durable credential in the browser process or
logs.

Linear: completes the new implementation evidence behind CON-197 and informs CON-199/200.

### Phase 1 — Freeze architecture and threat model

Goal: decide boundaries before opening the microphone or Tailscale endpoint in new code.

- Write ADRs for Tauri + background service, WebRTC ownership, Gateway client ownership,
  local IPC, state persistence, UI sharing, and PWA-first mobile.
- Define the typed cockpit state/event protocol before implementing Agentic Desktop or phone
  consumers.
- Threat-model device pairing, credential theft, malicious audio, prompt/tool injection,
  replayed confirmations, public-origin mistakes, file transfer, logs, and session mix-ups.
- Decide whether the service is Rust or a packaged TypeScript runtime after a small Gateway
  client spike; prefer reuse of the official OpenClaw client/protocol over a rewrite.

Exit gate: ADRs and threat model approve the process/credential boundaries and confirmation
contract.

Linear: CON-199, CON-200.

### Phase 2 — Build the headless vertical slice

Goal: a testable control plane before polishing the desktop.

- Scaffold the service, typed IPC, structured logs, config validation, and test harness.
- Pair to OpenClaw using a device identity and reconnect with bounded backoff.
- List projects/sessions and bind a voice session to one exact `sessionKey`.
- Implement `talk.catalog` readiness and `talk.client.create` ephemeral-secret minting.
- Implement tool-call correlation, final-result return, steering, cancellation, and timeout.
- Emit a redacted state projection for all UI consumers.

Exit gate: automated integration test with a fake Realtime peer plus a live microphone
canary using a real OpenClaw session.

Linear: CON-201, CON-203, the control-plane portion of CON-204.

### Phase 3 — Desktop cockpit MVP

Goal: make the vertical slice a daily-use Linux application.

- Add PipeWire device enumeration, push-to-talk, continuous mode, levels, output selection,
  unplug/replug recovery, and echo constraints.
- Add live transcript, agent/tool progress, selected project/session, steering, cancel,
  mute, connection recovery, and cost/session-age telemetry.
- Add explicit confirmation cards with exact action and destination.
- Verify the real application in CloakBrowser/Tauri and on the live PipeWire desktop: no
  console errors, failed RPCs, clipping, inaccessible controls, feedback, or leaked secrets.

Exit gate: Matt can complete a useful agent task entirely by voice while retaining keyboard
and pointer control.

Linear: CON-202, CON-204, CON-205.

### Phase 4 — Agentic Desktop integration

Goal: voice becomes a first-class OS surface without duplicating the cockpit.

- Publish the sanitized local state/event schema and a tiny control API.
- Add a Quickshell voice chip beside the existing workflow/model/execution surfaces.
- Show listening/thinking/speaking, route, active issue/run, elapsed time/cost, and pending
  confirmation.
- Add mute, stop output, cancel turn, and focus/open-cockpit actions.
- Integrate notifications for completion, disconnection, and requested confirmation.
- Apply lock-state authority: read-only status while locked; consequential confirmation
  moves to the paired phone or fails closed.

Exit gate: screenshot-verified Agentic Desktop surface accurately follows a live voice run
and cannot execute an action outside the typed cockpit API.

Ownership: protocol and cockpit changes stay here; Quickshell/NixOS changes are handed to
`#agentic-desktop` for implementation and activation.

Linear: CON-209 plus a dedicated Agentic Desktop integration issue when execution begins.

### Phase 5 — Secure phone remote

Goal: the phone becomes a trustworthy remote microphone and task cockpit.

- Complete the Voice.Claw installed-app black-box interoperability spike before committing
  to compatibility work.
- Independently implement the responsive PWA against the cockpit's documented protocol.
- Publish only through Tailscale HTTPS; require app authentication in addition to tailnet
  membership.
- Add QR pairing, device inventory, revocation, last-seen state, and credential rotation.
- Support session selection, transcript, push-to-talk/continuous audio, interruption,
  steering, confirmation, and reconnect across Wi-Fi/cellular transitions.
- Compare PWA limitations against a native iOS decision gate; do not build both paths.

Exit gate: revoke the phone and prove it cannot mint a Realtime session or control an active
OpenClaw run; then re-pair and complete the end-to-end voice task remotely.

Linear: CON-198, CON-206.

### Phase 6 — Files, hardening, and release

Goal: safe daily operation and reproducible deployment.

- Add task-scoped phone/desktop uploads and explicit returned-artifact handling with hashes,
  size limits, path safety, expiry, cancellation, and no automatic execution.
- Store credentials through Secret Service; package the service and desktop app
  declaratively; add bounded logs and recovery across suspend/network changes.
- Test install, upgrade, rollback, uninstall, device revocation, and prior NixOS generation
  recovery.

Exit gate: complete the full acceptance suite from a clean install and ship the personal MVP.

Linear: CON-208, CON-209, CON-207.

## First implementation sprint

The fastest useful sequence is:

1. Finish the real OpenClaw Talk microphone canary.
2. Commit ADRs for the service/UI/WebRTC boundary and PWA-first mobile strategy.
3. Commit the threat model and exact-action confirmation contract.
4. Scaffold the service and Tauri shell.
5. Implement Gateway pairing, project/session selection, and `talk.client.create`.
6. Complete one direct conversation plus one agent consult and steering round trip.
7. Only then build the polished transcript UI and Agentic Desktop chip.

Do not begin with file transfer, native iOS, Watch, or deep desktop chrome. They add surface
area without reducing the central technical risk: a safe, low-latency voice-to-agent loop.

## System acceptance scenario

The feature is integrated when this scenario works:

1. Matt clicks the Agentic Desktop voice chip or uses a keybind.
2. The cockpit shows `linux-voice-cockpit -> ALINA -> existing project session` and begins
   listening.
3. Matt asks a normal question and receives an immediate Realtime answer.
4. Matt asks for repository work; Realtime invokes OpenClaw, and the desktop shows the issue,
   workflow, run, and tool progress while voice remains responsive.
5. Matt asks for status, steers the work, then cancels or lets it finish.
6. A consequential action presents its exact target and waits for fresh confirmation.
7. Matt walks away, opens the paired phone over Tailscale, resumes the same OpenClaw session,
   and continues speaking.
8. Ending Talk closes WebRTC, clears the ephemeral secret, stops the cost meter, and leaves a
   coherent transcript/task receipt in the selected OpenClaw session.

## Success metrics

- First audible response latency and barge-in latency are measured and visible.
- No durable provider or Gateway master credential reaches renderer, PWA, QR payload, or logs.
- Every agent consult is correlated to one visible project/session/run.
- Steering and cancel work during active tool execution.
- Realtime conversation survives an agent task without blocking.
- Desktop and phone never disagree about the selected authoritative session.
- High-impact voice requests fail closed without fresh exact-action confirmation.
- Ending or abandoning Talk reliably closes the billable Realtime session.
