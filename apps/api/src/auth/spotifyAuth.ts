import { createHash, randomBytes } from "node:crypto";

import { decryptJson, encryptJson } from "@longplay/crypto";

import type { AppConfig } from "../config/env.js";
import type { StoredCredentials, Store } from "../db/store.js";

export const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  // Reads the listener's top artists to personalize the soundtrack (familiarity↔discovery mix).
  "user-top-read",
  // Creates + extends the saved per-journey playlist.
  "playlist-modify-private"
] as const;

export interface SpotifyTokenStatus {
  accessToken: string;
  premium: boolean;
  expiresAtIso?: string;
}

export class SpotifyAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store
  ) {}

  createLoginUrl(): string {
    if (!this.config.SPOTIFY_CLIENT_ID) {
      throw new Error("SPOTIFY_CLIENT_ID is required for real Spotify auth.");
    }

    const state = randomBytes(18).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.store.saveOauthState(state, codeVerifier);

    const url = new URL(this.config.SPOTIFY_AUTHORIZATION_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.SPOTIFY_CLIENT_ID);
    url.searchParams.set("redirect_uri", this.config.SPOTIFY_REDIRECT_URI);
    url.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    return url.toString();
  }

  async completeCallback(query: { code?: string; state?: string }): Promise<void> {
    if (!query.code || !query.state) {
      throw new Error("Spotify callback is missing code or state.");
    }
    if (!this.config.SPOTIFY_CLIENT_ID) {
      throw new Error("SPOTIFY_CLIENT_ID is required.");
    }

    const codeVerifier = this.store.consumeOauthState(query.state);
    if (!codeVerifier) {
      throw new Error("Invalid or expired Spotify OAuth state.");
    }

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: query.code,
      redirect_uri: this.config.SPOTIFY_REDIRECT_URI,
      client_id: this.config.SPOTIFY_CLIENT_ID,
      code_verifier: codeVerifier
    });

    const token = await this.exchangeToken(form);
    await this.saveTokenPayload(token);
  }

  async getAccessToken(): Promise<string> {
    if (this.config.SPOTIFY_MOCK) {
      return "mock-spotify-access-token";
    }

    const credentials = this.getCredentials();
    if (!credentials) {
      throw new Error("Spotify is not connected.");
    }

    if (credentials.expiresAtIso && new Date(credentials.expiresAtIso).getTime() - Date.now() < 120_000) {
      if (!credentials.refreshToken) {
        throw new Error("Spotify credentials expired and no refresh token is available.");
      }
      return this.refresh(credentials).then((next) => next.accessToken);
    }

    return credentials.accessToken;
  }

  async getTokenStatus(): Promise<SpotifyTokenStatus> {
    const accessToken = await this.getAccessToken();
    if (this.config.SPOTIFY_MOCK) {
      return {
        accessToken,
        premium: true,
        expiresAtIso: new Date(Date.now() + 3_600_000).toISOString()
      };
    }

    const credentials = this.getCredentials();
    return {
      accessToken,
      premium: await this.isPremium(),
      expiresAtIso: credentials?.expiresAtIso
    };
  }

  async isPremium(): Promise<boolean> {
    if (this.config.SPOTIFY_MOCK) {
      return true;
    }

    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.config.SPOTIFY_API_BASE_URL.replace(/\/$/, "")}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      return false;
    }

    const profile = (await response.json()) as { product?: string };
    return profile.product === "premium";
  }

  isConnected(): boolean {
    return this.config.SPOTIFY_MOCK || Boolean(this.getCredentials());
  }

  disconnect(): void {
    this.store.deleteCredentials("spotify");
  }

  private async saveTokenPayload(token: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }): Promise<void> {
    const credentials: StoredCredentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAtIso: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined
    };
    this.store.saveCredentials("spotify", encryptJson(credentials, this.config.APP_SECRET));
  }

  private getCredentials(): StoredCredentials | undefined {
    const encrypted = this.store.getEncryptedCredentials("spotify");
    return encrypted ? decryptJson<StoredCredentials>(encrypted, this.config.APP_SECRET) : undefined;
  }

  private async refresh(credentials: StoredCredentials): Promise<StoredCredentials> {
    if (!this.config.SPOTIFY_CLIENT_ID || !credentials.refreshToken) {
      throw new Error("Cannot refresh Spotify credentials without client id and refresh token.");
    }

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      client_id: this.config.SPOTIFY_CLIENT_ID
    });

    const token = await this.exchangeToken(form);
    const next: StoredCredentials = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? credentials.refreshToken,
      expiresAtIso: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined,
      userId: credentials.userId
    };
    this.store.saveCredentials("spotify", encryptJson(next, this.config.APP_SECRET));
    return next;
  }

  private async exchangeToken(form: URLSearchParams): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded"
    };

    if (this.config.SPOTIFY_CLIENT_ID && this.config.SPOTIFY_CLIENT_SECRET) {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.config.SPOTIFY_CLIENT_ID}:${this.config.SPOTIFY_CLIENT_SECRET}`
      ).toString("base64")}`;
    }

    const response = await fetch(this.config.SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers,
      body: form
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Spotify token request failed with ${response.status}: ${details}`);
    }

    return (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
  }
}
