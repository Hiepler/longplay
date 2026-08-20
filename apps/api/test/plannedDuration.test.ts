import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord } from "@longplay/core";
import { NoopOpenMusicClient } from "@longplay/open-music";
import { XaiSongScout } from "@longplay/recommendation";
import type {
  SpotifyAdapter,
  SpotifyPlaybackState,
  SpotifyTrackSearchResult,
} from "@longplay/spotify";
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
  for (const dir of tmpDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-planned-duration-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

class MockSpotifyAdapter implements SpotifyAdapter {
  async searchTracks(args: {
    query: string;
    market: string;
  }): Promise<SpotifyTrackSearchResult[]> {
    const [artist, ...rest] = args.query.split(" - ");
    const title = rest.join(" - ") || artist;
    const id = `${artist}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return [
      {
        id,
        uri: `spotify:track:${id}`,
        title,
        artist,
        isPlayable: true,
        market: args.market,
        externalUrl: `https://x/${id}`,
        albumArtUrl: `https://img/${id}`,
      },
    ];
  }
  async transferPlayback(): Promise<void> {}
  async resolvePlaybackDeviceId(args: {
    preferredDeviceId: string;
  }): Promise<string> {
    return args.preferredDeviceId;
  }
  async skipToNext(): Promise<void> {}
  async skipToPrevious(): Promise<void> {}
  async startPlayback(): Promise<void> {}
  async addToQueue(): Promise<void> {}
  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    return { isPlaying: false, queuedProviderTrackIds: [] };
  }
}

function buildService() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-planned-duration-svc-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173",
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
    new MockSpotifyAdapter(),
    new XaiSongScout({
      apiKey: config.XAI_API_KEY,
      baseUrl: config.XAI_BASE_URL,
      model: config.XAI_MODEL,
      mock: true,
    }),
    new NoopOpenMusicClient(),
  );
  return { service, store };
}

describe("plannedDuration (store)", () => {
  it("snapshots planned duration once and exposes it on the journey", () => {
    const store = freshStore();
    store.createJourney({
      id: "j1",
      provider: "spotify",
      destination: "Lake",
      userPrompt: "road trip",
      passengerMode: "solo",
      phase: "departure",
      status: "active",
      createdAtIso: new Date().toISOString(),
    } as JourneyRecord);

    store.setPlannedDurationMinutes("j1", 180);
    store.setPlannedDurationMinutes("j1", 999); // must NOT overwrite

    const journey = store.getJourney("j1");
    expect(journey?.plannedDurationMinutes).toBe(180);
  });
});

describe("plannedDuration (service via ingestTelemetry)", () => {
  it("snapshots etaMinutes from the first telemetry event and ignores later values", async () => {
    const { service, store } = buildService();
    const journey = await service.startJourney({
      destination: "Lago di Garda",
      userPrompt: "scenic drive",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "test-device",
    });

    // First ingest: etaMinutes should be snapshotted as plannedDurationMinutes.
    await service.ingestTelemetry({
      timestampIso: "2026-06-01T10:00:00.000Z",
      etaMinutes: 120,
    });
    expect(store.getJourney(journey.id)?.plannedDurationMinutes).toBe(120);

    // Second ingest with different etaMinutes: snapshot must NOT change.
    await service.ingestTelemetry({
      timestampIso: "2026-06-01T10:05:00.000Z",
      etaMinutes: 95,
    });
    expect(store.getJourney(journey.id)?.plannedDurationMinutes).toBe(120);
  });

  it("does not snapshot when etaMinutes is absent", async () => {
    const { service, store } = buildService();
    const journey = await service.startJourney({
      destination: "Munich",
      userPrompt: "city drive",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "test-device",
    });

    await service.ingestTelemetry({
      timestampIso: "2026-06-01T10:00:00.000Z",
      speedKph: 80,
    });
    expect(store.getJourney(journey.id)?.plannedDurationMinutes).toBeUndefined();
  });
});
