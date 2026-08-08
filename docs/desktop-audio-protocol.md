# Desktop audio tap — `/desktop/audio`

The cockpit publishes the assistant's audio and its turn boundaries on a loopback-only
WebSocket so a local consumer can drive a lip-synced avatar. The first consumer is
Presence (`ControlStackAI/presence`), whose matching document is
`docs/desktop-audio-protocol.md` on its `liveavatar-lite` branch.

Two properties are load-bearing and neither is a preference:

- **Consumers subscribe to the cockpit; the cockpit never dials a consumer.** A consumer
  that is down, slow, or absent cannot affect the voice path.
- **Audio and markers share one socket.** WebSocket orders data messages on a single
  connection regardless of type, so `speak.end` cannot overtake the last audio frame of
  its utterance. Across two sockets it can, and the consumer ends the utterance early and
  clips the final word.

## Connecting

```
ws://127.0.0.1:4280/desktop/audio
```

Loopback addresses only. A **foreign** `Origin` is refused with HTTP 403; an **absent**
`Origin` is accepted, because a non-browser client such as Node `ws` sends none. The
loopback bind is the real boundary.

The server sends `hello` before any binary frame, so a consumer builds its resampler
against a known rate instead of guessing:

```json
{"type":"hello","v":1,"sampleRate":48000,"channels":1,"frameSamples":1920,"phase":"idle"}
```

## Binary frames — audio

One frame is **1920 float32 mono samples at 48 kHz — exactly 40 ms**, 7696 bytes on the
wire. 1920 is 15 whole AudioWorklet render quanta, so the publisher never carries a
partial quantum, and 40 ms is exact in wall-clock.

16-byte little-endian header, then the payload:

| off | size | type | field |
|---|---|---|---|
| 0 | 1 | uint8 | `version` = 1 |
| 1 | 1 | uint8 | `flags` — bit0 = first frame of utterance |
| 2 | 2 | uint16 | `reserved` = 0 |
| 4 | 4 | uint32 | `sampleRate` = 48000 |
| 8 | 4 | uint32 | `seq` — monotonic per publisher connection, from 1 |
| 12 | 4 | uint32 | `id` — enclosing utterance id, 0 outside one |
| 16 | … | float32[] | mono samples in [-1, 1] |

`flags` bit0 is advisory; `speak.start` is authoritative. It exists so the binary stream
can resync if a marker is ever missed.

**Binary is sent only between `speak.start` and `speak.end`/`speak.cancel`.** The realtime
remote track runs continuously and is digital silence between responses; an always-on tap
would publish 25 frames per second of nothing.

**Delivery is best effort.** A consumer more than ~2 s (50 frames) behind has frames
dropped rather than queued, so a stalled consumer can never backpressure the browser. A
gap in `seq` is how the consumer learns this happened. **Control frames are never
dropped** — losing `speak.end` strands a consumer mid-utterance.

## Text frames — control

`id` shares the uint32 space with the binary header and is monotonic across markers. An
utterance closes under the id it opened with. `t` is `Date.now()` on the publisher,
advisory, for log correlation only.

```
{"type":"listen.start","id":7,"t":…}
{"type":"listen.stop","id":8,"t":…}
{"type":"speak.start","id":9,"t":…}     ← binary frames follow, id=9
{"type":"speak.end","id":9,"t":…}
{"type":"speak.cancel","id":9,"t":…}    ← barge-in or teardown
{"type":"phase","phase":"…","t":…}
```

Markers are derived from realtime session events, not from audio energy:

| Event | Marker |
|---|---|
| `input_audio_buffer.speech_started` | `speak.cancel` if an utterance is open, then `listen.start` |
| `input_audio_buffer.speech_stopped` | `listen.stop` |
| `output_audio_buffer.started` (WebRTC) | `speak.start` |
| `output_audio_buffer.stopped` (WebRTC) | `speak.end` |
| `output_audio_buffer.cleared` (WebRTC) | `speak.cancel` |
| first `response.output_audio.delta` (data-audio fallback) | `speak.start` |
| `response.done` (data-audio fallback) | `speak.end` |
| `response.cancelled`, `conversation.item.truncated` | `speak.cancel` |

Two cases worth knowing:

- **Barge-in is signalled early.** `input_audio_buffer.speech_started` arriving during an
  utterance is the earliest reliable barge-in signal — it precedes `response.cancelled`
  and the truncation that follows. The later events are idempotent and will not emit a
  second cancel for the same utterance.
- **A transcript-only response never opens an utterance.** Transcript deltas can arrive
  for a response that produces no audio, and an utterance opened there would never close.
- **WebRTC playback boundaries beat response lifecycle boundaries.** `response.done` can
  arrive while the peer connection still has an audible media tail buffered. Once
  `output_audio_buffer.started` is observed, the matching `stopped`/`cleared` event owns
  the close so the tap does not clip that tail.

### `phase`

Emitted on every cockpit phase change, and on browser disconnect — a page that dies
mid-utterance sends no `speak.end`, so the phase change is how a consumer learns to tear
its own session down.

The value is the cockpit's own enum, which differs from a plain connection state:
`idle | connecting | listening | thinking | speaking | error`. There is no `connected`;
any non-`idle` phase implies a live session. `phase` is advisory — gate billed work on
`GET /desktop/state`, which is the authoritative projection.

## Verifying

```bash
npm run canary:audio          # spawns the service on 4283 and exercises the tap
```

Covers the shared upgrade router, the Origin policy, `hello`, phase publication,
interleaved publish ordering, rejection of malformed frames, and the disconnect path.
Wire-format and turn-marker state machine coverage lives in `npm test`.
