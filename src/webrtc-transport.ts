import type { RealtimeChannel, TalkWebRtcLaunch } from "./contracts.js";

export interface WebRtcTransportCallbacks {
  onEvent(raw: string): void | Promise<void>;
  onRemoteStream?(stream: MediaStream): void;
  onConnectionState?(state: RTCPeerConnectionState): void;
}

export class WebRtcTransport implements RealtimeChannel {
  #peer: RTCPeerConnection | null = null;
  #channel: RTCDataChannel | null = null;
  #media: MediaStream | null = null;

  constructor(readonly callbacks: WebRtcTransportCallbacks) {}

  async connect(launch: TalkWebRtcLaunch, constraints: MediaTrackConstraints = {}): Promise<void> {
    if (this.#peer) throw new Error("WebRTC transport is already connected");
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

      this.#media = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          ...constraints,
        },
      });
      for (const track of this.#media.getAudioTracks()) peer.addTrack(track, this.#media);

      const channel = peer.createDataChannel("oai-events");
      this.#channel = channel;
      channel.addEventListener("message", (event) => {
        void this.callbacks.onEvent(String(event.data));
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("Browser did not produce an SDP offer");
      const response = await fetch(launch.offerUrl ?? "https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          ...launch.offerHeaders,
          Authorization: `Bearer ${launch.clientSecret}`,
          "Content-Type": "application/sdp",
        },
      });
      if (!response.ok) throw new Error(`Realtime WebRTC setup failed (${response.status})`);
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
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
