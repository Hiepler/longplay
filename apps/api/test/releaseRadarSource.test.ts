import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord, SongCandidate } from "@longplay/core";
import { NoopOpenMusicClient } from "@longplay/open-music";
import {
  LastfmChartClient,
  type SongScout,
} from "@longplay/recommendation";
import { MockSpotifyAdapter } from "@longplay/spotify";
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
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class NoopScout implements SongScout {
  async generateCandidates(): Promise<SongCandidate[]> {
    return [];
  }
}

function makeJourney(): JourneyRecord {
  return {
    id: "journey-radar",
    provider: "spotify",
    destination: "Lago di Garda",
    userPrompt: "indie chill",
    passengerMode: "solo",
    phase: "departure",
    status: "active",
    tasteWeight: 0.4,
    createdAtIso: new Date().toISOString(),
  };
}

function buildService() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-radar-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "false",
    LASTFM_API_KEY: "test-lastfm-key",
    CORS_ORIGIN: "http://localhost:5173",
    LASTFM_ENABLED: "false",
    FRESH_WINDOW_DAYS: "365",
    SPOTIFY_FRESH_ENABLED: "true",
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const lastfmCharts = new LastfmChartClient({
    apiKey: "test-lastfm-key",
    baseUrl: "https://lastfm.test/2.0/",
    fetchImpl: async () =>
      new Response(JSON.stringify({ tracks: { track: [] } }), { status: 200 }),
  });
  const service = new JourneyService(
    config,
    store,
    new TidalAuthService(config, store),
    new MockTidalAdapter(),
    new SpotifyAuthService(config, store),
    new MockSpotifyAdapter(),
    new NoopScout(),
    new NoopOpenMusicClient(),
    lastfmCharts,
  );
  return { service, store };
}

describe("release-radar source", () => {
  it("surfaces spotify-fresh release-radar candidates for a journey", async () => {
    const { service, store } = buildService();
    const journey = makeJourney();
    store.createJourney(journey);
    store.saveTelemetry(
      journey.id,
      {
        timestampIso: "2026-06-03T18:00:00.000Z",
        coarseRegion: "Bavaria, Germany",
        countryName: "Germany",
        countryCode: "DE",
        geoSource: "reverse-geocode",
        destination: "Lago di Garda",
        etaMinutes: 180,
        speedKph: 92,
        outsideTempC: 24,
      },
      "departure",
    );

    await service.analyzeJourney(journey.id, "manual");

    const detailed = store.listResolvedTracksDetailed(journey.id);
    expect(detailed.some((t) => t.candidateLens === "release-radar")).toBe(
      true,
    );
  });
});
