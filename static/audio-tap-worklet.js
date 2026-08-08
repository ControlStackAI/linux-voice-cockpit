/**
 * Accumulates the assistant's remote audio into fixed 1920-sample frames (40 ms @ 48 kHz).
 *
 * 1920 is 15 whole render quanta, so there is never a partial-quantum carry to track.
 * The node stays disarmed unless the page explicitly arms it, because the realtime remote
 * track runs continuously and is digital silence between responses -- an always-on tap
 * would publish 25 frames per second of nothing, forever.
 */
const FRAME_SAMPLES = 1920;

class AudioTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
    this.armed = false;
    this.port.onmessage = (event) => {
      const action = event.data && event.data.type;
      if (action === "arm") {
        // Always start an utterance frame-aligned rather than resuming a stale partial.
        this.filled = 0;
        this.armed = true;
      } else if (action === "disarm") {
        this.armed = false;
        this.filled = 0;
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!this.armed || !channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(FRAME_SAMPLES - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === FRAME_SAMPLES) {
        const frame = this.buffer.slice(0);
        this.port.postMessage(frame, [frame.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("audio-tap", AudioTapProcessor);
