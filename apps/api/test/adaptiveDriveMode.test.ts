import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoopOpenMusicClient } from "@longplay/open-music";
import { XaiSongScout } from "@longplay/recommendation";
import type { SpotifyAdapter, SpotifyPlaybackState, SpotifyTrackSearchResult } from "@longplay/spotify";
import { MockTidalAdapter } from "@longplay/tidal";
import { afterEach, describe, expect, it } from "vitest";

import { SpotifyAuthService } from "../src/auth/spotifyAuth.js";
import { TidalAuthService } from "../src/auth/tidalAuth.js";
import { loadConfig } from "../src/config/env.js";
import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";
import { JourneyService } from "../src/journeys/journeyService.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class MockAdapter implements SpotifyAdapter {
  async searchTracks(args: { query: string; market: string }): Promise<SpotifyTrackSearchResult[]> {
    const [artist, ...rest] = args.query.split(" - ");
    const title = rest.join(" - ") || artist;
    const id = `${artist}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return [
      { id, uri: `spotify:track:${id}`, title, artist, isPlayable: true, market: args.market, externalUrl: `https://x/${id}`, albumArtUrl: `https://img/${id}` }
    ];
  }
  async transferPlayback(): Promise<void> {}
  async resolvePlaybackDeviceId(args: { preferredDeviceId: string }): Promise<string> { return args.preferredDeviceId; }
  async skipToNext(): Promise<void> {}
  async skipToPrevious(): Promise<void> {}
  async startPlayback(): Promise<void> {}
  async addToQueue(): Promise<void> {}
  async getPlaybackState(): Promise<SpotifyPlaybackState> { return { isPlaying: false, queuedProviderTrackIds: [] }; }
}

function buildService(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-adm-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173",
    ...overrides
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const service = new JourneyService(
    config,
    store,
    new TidalAuthService(config, store),
    new MockTidalAdapter(),
    new SpotifyAuthService(config, store),
    new MockAdapter(),
    new XaiSongScout({ apiKey: config.XAI_API_KEY, baseUrl: config.XAI_BASE_URL, model: config.XAI_MODEL, mock: true }),
    new NoopOpenMusicClient()
  );
  return { service, store };
}

async function startJourney(service: JourneyService) {
  return service.startJourney({
    destination: "Dijon",
    userPrompt: "cinematic drive",
    passengerMode: "solo",
    provider: "spotify",
    deviceId: "tesla-web-device"
  });
}

describe("Adaptive Drive Mode (service integration)", () => {
  it("engages calm only after the trigger holds for two telemetry polls (hysteresis)", async () => {
    const { service, store } = buildService();
    const journey = await startJourney(service);

    // First heavy-traffic poll → not engaged yet (history unknown).
    await service.ingestTelemetry({ timestampIso: "2026-06-01T14:00:00.000Z", speedKph: 15, trafficDelayMinutes: 14 });
    expect(store.getJourney(journey.id)?.driveMode ?? "neutral").toBe("neutral");

    // Second consecutive heavy-traffic poll → calm engages.
    await service.ingestTelemetry({ timestampIso: "2026-06-01T14:01:00.000Z", speedKph: 12, trafficDelayMinutes: 16 });
    expect(store.getJourney(journey.id)?.driveMode).toBe("calm");
  });

  it("surfaces the engaged mode + reason in the journey context", async () => {
    const { service, store } = buildService();
    const journey = await startJourney(service);
    await service.ingestTelemetry({ timestampIso: "2026-06-01T14:00:00.000Z", speedKph: 15, trafficDelayMinutes: 14 });
    await service.ingestTelemetry({ timestampIso: "2026-06-01T14:01:00.000Z", speedKph: 12, trafficDelayMinutes: 16 });

    const { contextFromJourney } = await import("../src/db/store.js");
    const ctx = contextFromJourney(
      store.getJourney(journey.id)!,
      store.latestTelemetry(journey.id),
      store.recentTelemetry(journey.id)
    );
    expect(ctx.driveState?.mode).toBe("calm");
    expect(ctx.driveState?.reason).toContain("traffic");
  });

  it("does not engage when the per-journey toggle is off", async () => {
    const { service, store } = buildService();
    const journey = await startJourney(service);
    await service.setAdaptiveMode(journey.id, false);

    await service.ingestTelemetry({ timestampIso: "2026-06-01T14:00:00.000Z", speedKph: 15, trafficDelayMinutes: 14 });
    await service.ingestTelemetry({ timestampIso: "2026-06-01T14:01:00.000Z", speedKph: 12, trafficDelayMinutes: 16 });
    expect(store.getJourney(journey.id)?.driveMode ?? "neutral").toBe("neutral");
  });

  it("does not engage when globally disabled", async () => {
    const { service, store } = buildService({ ADAPTIVE_DRIVE_MODE_ENABLED: "false" });
    const journey = await startJourney(service);
    await service.ingestTelemetry({ timestampIso: "2026-06-01T14:00:00.000Z", speedKph: 15, trafficDelayMinutes: 14 });
    await service.ingestTelemetry({ timestampIso: "2026-06-01T14:01:00.000Z", speedKph: 12, trafficDelayMinutes: 16 });
    expect(store.getJourney(journey.id)?.driveMode ?? "neutral").toBe("neutral");
  });
});
