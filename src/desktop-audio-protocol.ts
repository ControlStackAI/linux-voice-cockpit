/**
 * Wire format for the loopback `/desktop/audio` tap.
 *
 * Audio travels as binary frames and turn markers as JSON text frames on a single
 * WebSocket, because WebSocket orders data messages on one connection regardless of
 * type. That ordering is the whole point: `speak.end` must never overtake the last
 * audio frame of its utterance, or a consumer ends the utterance early and clips the
 * final word.
 */

/** Samples per binary frame: 15 whole AudioWorklet render quanta, exactly 40 ms at 48 kHz. */
export const FRAME_SAMPLES = 1920;
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 1;
export const PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 16;
export const FRAME_BYTES = HEADER_BYTES + FRAME_SAMPLES * Float32Array.BYTES_PER_ELEMENT;

/** bit0 — this is the first audio frame of its utterance. Advisory; `speak.start` is authoritative. */
export const FLAG_UTTERANCE_START = 1;

export interface AudioFrameHeader {
  version: number;
  flags: number;
  sampleRate: number;
  seq: number;
  id: number;
}

export type TurnMarker =
  | { type: "listen.start"; id: number; t: number }
  | { type: "listen.stop"; id: number; t: number }
  | { type: "speak.start"; id: number; t: number }
  | { type: "speak.end"; id: number; t: number }
  | { type: "speak.cancel"; id: number; t: number };

export type ControlFrame =
  | TurnMarker
  | { type: "phase"; phase: string; t: number }
  | {
    type: "hello";
    v: number;
    sampleRate: number;
    channels: number;
    frameSamples: number;
    phase: string;
  };

const TURN_MARKER_TYPES = new Set<TurnMarker["type"]>([
  "listen.start",
  "listen.stop",
  "speak.start",
  "speak.end",
  "speak.cancel",
]);

export function isTurnMarkerType(value: unknown): value is TurnMarker["type"] {
  return typeof value === "string" && TURN_MARKER_TYPES.has(value as TurnMarker["type"]);
}

export function helloFrame(phase: string): ControlFrame {
  return {
    type: "hello",
    v: PROTOCOL_VERSION,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    frameSamples: FRAME_SAMPLES,
    phase,
  };
}

/**
 * Build one binary frame. `samples` must be exactly FRAME_SAMPLES long so consumers can
 * assume a fixed 40 ms cadence rather than re-deriving duration per frame.
 */
export function encodeAudioFrame(
  samples: Float32Array,
  header: { seq: number; id: number; flags?: number },
): ArrayBuffer {
  if (samples.length !== FRAME_SAMPLES) {
    throw new Error(`Audio frame must carry exactly ${FRAME_SAMPLES} samples, received ${samples.length}`);
  }
  const buffer = new ArrayBuffer(FRAME_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, (header.flags ?? 0) & 0xff);
  view.setUint16(2, 0, true);
  view.setUint32(4, SAMPLE_RATE, true);
  view.setUint32(8, header.seq >>> 0, true);
  view.setUint32(12, header.id >>> 0, true);
  new Float32Array(buffer, HEADER_BYTES).set(samples);
  return buffer;
}

export function decodeAudioFrameHeader(frame: ArrayBufferView | ArrayBuffer): AudioFrameHeader {
  const view = ArrayBuffer.isView(frame)
    ? new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    : new DataView(frame);
  if (view.byteLength < HEADER_BYTES) {
    throw new Error(`Audio frame is shorter than the ${HEADER_BYTES}-byte header`);
  }
  return {
    version: view.getUint8(0),
    flags: view.getUint8(1),
    sampleRate: view.getUint32(4, true),
    seq: view.getUint32(8, true),
    id: view.getUint32(12, true),
  };
}

export function decodeAudioFrameSamples(frame: ArrayBufferView | ArrayBuffer): Float32Array {
  const { buffer, byteOffset, byteLength } = ArrayBuffer.isView(frame)
    ? frame
    : { buffer: frame, byteOffset: 0, byteLength: frame.byteLength };
  const payload = byteLength - HEADER_BYTES;
  if (payload < 0 || payload % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("Audio frame payload is not a whole number of float32 samples");
  }
  // Copy: the source may be a pooled socket buffer that is reused after this turn.
  return new Float32Array(buffer.slice(byteOffset + HEADER_BYTES, byteOffset + byteLength));
}

/** A well-formed frame is version 1, 48 kHz, and exactly FRAME_SAMPLES of payload. */
export function isValidAudioFrame(frame: ArrayBufferView | ArrayBuffer): boolean {
  const byteLength = ArrayBuffer.isView(frame) ? frame.byteLength : frame.byteLength;
  if (byteLength !== FRAME_BYTES) return false;
  try {
    const header = decodeAudioFrameHeader(frame);
    return header.version === PROTOCOL_VERSION && header.sampleRate === SAMPLE_RATE;
  } catch {
    return false;
  }
}
