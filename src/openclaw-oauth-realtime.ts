import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const GPT_LIVE_CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const REFRESH_SKEW_MS = 60_000;

interface OAuthProfile {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
}

interface AuthStore { version?: number; profiles: Record<string, OAuthProfile | Record<string, unknown>> }
export interface OAuthProfileLocation { kind: "sqlite" | "json"; path: string; profileId?: string }
export interface OpenClawOAuthRealtimeOptions {
  location: OAuthProfileLocation;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export class OpenClawOAuthRealtime {
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  constructor(readonly options: OpenClawOAuthRealtimeOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async createCall(sdpOffer: string): Promise<string> {
    if (!sdpOffer.trim()) throw new Error("A non-empty SDP offer is required");
    const { store, profileId, profile } = await this.loadProfile();
    const usable = profile.expires <= this.#now() + REFRESH_SKEW_MS
      ? await this.refreshProfile(store, profileId, profile)
      : profile;
    const accountId = usable.accountId ?? accountIdFromJwt(usable.access);
    if (!accountId) throw new Error("OpenClaw OAuth profile has no ChatGPT account ID");

    const response = await this.#fetch(GPT_LIVE_CALL_URL, {
      method: "POST",
      body: sdpOffer,
      headers: {
        Authorization: `Bearer ${usable.access}`,
        "ChatGPT-Account-ID": accountId,
        "Content-Type": "application/sdp",
      },
    });
    if (!response.ok) throw new Error(`ChatGPT GPT Live admission failed (${response.status})`);
    return response.text();
  }

  private async loadProfile(): Promise<{ store: AuthStore; profileId: string; profile: OAuthProfile }> {
    const store = await readStore(this.options.location);
    const candidates = Object.entries(store.profiles).filter(([, value]) => {
      const provider = String(value.provider ?? "").toLowerCase();
      return value.type === "oauth" && (provider === "openai" || provider === "openai-codex")
        && typeof value.access === "string" && typeof value.refresh === "string";
    }) as Array<[string, OAuthProfile]>;
    const selected = this.options.location.profileId
      ? candidates.find(([id]) => id === this.options.location.profileId)
      : candidates.find(([id]) => id === "openai:default" || id === "openai-codex:default") ?? candidates[0];
    if (!selected) throw new Error("No OpenAI/openai-codex OAuth profile found in the OpenClaw store");
    return { store, profileId: selected[0], profile: selected[1] };
  }

  private async refreshProfile(store: AuthStore, profileId: string, profile: OAuthProfile): Promise<OAuthProfile> {
    const response = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: profile.refresh,
        client_id: CODEX_CLIENT_ID,
      }),
    });
    if (!response.ok) throw new Error(`OpenAI Codex OAuth refresh failed (${response.status})`);
    const result = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!result.access_token || !result.refresh_token || !Number.isFinite(result.expires_in)) {
      throw new Error("OpenAI Codex OAuth refresh returned an incomplete token set");
    }
    const refreshed: OAuthProfile = {
      ...profile,
      access: result.access_token,
      refresh: result.refresh_token,
      expires: this.#now() + Number(result.expires_in) * 1000,
    };
    store.profiles[profileId] = refreshed;
    await writeStore(this.options.location, store);
    return refreshed;
  }
}

async function readStore(location: OAuthProfileLocation): Promise<AuthStore> {
  if (location.kind === "json") return JSON.parse(await readFile(location.path, "utf8")) as AuthStore;
  const db = new DatabaseSync(location.path);
  try {
    const row = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'").get() as { store_json?: string } | undefined;
    if (!row?.store_json) throw new Error("OpenClaw SQLite auth store has no primary profile set");
    return JSON.parse(row.store_json) as AuthStore;
  } finally { db.close(); }
}

async function writeStore(location: OAuthProfileLocation, store: AuthStore): Promise<void> {
  if (location.kind === "json") {
    await writeFile(location.path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  const db = new DatabaseSync(location.path);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = 'primary'")
      .run(JSON.stringify(store), Date.now());
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.close(); }
}

function accountIdFromJwt(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const value = auth?.chatgpt_account_id ?? payload.chatgpt_account_id;
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch { return undefined; }
}
