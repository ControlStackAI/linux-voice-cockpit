import { CockpitController } from "./cockpit-controller.js";
import type {
  GatewayEvent,
  RealtimeChannel,
  RealtimeToolCall,
  ToolCallAccepted,
} from "./contracts.js";

interface ToolBuffer {
  name: string;
  callId: string;
  argumentsJson: string;
}

interface ChatPayload {
  runId?: string;
  state?: string;
  message?: unknown;
  errorMessage?: string;
}

export class RealtimeEventBridge {
  readonly #buffers = new Map<string, ToolBuffer>();
  readonly #pendingRuns = new Map<string, {
    callId: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  #unsubscribe: (() => void) | null = null;

  constructor(
    readonly cockpit: CockpitController,
    readonly channel: RealtimeChannel,
  ) {}

  start(): void {
    this.#unsubscribe ??= this.cockpit.gateway.subscribe((event) => this.onGatewayEvent(event));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const pending of this.#pendingRuns.values()) {
      pending.reject(new Error("Voice session stopped"));
    }
    this.#pendingRuns.clear();
    this.#buffers.clear();
    this.cockpit.setActiveTool(null, null);
  }

  async handle(raw: string | Record<string, unknown>): Promise<void> {
    const event = typeof raw === "string" ? this.parse(raw) : raw;
    if (!event || typeof event.type !== "string") return;

    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.cockpit.setPhase("listening");
        return;
      case "input_audio_buffer.speech_started":
        this.cockpit.setPhase("listening");
        return;
      case "input_audio_buffer.speech_stopped":
      case "response.created":
        this.cockpit.setPhase("thinking");
        return;
      case "response.output_audio.delta":
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        this.cockpit.setPhase("speaking");
        return;
      case "response.done":
      case "response.cancelled":
        this.cockpit.setPhase("listening");
        return;
      case "response.function_call_arguments.delta":
        this.bufferDelta(event);
        return;
      case "response.function_call_arguments.done":
        await this.finishToolCall(event);
        return;
      case "error":
        this.cockpit.fail(this.errorMessage(event.error));
    }
  }

  async steer(text: string, mode: "auto" | "status" | "steer" | "cancel" = "auto"):
    Promise<unknown> {
    const sessionKey = this.requireSessionKey();
    return this.cockpit.gateway.request("talk.client.steer", { sessionKey, text, mode });
  }

  private bufferDelta(event: Record<string, unknown>): void {
    const itemId = this.string(event.item_id) ?? "unknown";
    const current = this.#buffers.get(itemId) ?? {
      name: this.string(event.name) ?? "",
      callId: this.string(event.call_id) ?? "",
      argumentsJson: "",
    };
    current.name ||= this.string(event.name) ?? "";
    current.callId ||= this.string(event.call_id) ?? "";
    current.argumentsJson += this.string(event.delta) ?? "";
    this.#buffers.set(itemId, current);
  }

  private async finishToolCall(event: Record<string, unknown>): Promise<void> {
    const itemId = this.string(event.item_id) ?? "unknown";
    const buffered = this.#buffers.get(itemId);
    this.#buffers.delete(itemId);
    const tool: RealtimeToolCall = {
      itemId,
      callId: buffered?.callId || this.string(event.call_id) || "",
      name: buffered?.name || this.string(event.name) || "",
      argumentsJson: buffered?.argumentsJson || this.string(event.arguments) || "{}",
    };
    if (!tool.callId) return;

    if (tool.name === "openclaw_agent_control") {
      const args = this.jsonObject(tool.argumentsJson);
      const result = await this.steer(
        this.string(args.text) ?? "",
        (this.string(args.mode) as "auto" | "status" | "steer" | "cancel") ?? "auto",
      );
      this.submitToolResult(tool.callId, result);
      return;
    }
    if (tool.name !== "openclaw_agent_consult") {
      this.submitToolResult(tool.callId, { error: `Unsupported tool: ${tool.name}` });
      return;
    }

    try {
      const result = await this.consult(tool);
      this.submitToolResult(tool.callId, { result });
    } catch (error) {
      this.submitToolResult(tool.callId, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async consult(tool: RealtimeToolCall): Promise<unknown> {
    const sessionKey = this.requireSessionKey();
    const args = this.jsonObject(tool.argumentsJson);
    this.cockpit.setPhase("thinking");
    const accepted = await this.cockpit.gateway.request<ToolCallAccepted>(
      "talk.client.toolCall",
      { sessionKey, callId: tool.callId, name: tool.name, args },
    );
    const runId = accepted.runId ?? accepted.idempotencyKey;
    if (!runId) throw new Error("OpenClaw did not return a run id");
    this.cockpit.setActiveTool(tool.callId, runId);

    return new Promise((resolve, reject) => {
      this.#pendingRuns.set(runId, { callId: tool.callId, resolve, reject });
    });
  }

  private onGatewayEvent(event: GatewayEvent): void {
    if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") return;
    const payload = event.payload as ChatPayload;
    if (!payload.runId) return;
    const pending = this.#pendingRuns.get(payload.runId);
    if (!pending) return;

    if (payload.state === "final") {
      this.#pendingRuns.delete(payload.runId);
      this.cockpit.setActiveTool(null, null);
      pending.resolve(this.extractText(payload.message));
    } else if (payload.state === "aborted" || payload.state === "error") {
      this.#pendingRuns.delete(payload.runId);
      this.cockpit.setActiveTool(null, null);
      pending.reject(new Error(payload.errorMessage ?? `OpenClaw run ${payload.state}`));
    }
  }

  private submitToolResult(callId: string, output: unknown): void {
    this.channel.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    this.channel.send({ type: "response.create" });
  }

  private requireSessionKey(): string {
    if (!this.cockpit.state.sessionKey) throw new Error("No active OpenClaw session");
    return this.cockpit.state.sessionKey;
  }

  private parse(raw: string): Record<string, unknown> | null {
    try {
      const value: unknown = JSON.parse(raw);
      return value && typeof value === "object" ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private jsonObject(raw: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Realtime tool arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  private string(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private errorMessage(value: unknown): string {
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return "Realtime provider error";
  }

  private extractText(message: unknown): unknown {
    if (typeof message === "string") return message;
    if (!message || typeof message !== "object") return message;
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((item) => item && typeof item === "object" && "text" in item
          ? (item as { text?: unknown }).text
          : "")
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .join("\n");
    }
    return message;
  }
}
