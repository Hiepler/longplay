import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoopOpenMusicClient } from "@longplay/open-music";
import type { NormalizedTelemetryEvent, SongCandidate } from "@longplay/core";
import type { SongScout } from "@longplay/recommendation";
import { MockSpotifyAdapter } from "@longplay/spotify";
import { MockTidalAdapter } from "@longplay/tidal";
import { afterEach, describe, expect, it } from "vitest";

import { SpotifyAuthService } from "../src/auth/spotifyAuth.js";
import { TidalAuthService } from "../src/auth/tidalAuth.js";
import { loadConfig } from "../src/config/env.js";
import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";
import { JourneyService } from "../src/journeys/journeyService.js";
import type { TeslaLiveReader } from "../src/telemetry/teslaFleetPoller.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Deterministic fallback kicks in when the scout fails, so a journey still starts successfully —
// which lets us assert that seeding does NOT change that outcome either way.
class ThrowingScout implements SongScout {
  async generateCandidates(): Promise<SongCandidate[]> {
    throw new Error("scout offline");
  }
}

function buildService() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-seed-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "false",
    CORS_ORIGIN: "http://localhost:5173"
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
    new ThrowingScout(),
    new NoopOpenMusicClient()
  );
  return { service, store };
}

const startInput = {
  destination: "Dijon",
  userPrompt: "cinematic golden-hour drive",
  passengerMode: "couple" as const,
  provider: "spotify" as const,
  deviceId: "tesla-web-device"
};

describe("first-queue live telemetry seed", () => {
  it("creates the journey even when the live reader throws (never aborts startJourney)", async () => {
    const { service, store } = buildService();
    const throwingReader: TeslaLiveReader = {
      available: () => true,
      read: async () => {
        throw new Error("read failed");
      }
    };
    service.setLiveTelemetryReader(throwingReader);

    const journey = await service.startJourney(startInput);

    expect(journey.status).toBe("active");
    expect(store.getJourney(journey.id)?.status).toBe("active");
  });

  it("seeds the journey with a live reading so the first queue sees real ETA/region", async () => {
    const { service, store } = buildService();
    const event: NormalizedTelemetryEvent = {
      timestampIso: new Date().toISOString(),
      etaMinutes: 95,
      coarseRegion: "Burgundy, France",
      speedKph: 100
    };
    const seedReader: TeslaLiveReader = {
      available: () => true,
      read: async () => event
    };
    service.setLiveTelemetryReader(seedReader);

    const journey = await service.startJourney(startInput);

    // ETA captured as the planned trip duration, and the reading persisted before the first analyze.
    expect(store.getJourney(journey.id)?.plannedDurationMinutes).toBe(95);
    expect(store.latestTelemetry(journey.id)?.coarseRegion).toBe("Burgundy, France");
  });

  it("does not seed (and never reads) when the reader is unavailable", async () => {
    const { service, store } = buildService();
    let reads = 0;
    const idleReader: TeslaLiveReader = {
      available: () => false,
      read: async () => {
        reads += 1;
        return undefined;
      }
    };
    service.setLiveTelemetryReader(idleReader);

    const journey = await service.startJourney(startInput);

    expect(reads).toBe(0);
    expect(store.getJourney(journey.id)?.plannedDurationMinutes).toBeUndefined();
  });
});
