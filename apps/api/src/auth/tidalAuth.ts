import { createHash, randomBytes } from "node:crypto";

import { decryptJson, encryptJson } from "@longplay/crypto";

import type { AppConfig } from "../config/env.js";
import type { StoredCredentials, Store } from "../db/store.js";

const TIDAL_SCOPES = [
  "playlists.read",
  "playlists.write",
  "collection.read",
  "collection.write",
  "user.read",
  "search.read"
];

export class TidalAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store
  ) {}

  createLoginUrl(): string {
    if (!this.config.TIDAL_CLIENT_ID) {
      throw new Error("TIDAL_CLIENT_ID is required for real TIDAL auth.");
    }

    const state = randomBytes(18).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.store.saveOauthState(state, codeVerifier);

    const url = new URL(this.config.TIDAL_AUTHORIZATION_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.TIDAL_CLIENT_ID);
    url.searchParams.set("redirect_uri", this.config.TIDAL_REDIRECT_URI);
    url.searchParams.set("scope", TIDAL_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    return url.toString();
  }

  async completeCallback(query: { code?: string; state?: string }): Promise<void> {
    if (!query.code || !query.state) {
      throw new Error("TIDAL callback is missing code or state.");
    }
    if (!this.config.TIDAL_CLIENT_ID) {
      throw new Error("TIDAL_CLIENT_ID is required.");
    }

    const codeVerifier = this.store.consumeOauthState(query.state);
    if (!codeVerifier) {
      throw new Error("Invalid or expired TIDAL OAuth state.");
    }

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: query.code,
      redirect_uri: this.config.TIDAL_REDIRECT_URI,
      client_id: this.config.TIDAL_CLIENT_ID,
      code_verifier: codeVerifier
    });

    const token = await this.exchangeToken(form);
    const tokenPayload = token as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      user_id?: string;
    };

    this.saveCredentials({
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token,
      expiresAtIso: tokenPayload.expires_in
        ? new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString()
        : undefined,
      userId: tokenPayload.user_id
    });
  }

  async getAccessToken(): Promise<string> {
    if (this.config.TIDAL_MOCK) {
      return "mock-access-token";
    }

    const credentials = this.getCredentials();
    if (!credentials) {
      throw new Error("TIDAL is not connected.");
    }

    if (credentials.expiresAtIso && new Date(credentials.expiresAtIso).getTime() - Date.now() < 120_000) {
      if (!credentials.refreshToken) {
        throw new Error("TIDAL credentials expired and no refresh token is available.");
      }
      return this.refresh(credentials).then((next) => next.accessToken);
    }

    return credentials.accessToken;
  }

  isConnected(): boolean {
    return this.config.TIDAL_MOCK || Boolean(this.getCredentials());
  }

  disconnect(): void {
    this.store.deleteCredentials("tidal");
  }

  private saveCredentials(credentials: StoredCredentials): void {
    this.store.saveCredentials("tidal", encryptJson(credentials, this.config.APP_SECRET));
  }

  private getCredentials(): StoredCredentials | undefined {
    const encrypted = this.store.getEncryptedCredentials("tidal");
    return encrypted ? decryptJson<StoredCredentials>(encrypted, this.config.APP_SECRET) : undefined;
  }

  private async refresh(credentials: StoredCredentials): Promise<StoredCredentials> {
    if (!this.config.TIDAL_CLIENT_ID || !credentials.refreshToken) {
      throw new Error("Cannot refresh TIDAL credentials without client id and refresh token.");
    }

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken
    });

    const token = await this.exchangeToken(form);
    const tokenPayload = token as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      user_id?: string;
    };

    const next: StoredCredentials = {
      accessToken: tokenPayload.access_token,
      refreshToken: tokenPayload.refresh_token ?? credentials.refreshToken,
      expiresAtIso: tokenPayload.expires_in
        ? new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString()
        : undefined,
      userId: tokenPayload.user_id ?? credentials.userId
    };
    this.saveCredentials(next);
    return next;
  }

  private async exchangeToken(form: URLSearchParams): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    user_id?: string;
  }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded"
    };

    if (this.config.TIDAL_CLIENT_ID && this.config.TIDAL_CLIENT_SECRET) {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.config.TIDAL_CLIENT_ID}:${this.config.TIDAL_CLIENT_SECRET}`
      ).toString("base64")}`;
    }

    const response = await fetch(this.config.TIDAL_TOKEN_URL, {
      method: "POST",
      headers,
      body: form
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`TIDAL token request failed with ${response.status}: ${details}`);
    }

    return (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      user_id?: string;
    };
  }
}
