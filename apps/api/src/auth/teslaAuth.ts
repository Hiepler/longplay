import { createHash, randomBytes } from "node:crypto";

import { decryptJson, encryptJson } from "@longplay/crypto";

import type { AppConfig } from "../config/env.js";
import type { StoredCredentials, Store } from "../db/store.js";

// vehicle_cmds is required for Fleet Telemetry streaming: pairing the virtual key + signing the
// fleet_telemetry_config go through the Vehicle Command Protocol. We never SEND commands — the
// capability is only what Tesla requires to authorize telemetry-config writes.
export const TESLA_SCOPES = [
  "openid",
  "offline_access",
  "vehicle_device_data",
  "vehicle_location",
  "vehicle_cmds"
] as const;

const TELEMETRY_FIELDS = {
  VehicleSpeed: { interval_seconds: 5, minimum_delta: 3 },
  LongitudinalAcceleration: { interval_seconds: 2, minimum_delta: 0.8 },
  BrakePedal: { interval_seconds: 1 },
  LightsHazardsActive: { interval_seconds: 1 },
  Location: { interval_seconds: 30, minimum_delta: 250 },
  MinutesToArrival: { interval_seconds: 60 },
  RouteTrafficMinutesDelay: { interval_seconds: 60 },
  Soc: { interval_seconds: 60 },
  OutsideTemp: { interval_seconds: 300, minimum_delta: 1 }
} as const;

export class TeslaAuthService {
  private fetchImpl: typeof fetch = fetch;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store
  ) {}

  /** Test seam. */
  setFetchForTest(fetchImpl: typeof fetch): void {
    this.fetchImpl = fetchImpl;
  }

  /** Test seam: seed credentials directly. */
  persistForTest(credentials: StoredCredentials): void {
    this.store.saveCredentials("tesla", encryptJson(credentials, this.config.APP_SECRET));
  }

  createLoginUrl(): string {
    if (!this.config.TESLA_CLIENT_ID) {
      throw new Error("TESLA_CLIENT_ID is required for Tesla auth.");
    }
    const state = randomBytes(18).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.store.saveOauthState(`tesla:${state}`, codeVerifier);

    const url = new URL(this.config.TESLA_OAUTH_AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.TESLA_CLIENT_ID);
    url.searchParams.set("redirect_uri", this.config.TESLA_REDIRECT_URI);
    url.searchParams.set("scope", TESLA_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async completeCallback(query: { code?: string; state?: string }): Promise<void> {
    if (!query.code || !query.state) {
      throw new Error("Tesla callback is missing code or state.");
    }
    const codeVerifier = this.store.consumeOauthState(`tesla:${query.state}`);
    if (!codeVerifier) {
      throw new Error("Invalid or expired Tesla OAuth state.");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.TESLA_CLIENT_ID ?? "",
      code: query.code,
      redirect_uri: this.config.TESLA_REDIRECT_URI,
      code_verifier: codeVerifier
    });
    if (this.config.TESLA_CLIENT_SECRET) {
      form.set("client_secret", this.config.TESLA_CLIENT_SECRET);
    }
    const token = await this.exchange(form);
    this.save(token);
  }

  isConnected(): boolean {
    return Boolean(this.getCredentials());
  }

  disconnect(): void {
    this.store.deleteCredentials("tesla");
  }

  async getAccessToken(): Promise<string> {
    const credentials = this.getCredentials();
    if (!credentials) {
      throw new Error("Tesla is not connected.");
    }
    const expiresSoon =
      credentials.expiresAtIso && new Date(credentials.expiresAtIso).getTime() - Date.now() < 120_000;
    if (expiresSoon) {
      if (!credentials.refreshToken) {
        throw new Error("Tesla token expired and no refresh token is available.");
      }
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.config.TESLA_CLIENT_ID ?? "",
        refresh_token: credentials.refreshToken
      });
      if (this.config.TESLA_CLIENT_SECRET) {
        form.set("client_secret", this.config.TESLA_CLIENT_SECRET);
      }
      const token = await this.exchange(form);
      return this.save(token, credentials.refreshToken).accessToken;
    }
    return credentials.accessToken;
  }

  /** Partner (client-credentials) token for one-time partner-account registration. */
  async getPartnerToken(): Promise<string> {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.TESLA_CLIENT_ID ?? "",
      client_secret: this.config.TESLA_CLIENT_SECRET ?? "",
      scope: "openid vehicle_device_data vehicle_location",
      audience: this.config.TESLA_API_BASE_URL
    });
    const token = await this.exchange(form);
    return token.access_token;
  }

  /** Registers the signed fleet-telemetry config through tesla-http-proxy. Config write, no wake command. */
  async registerTelemetryConfig(opts: {
    caPem: string;
    hostname: string;
    port: number;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    const token = await this.getAccessToken();
    const vins = await this.resolveTelemetryVins(token);
    const body = JSON.stringify({
      vins,
      config: { hostname: opts.hostname, port: opts.port, ca: opts.caPem, fields: TELEMETRY_FIELDS }
    });
    const url = `${this.config.TESLA_COMMAND_PROXY_URL.replace(/\/$/, "")}/api/1/vehicles/fleet_telemetry_config`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }

  /**
   * Diagnostic: reports each vehicle's fleet status — crucially `key_paired_vins` (is our virtual key
   * on the car?), firmware version, and fleet-telemetry version. Read-only; uses the user token.
   * Discovers VINs via /api/1/vehicles, then POSTs them to /api/1/vehicles/fleet_status.
   */
  async getFleetStatus(): Promise<{ ok: boolean; status: number; body: string }> {
    const token = await this.getAccessToken();
    const base = this.config.TESLA_API_BASE_URL.replace(/\/$/, "");
    const listResponse = await this.fetchImpl(`${base}/api/1/vehicles`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!listResponse.ok) {
      return { ok: false, status: listResponse.status, body: await listResponse.text() };
    }
    const list = (await listResponse.json()) as { response?: Array<{ vin?: string }> };
    const vins = (list.response ?? []).map((vehicle) => vehicle.vin).filter((vin): vin is string => Boolean(vin));
    const response = await this.fetchImpl(`${base}/api/1/vehicles/fleet_status`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ vins })
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }

  /** Removes the fleet-telemetry config per VIN through tesla-http-proxy. */
  async deleteTelemetryConfig(): Promise<{ ok: boolean; status: number; body: string }> {
    const token = await this.getAccessToken();
    const vins = await this.resolveTelemetryVins(token);
    const base = this.config.TESLA_COMMAND_PROXY_URL.replace(/\/$/, "");
    const results: Array<{ vin: string; status: number; body: string }> = [];

    for (const vin of vins) {
      const response = await this.fetchImpl(`${base}/api/1/vehicles/${encodeURIComponent(vin)}/fleet_telemetry_config`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      results.push({ vin, status: response.status, body: await response.text() });
    }

    const failed = results.find((result) => result.status < 200 || result.status >= 300);
    return {
      ok: !failed,
      status: failed?.status ?? 200,
      body: JSON.stringify({ results })
    };
  }

  private async resolveTelemetryVins(accessToken: string): Promise<string[]> {
    if (this.config.teslaTelemetryVins.length > 0) {
      return this.config.teslaTelemetryVins;
    }

    const base = this.config.TESLA_API_BASE_URL.replace(/\/$/, "");
    const response = await this.fetchImpl(`${base}/api/1/vehicles`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      throw new Error(`Tesla vehicle discovery failed with ${response.status}: ${await response.text()}`);
    }
    const list = (await response.json()) as { response?: Array<{ vin?: string }> };
    const vins = (list.response ?? []).map((vehicle) => vehicle.vin).filter((vin): vin is string => Boolean(vin));
    if (vins.length === 0) {
      throw new Error("No Tesla VINs available for Fleet Telemetry registration.");
    }
    return vins;
  }

  private getCredentials(): StoredCredentials | undefined {
    const encrypted = this.store.getEncryptedCredentials("tesla");
    return encrypted ? decryptJson<StoredCredentials>(encrypted, this.config.APP_SECRET) : undefined;
  }

  private save(
    token: { access_token: string; refresh_token?: string; expires_in?: number },
    fallbackRefresh?: string
  ): StoredCredentials {
    const credentials: StoredCredentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? fallbackRefresh,
      expiresAtIso: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined
    };
    this.store.saveCredentials("tesla", encryptJson(credentials, this.config.APP_SECRET));
    return credentials;
  }

  private async exchange(
    form: URLSearchParams
  ): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const response = await this.fetchImpl(this.config.TESLA_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Tesla token request failed with ${response.status}: ${details}`);
    }
    return (await response.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  }
}
