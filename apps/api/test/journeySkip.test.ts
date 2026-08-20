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
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class SkipSpotifyAdapter implements SpotifyAdapter {
  startCalls: { uris: string[] }[] = [];

  async searchTracks(args: { query: string; market: string }): Promise<SpotifyTrackSearchResult[]> {
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
        market: args.market
      }
    ];
  }

  async transferPlayback(): Promise<void> {}
  async resolvePlaybackDeviceId(args: { preferredDeviceId: string }): Promise<string> {
    return args.preferredDeviceId;
  }
  async skipToNext(): Promise<void> {}
  async skipToPrevious(): Promise<void> {}
  async startPlayback(args: { deviceId: string; uris: string[] }): Promise<void> {
    this.startCalls.push({ uris: args.uris });
  }
  async addToQueue(): Promise<void> {}
  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    return { isPlaying: true, queuedProviderTrackIds: [] };
  }
}

function buildService(adapter: SpotifyAdapter) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-skip-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
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
      adapter,
      new XaiSongScout({ apiKey: config.XAI_API_KEY, baseUrl: config.XAI_BASE_URL, model: config.XAI_MODEL, mock: true }),
      new NoopOpenMusicClient()
    ),
    store
  };
}

describe("spotify track skip", () => {
  // Skips run a real playback sync incl. paced device-queue top-ups → allow 15s.
  it("advances the journey queue and records play history on next", { timeout: 15_000 }, async () => {
    const adapter = new SkipSpotifyAdapter();
    const { service, store } = buildService(adapter);

    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "road trip",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "web-device"
    });

    const before = store.getPlaybackSession(journey.id);
    const activeId = before?.activeTrack?.id;
    const nextId = before?.queuedTrackIds[0];
    expect(activeId).toBeTruthy();
    expect(nextId).toBeTruthy();

    adapter.startCalls.length = 0;
    const after = await service.skipSpotifyTrack(journey.id, "next", "web-device");
    // Authoritative skip: Spotify is told to play EXACTLY the track now shown as active —
    // and nothing else. A multi-track context gets preempted by previously queued items
    // (Spotify plays its manual queue before the context remainder), which is what made the
    // played track diverge from the shown track on real drives. The upcoming order lives in
    // the device queue, topped up separately.
    expect(adapter.startCalls.at(-1)?.uris[0]).toBe(after.activeTrack?.providerUri);
    expect(adapter.startCalls.at(-1)?.uris).toHaveLength(1);
    expect(after.activeTrack?.id).toBe(nextId);
    expect(after.playedTrackIds).toContain(activeId);
    expect(after.queuedTrackIds[0]).not.toBe(nextId);
  });

  it("never re-surfaces an already-played song when advancing", async () => {
    const adapter = new SkipSpotifyAdapter();
    const { service, store } = buildService(adapter);

    // No device: skips the real playback-sync timers, so the test stays fast and deterministic
    // while still exercising the candidate selection / consumed-set logic under test.
    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "road trip",
      passengerMode: "solo",
      provider: "spotify"
    });

    const actives: string[] = [];
    const first = store.getPlaybackSession(journey.id);
    if (first?.activeTrack?.id) actives.push(first.activeTrack.id);

    // Advance well past the initial buffer so the engine must refill at least once.
    for (let i = 0; i < 7; i += 1) {
      const session = await service.skipSpotifyTrack(journey.id, "next", undefined);
      // Force a deterministic refill before the next skip (fire-and-forget low-buffer otherwise).
      await service.analyzeJourney(journey.id, "manual");
      if (session.activeTrack?.id) actives.push(session.activeTrack.id);
    }

    // No song is ever heard twice in a journey.
    expect(new Set(actives).size).toBe(actives.length);
  });

  it("restores the previous track from journey history", { timeout: 15_000 }, async () => {
    const adapter = new SkipSpotifyAdapter();
    const { service, store } = buildService(adapter);

    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "road trip",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "web-device"
    });

    const first = store.getPlaybackSession(journey.id);
    const firstActiveId = first?.activeTrack?.id;
    await service.skipSpotifyTrack(journey.id, "next", "web-device");
    adapter.startCalls.length = 0;
    const restored = await service.skipSpotifyTrack(journey.id, "previous", "web-device");

    // Authoritative skip-back: Spotify is told to play the exact restored track.
    expect(adapter.startCalls.at(-1)?.uris[0]).toBe(restored.activeTrack?.providerUri);
    expect(restored.activeTrack?.id).toBe(firstActiveId);
    expect(restored.playedTrackIds ?? []).not.toContain(firstActiveId);
  });
});
