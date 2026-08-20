import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord, ResolvedTrack } from "@longplay/core";
import { NoopOpenMusicClient } from "@longplay/open-music";
import { XaiSongScout } from "@longplay/recommendation";
import type { SpotifyAdapter, SpotifyPlaybackState, SpotifyPlaylist, SpotifyTrackSearchResult } from "@longplay/spotify";
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

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-playlist-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

function makeJourney(overrides: Partial<JourneyRecord> = {}): JourneyRecord {
  return {
    id: "j1",
    provider: "spotify",
    destination: "Lago di Garda",
    userPrompt: "golden hour",
    passengerMode: "couple",
    phase: "departure",
    status: "active",
    createdAtIso: new Date().toISOString(),
    ...overrides
  };
}

const track: ResolvedTrack = {
  provider: "spotify",
  providerTrackId: "t1",
  providerUri: "spotify:track:t1",
  artist: "M83",
  title: "Wait",
  matchConfidence: 0.94,
  matchReason: "x"
};

describe("journey playlist (store)", () => {
  it("persists and updates the spotify playlist id/url", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    expect(store.getJourney("j1")?.spotifyPlaylistId).toBeUndefined();

    store.updateJourneySpotifyPlaylist("j1", "pl1", "https://open.spotify.com/playlist/pl1");
    const journey = store.getJourney("j1");
    expect(journey?.spotifyPlaylistId).toBe("pl1");
    expect(journey?.spotifyPlaylistUrl).toBe("https://open.spotify.com/playlist/pl1");
  });

  it("tracks saved_to_playlist separately from addedToPlaylist", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    const id = store.saveResolvedTrack("j1", undefined, track);
    expect(store.listResolvedTracks("j1")[0].savedToPlaylist).toBe(false);

    store.markTracksSavedToPlaylist([id]);
    expect(store.listResolvedTracks("j1")[0].savedToPlaylist).toBe(true);
    // addedToPlaylist (buffer membership) is untouched by the playlist flag.
    expect(store.listResolvedTracks("j1")[0].addedToPlaylist).toBe(false);
  });
});

class PlaylistSpotifyAdapter implements SpotifyAdapter {
  createCalls: { name: string }[] = [];
  addCalls: { playlistId: string; uris: string[] }[] = [];

  async searchTracks(args: { query: string; market: string }): Promise<SpotifyTrackSearchResult[]> {
    const [artist, ...rest] = args.query.split(" - ");
    const title = rest.join(" - ") || artist;
    const id = `${artist}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return [{ id, uri: `spotify:track:${id}`, title, artist, isPlayable: true, market: args.market }];
  }
  async transferPlayback(): Promise<void> {}
  async resolvePlaybackDeviceId(args: { preferredDeviceId: string }): Promise<string> {
    return args.preferredDeviceId;
  }
  async skipToNext(): Promise<void> {}
  async skipToPrevious(): Promise<void> {}
  async startPlayback(): Promise<void> {}
  async addToQueue(): Promise<void> {}
  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    return { isPlaying: false, queuedProviderTrackIds: [] };
  }
  async createPlaylist(args: { name: string; description: string }): Promise<SpotifyPlaylist> {
    this.createCalls.push({ name: args.name });
    const id = `pl-${this.createCalls.length}`;
    return { id, name: args.name, url: `https://open.spotify.com/playlist/${id}` };
  }
  async addTracksToPlaylist(args: { playlistId: string; uris: string[] }): Promise<void> {
    this.addCalls.push({ playlistId: args.playlistId, uris: args.uris });
  }
}

function buildPlaylistService(adapter: SpotifyAdapter) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-playlist-svc-"));
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
  const service = new JourneyService(
    config,
    store,
    new TidalAuthService(config, store),
    new MockTidalAdapter(),
    new SpotifyAuthService(config, store),
    adapter,
    new XaiSongScout({ apiKey: config.XAI_API_KEY, baseUrl: config.XAI_BASE_URL, model: config.XAI_MODEL, mock: true }),
    new NoopOpenMusicClient()
  );
  return { service, store };
}

describe("journey playlist (service)", () => {
  it("creates a playlist and mirrors the curated tracks, without duplicating on re-analysis", async () => {
    const adapter = new PlaylistSpotifyAdapter();
    const { service, store } = buildPlaylistService(adapter);

    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "road trip",
      passengerMode: "solo",
      provider: "spotify"
    });

    // A private playlist was created, named for the destination, and stored on the journey.
    expect(adapter.createCalls.length).toBe(1);
    expect(adapter.createCalls[0].name).toContain("Dijon");
    expect(store.getJourney(journey.id)?.spotifyPlaylistId).toBe("pl-1");

    // The curated tracks were mirrored into the playlist.
    const addedUris = adapter.addCalls.flatMap((call) => call.uris);
    const curated = store.listResolvedTracks(journey.id).filter((trackRow) => trackRow.addedToPlaylist);
    expect(curated.length).toBeGreaterThan(0);
    expect(addedUris.length).toBe(curated.length);

    // Re-analysis must not re-add already-saved tracks.
    await service.analyzeJourney(journey.id, "manual");
    const allSavedUris = adapter.addCalls.flatMap((call) => call.uris);
    expect(new Set(allSavedUris).size).toBe(allSavedUris.length); // no duplicate uri ever added
  });
});
