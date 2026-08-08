import {
  FLAG_UTTERANCE_START,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  encodeAudioFrame,
} from "./desktop-audio-protocol.js";

export interface AudioTapOptions {
  /** Receives one encoded 40 ms frame. Called only while the tap is armed. */
  publish(frame: ArrayBuffer): void;
  workletUrl?: string;
}

/**
 * Taps the assistant's remote WebRTC audio into fixed 40 ms frames for the desktop tap.
 *
 * The cockpit `<audio>` element remains the only audio sink; this path is video-lip-sync
 * only. The worklet is therefore routed through a zero-gain node -- it needs a path to
 * the destination to be pulled at all, but unity gain would double-play every response.
 */
export class AudioTap {
  #context: AudioContext | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #node: AudioWorkletNode | null = null;
  #gain: GainNode | null = null;
  #seq = 0;
  #utterance = 0;
  #armed = false;
  #frameOfUtterance = 0;

  constructor(readonly options: AudioTapOptions) {}

  async attach(stream: MediaStream): Promise<void> {
    await this.detach();
    // Explicit rate: the default follows the hardware, and PipeWire is usually but not
    // always 48 kHz. At 44.1 kHz the 40 ms frame arithmetic silently stops holding.
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.#context = context;
    try {
      if (context.state === "suspended") await context.resume();
      if (context.sampleRate !== SAMPLE_RATE) {
        throw new Error(
          `Audio tap requires a ${SAMPLE_RATE} Hz context; the browser provided ${context.sampleRate} Hz`,
        );
      }
      await context.audioWorklet.addModule(this.options.workletUrl ?? "/audio-tap-worklet.js");

      const node = new AudioWorkletNode(context, "audio-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (event) => this.#onFrame(event.data as Float32Array);
      const gain = new GainNode(context, { gain: 0 });
      const source = new MediaStreamAudioSourceNode(context, { mediaStream: stream });
      source.connect(node);
      node.connect(gain);
      gain.connect(context.destination);

      this.#node = node;
      this.#gain = gain;
      this.#source = source;
    } catch (error) {
      await this.detach();
      throw error;
    }
  }

  /** Begin publishing frames for one utterance. `id` matches the `speak.start` marker. */
  arm(id: number): void {
    if (!this.#node) return;
    this.#utterance = id >>> 0;
    this.#frameOfUtterance = 0;
    this.#armed = true;
    this.#node.port.postMessage({ type: "arm" });
  }

  disarm(): void {
    this.#armed = false;
    this.#utterance = 0;
    this.#frameOfUtterance = 0;
    this.#node?.port.postMessage({ type: "disarm" });
  }

  async detach(): Promise<void> {
    this.disarm();
    if (this.#node) this.#node.port.onmessage = null;
    this.#source?.disconnect();
    this.#node?.disconnect();
    this.#gain?.disconnect();
    this.#source = null;
    this.#node = null;
    this.#gain = null;
    const context = this.#context;
    this.#context = null;
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }

  #onFrame(samples: Float32Array): void {
    if (!this.#armed || samples.length !== FRAME_SAMPLES) return;
    this.#seq = (this.#seq + 1) >>> 0 || 1;
    const flags = this.#frameOfUtterance === 0 ? FLAG_UTTERANCE_START : 0;
    this.#frameOfUtterance += 1;
    this.options.publish(encodeAudioFrame(samples, { seq: this.#seq, id: this.#utterance, flags }));
  }
}
