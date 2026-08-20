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
    id: "journey-lastfm",
    provider: "spotify",
    destination: "Lago di Garda",
    userPrompt: "family good mood pop",
    passengerMode: "family",
    phase: "departure",
    status: "active",
    tasteWeight: 0.4,
    createdAtIso: new Date().toISOString(),
  };
}

function buildService() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-lastfm-"));
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
    // Isolate this test to Last.fm charts only — fresh radar is tested separately.
    SPOTIFY_FRESH_ENABLED: "false",
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const lastfmCharts = new LastfmChartClient({
    apiKey: "test-lastfm-key",
    baseUrl: "https://lastfm.test/2.0/",
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const method = url.searchParams.get("method");
      if (method === "artist.getTopTracks") {
        const artist = url.searchParams.get("artist") ?? "Artist";
        return new Response(
          JSON.stringify({
            toptracks: {
              track: [
                {
                  name: `${artist} Signature`,
                  "@attr": { rank: "1" },
                  artist: { name: artist },
                },
                {
                  name: `${artist} Second`,
                  "@attr": { rank: "2" },
                  artist: { name: artist },
                },
                {
                  name: `${artist} Third`,
                  "@attr": { rank: "3" },
                  artist: { name: artist },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (method === "geo.getTopTracks") {
        return new Response(
          JSON.stringify({
            tracks: {
              track: [
                {
                  name: "Flowers",
                  playcount: "2500000",
                  "@attr": { rank: "1" },
                  artist: { name: "Miley Cyrus" },
                },
                {
                  name: "As It Was",
                  playcount: "2400000",
                  "@attr": { rank: "2" },
                  artist: { name: "Harry Styles" },
                },
                {
                  name: "Levitating",
                  playcount: "2200000",
                  "@attr": { rank: "3" },
                  artist: { name: "Dua Lipa" },
                },
                {
                  name: "Happy",
                  playcount: "1900000",
                  "@attr": { rank: "4" },
                  artist: { name: "Pharrell Williams" },
                },
                {
                  name: "Can't Stop the Feeling!",
                  playcount: "1800000",
                  "@attr": { rank: "5" },
                  artist: { name: "Justin Timberlake" },
                },
                {
                  name: "Uptown Funk",
                  playcount: "1700000",
                  "@attr": { rank: "6" },
                  artist: { name: "Mark Ronson" },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ tracks: { track: [] } }), {
        status: 200,
      });
    },
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

describe("Last.fm chart-driven journey recommendations", () => {
  it("uses current-country Last.fm chart candidates to shape a family Spotify queue", async () => {
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

    const tracks = store.listResolvedTracks(journey.id);
    const session = store.getPlaybackSession(journey.id);
    const activeAndQueued = [
      session?.activeTrack,
      ...(session?.queuedTrackIds ?? []).map((id) =>
        tracks.find((track) => track.id === id),
      ),
    ].filter((track): track is NonNullable<typeof track> => Boolean(track));
    const artists = new Set(activeAndQueued.map((track) => track.artist));

    expect(activeAndQueued.map((track) => track.title)).toContain("Flowers");
    expect(activeAndQueued.every((track) => track.explicit === false)).toBe(
      true,
    );
    expect(artists.size).toBeGreaterThanOrEqual(5);
    expect(
      tracks.filter(
        (track) =>
          track.chartSource === "lastfm-geo" &&
          track.chartCountry === "Germany",
      ).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("opens with a best-fit taste anchor chosen across several favorite artists", async () => {
    const { service, store } = buildService();
    // Seed the listener's taste so the opening anchor fires with real favorites.
    store.saveCachedTasteProfile("local", {
      topGenres: ["pop", "indie"],
      representativeArtists: ["Miley Cyrus", "Harry Styles", "Dua Lipa"],
    });
    const journey: JourneyRecord = {
      id: "journey-anchor",
      provider: "spotify",
      destination: "Lago di Garda",
      userPrompt: "evening drive",
      passengerMode: "couple",
      phase: "departure",
      status: "active",
      tasteWeight: 0.4,
      createdAtIso: new Date().toISOString(),
    };
    store.createJourney(journey);
    store.saveTelemetry(
      journey.id,
      {
        timestampIso: "2026-06-03T18:00:00.000Z",
        coarseRegion: "Bavaria",
        destination: "Lago di Garda",
        etaMinutes: 180,
        speedKph: 92,
        outsideTempC: 24,
      },
      "departure",
    );

    await service.analyzeJourney(journey.id, "initial");

    // Several signature options were surfaced across distinct favorites — not one fixed #1 — so
    // the ranker had a real best-fit choice for this drive.
    const detailed = store.listResolvedTracksDetailed(journey.id);
    const anchors = detailed.filter(
      (track) => track.candidateLens === "taste-anchor:opening",
    );
    const anchorArtists = new Set(anchors.map((track) => track.artist));
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    expect(anchorArtists.size).toBeGreaterThanOrEqual(2);
    for (const artist of anchorArtists) {
      expect(["Miley Cyrus", "Harry Styles", "Dua Lipa"]).toContain(artist);
    }

    // The opener that actually plays is one of the favorites' signature tracks.
    const session = store.getPlaybackSession(journey.id);
    expect(session?.activeTrack?.artist).toBeDefined();
    expect(["Miley Cyrus", "Harry Styles", "Dua Lipa"]).toContain(
      session?.activeTrack?.artist,
    );
  });
});
