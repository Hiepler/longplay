import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoopOpenMusicClient } from "@longplay/open-music";
import type { SongCandidate } from "@longplay/core";
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

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class MalformedJsonScout implements SongScout {
  async generateCandidates(): Promise<SongCandidate[]> {
    throw new SyntaxError("Expected ',' or '}' after property value in JSON at position 397 (line 9 column 20)");
  }
}

function buildService() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-analysis-fallback-"));
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
  return {
    service: new JourneyService(
      config,
      store,
      new TidalAuthService(config, store),
      new MockTidalAdapter(),
      new SpotifyAuthService(config, store),
      new MockSpotifyAdapter(),
      new MalformedJsonScout(),
      new NoopOpenMusicClient()
    ),
    store
  };
}

describe("analysis fallback", () => {
  it("uses deterministic candidates when model JSON parsing fails", async () => {
    const { service, store } = buildService();

    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "cinematic golden-hour drive",
      passengerMode: "couple",
      provider: "spotify",
      deviceId: "tesla-web-device"
    });

    const tracks = store.listResolvedTracks(journey.id);
    const update = store.latestPlaylistUpdate(journey.id);
    const events = store.auditEvents(journey.id);

    expect(tracks.length).toBeGreaterThanOrEqual(5);
    expect(update).toMatchObject({ provider: "spotify", status: expect.stringMatching(/success|degraded/) });
    expect(events.some((event) => event.type === "recommendation.scout_failed")).toBe(true);
  });
});
