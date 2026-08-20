import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord, SongCandidate } from "@longplay/core";
import { NoopOpenMusicClient } from "@longplay/open-music";
import {
  LastfmChartClient,
  type SongScout,
} from "@longplay/recommendation";
import {
  MockSpotifyAdapter,
  type SpotifyArtist,
  type SpotifyTrackSearchResult,
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
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class NoopScout implements SongScout {
  async generateCandidates(): Promise<SongCandidate[]> {
    return [];
  }
}

/**
 * Custom Spotify adapter for freshness-quota testing.
 *
 * Design choices that make the quota loop the *decisive* factor:
 *
 * 1. searchTracks() strips releaseDate from results so the resolver falls back to
 *    the SongCandidate's own releaseDate via the `?? candidate.releaseDate` path:
 *      • release-radar candidates (releaseDate ≈ 11 days ago)  → isFresh = true
 *      • geo-chart candidates    (no SongCandidate releaseDate) → isFresh = false
 *
 * 2. getTopArtists() returns exactly 2 taste artists (not the default 5) so that:
 *      • only 2 release-radar tracks are generated (one fresh album per artist)
 *      • plus the 1 "Chart Newcomer" from getNewReleases = 3 fresh candidates total
 *      • combined with 6 geo-chart candidates → 9 candidates, all within the
 *        resolver's 10-track limit, so all chart tracks actually get resolved
 *
 * 3. DRIVE_STORY_ENABLED is disabled in buildService to suppress the opening
 *    taste-anchor candidates that would otherwise consume resolver slots before
 *    the chart tracks, pushing chart tracks past the resolve limit.
 *
 * With all of the above, without the quota loop the 6 high-chartSignal geo tracks
 * fill the entire 5-slot queue; WITH the loop ≥2 fresh release-radar tracks are
 * forced in — making the test genuinely falsifiable.
 */
class FreshnessTestSpotifyAdapter extends MockSpotifyAdapter {
  /** Strip releaseDate so the resolver uses the candidate's own date. */
  override async searchTracks(args: {
    accessToken: string;
    query: string;
    market: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<SpotifyTrackSearchResult[]> {
    const results = await super.searchTracks(args);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return results.map(({ releaseDate: _releaseDate, ...rest }) => rest);
  }

  /** Limit to 2 taste artists so the resolver slot budget fits the chart tracks. */
  override async getTopArtists(args?: {
    accessToken: string;
    timeRange?: "short_term" | "medium_term" | "long_term";
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyArtist[]> {
    const all = await super.getTopArtists(args);
    return all.slice(0, 2);
  }
}

function makeJourney(): JourneyRecord {
  return {
    id: "journey-freshness",
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

function buildService(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-freshness-"));
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
    LASTFM_ENABLED: "true",
    SPOTIFY_FRESH_ENABLED: "true",
    FRESH_QUOTA_MIN: "2",
    FRESH_WINDOW_DAYS: "365",
    // Disable the opening taste-anchor so it doesn't consume resolver slots
    // before the geo-chart tracks (the resolver limit is 10; anchors + fresh
    // would push chart tracks past that limit, leaving nothing to defeat).
    DRIVE_STORY_ENABLED: "false",
    // Disable recency-date scoring so stale high-playcount geo-chart tracks
    // (no releaseDate → isFresh = false) out-rank the fresh release-radar tracks
    // via chart signal alone.  Without the quota loop the fresh ones fall outside
    // the top-5; the loop is therefore the *only* reason they make it in — making
    // the test falsifiable.
    RECENCY_DATE_SCORING_ENABLED: "false",
    ...overrides,
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
    new FreshnessTestSpotifyAdapter(),
    new NoopScout(),
    new NoopOpenMusicClient(),
    lastfmCharts,
  );
  return { service, store };
}

const telemetry = {
  timestampIso: "2026-06-03T18:00:00.000Z",
  coarseRegion: "Bavaria, Germany",
  countryName: "Germany",
  countryCode: "DE",
  geoSource: "reverse-geocode" as const,
  destination: "Lago di Garda",
  etaMinutes: 180,
  speedKph: 92,
  outsideTempC: 24,
};

describe("freshness quota", () => {
  it(
    "guarantees >= FRESH_QUOTA_MIN release-radar tracks in the queue",
    { timeout: 30_000 },
    async () => {
      const { service, store } = buildService();
      const journey = makeJourney();
      store.createJourney(journey);
      store.saveTelemetry(journey.id, telemetry, "departure");

      await service.analyzeJourney(journey.id, "manual");

      const detailed = store.listResolvedTracksDetailed(journey.id);
      const session = store.getPlaybackSession(journey.id);
      const queuedIds = new Set([
        session?.activeTrack?.id,
        ...(session?.queuedTrackIds ?? []),
      ]);
      const freshInQueue = detailed.filter(
        (t) => queuedIds.has(t.id) && t.candidateLens === "release-radar",
      );
      expect(freshInQueue.length).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    "does not starve the queue when no fresh tracks exist (Musik vor Doktrin)",
    { timeout: 30_000 },
    async () => {
      const { service, store } = buildService({
        FRESH_QUOTA_MIN: "2",
        FRESH_WINDOW_DAYS: "1",
      });
      const journey = {
        ...makeJourney(),
        id: "journey-freshness-empty",
      };
      store.createJourney(journey);
      store.saveTelemetry(journey.id, telemetry, "departure");

      await service.analyzeJourney(journey.id, "manual");

      const session = store.getPlaybackSession(journey.id);
      expect(session?.queuedTrackIds.length).toBe(5);
    },
  );
});
