import type { CockpitPhase, CockpitProjection } from "./contracts.js";

const PHASES = new Set<CockpitPhase>(["idle", "connecting", "listening", "thinking", "speaking", "error"]);
const MAX_TEXT = 240;

export function initialProjection(now = new Date()): CockpitProjection {
  return {
    schemaVersion: 1,
    phase: "idle",
    transport: null,
    model: null,
    voice: null,
    error: null,
    connectedAt: null,
    listeningAt: null,
    browserConnected: false,
    updatedAt: now.toISOString(),
  };
}

export function sanitizeProjection(value: unknown, browserConnected: boolean, now = new Date()): CockpitProjection {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const phase = typeof input.phase === "string" && PHASES.has(input.phase as CockpitPhase)
    ? input.phase as CockpitPhase
    : "error";
  return {
    schemaVersion: 1,
    phase,
    transport: input.transport === "subscription" || input.transport === "api" ? input.transport : null,
    model: bounded(input.model),
    voice: bounded(input.voice),
    error: bounded(input.error),
    connectedAt: timestamp(input.connectedAt),
    listeningAt: timestamp(input.listeningAt),
    browserConnected,
    updatedAt: now.toISOString(),
  };
}

function bounded(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) || null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
