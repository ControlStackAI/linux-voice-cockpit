import type { RealtimeChannel, TalkWebRtcLaunch } from "./contracts.js";
import { withTimeout } from "./timeouts.js";

export interface WebRtcTransportCallbacks {
  onEvent(raw: string): void | Promise<void>;
  onRemoteStream?(stream: MediaStream): void;
  onConnectionState?(state: RTCPeerConnectionState): void;
  onMicrophoneState?(state: "requesting" | "granted"): void;
  timeoutMs?: number;
}

export class WebRtcTransport implements RealtimeChannel {
  #peer: RTCPeerConnection | null = null;
  #channel: RTCDataChannel | null = null;
  #media: MediaStream | null = null;

  constructor(readonly callbacks: WebRtcTransportCallbacks) {}

  async connect(launch: TalkWebRtcLaunch, constraints: MediaTrackConstraints = {}): Promise<void> {
    if (this.#peer) throw new Error("WebRTC transport is already connected");
    const timeoutMs = this.callbacks.timeoutMs ?? 15_000;
    const peer = new RTCPeerConnection();
    this.#peer = peer;
    try {
      peer.addEventListener("track", (event) => {
        const stream = event.streams[0];
        if (stream) this.callbacks.onRemoteStream?.(stream);
      });
      peer.addEventListener("connectionstatechange", () => {
        this.callbacks.onConnectionState?.(peer.connectionState);
      });

      this.callbacks.onMicrophoneState?.("requesting");
      this.#media = await withTimeout(navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          ...constraints,
        },
      }), timeoutMs, "Microphone access");
      this.callbacks.onMicrophoneState?.("granted");
      for (const track of this.#media.getAudioTracks()) peer.addTrack(track, this.#media);

      const channel = peer.createDataChannel("oai-events");
      this.#channel = channel;
      channel.addEventListener("message", (event) => {
        void this.callbacks.onEvent(String(event.data));
      });

      const offer = await withTimeout(peer.createOffer(), timeoutMs, "WebRTC offer creation");
      await withTimeout(peer.setLocalDescription(offer), timeoutMs, "WebRTC local description");
      if (!offer.sdp) throw new Error("Browser did not produce an SDP offer");
      const response = await withTimeout(fetch(launch.offerUrl ?? "https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          ...launch.offerHeaders,
          Authorization: `Bearer ${launch.clientSecret}`,
          "Content-Type": "application/sdp",
        },
      }), timeoutMs, "Realtime SDP exchange");
      if (!response.ok) throw new Error(`Realtime WebRTC setup failed (${response.status})`);
      const answer = await withTimeout(response.text(), timeoutMs, "Realtime SDP answer");
      await withTimeout(
        peer.setRemoteDescription({ type: "answer", sdp: answer }),
        timeoutMs,
        "WebRTC remote description",
      );
      await waitForPeerConnection(peer, timeoutMs);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  send(event: Record<string, unknown>): void {
    if (this.#channel?.readyState !== "open") {
      throw new Error("Realtime event channel is not open");
    }
    this.#channel.send(JSON.stringify(event));
  }

  close(): void {
    this.#channel?.close();
    this.#channel = null;
    this.#peer?.close();
    this.#peer = null;
    for (const track of this.#media?.getTracks() ?? []) track.stop();
    this.#media = null;
  }
}

async function waitForPeerConnection(peer: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (peer.connectionState === "connected") return;
  let onStateChange: (() => void) | undefined;
  const connected = new Promise<void>((resolve, reject) => {
    onStateChange = () => {
      switch (peer.connectionState) {
        case "connected":
          resolve();
          break;
        case "failed":
        case "closed":
          reject(new Error(`WebRTC connection ${peer.connectionState}`));
          break;
        default:
          break;
      }
    };
    peer.addEventListener("connectionstatechange", onStateChange);
    onStateChange();
  });
  try {
    await withTimeout(connected, timeoutMs, "WebRTC connection");
  } finally {
    if (onStateChange) peer.removeEventListener("connectionstatechange", onStateChange);
  }
}
