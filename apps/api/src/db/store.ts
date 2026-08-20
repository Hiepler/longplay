import type {
  DriveMode,
  JourneyContext,
  JourneyPhase,
  JourneyRecord,
  MusicWish,
  MusicWishStatus,
  NormalizedTelemetryEvent,
  PlaybackSession,
  PlaylistUpdate,
  QueueOperation,
  ResolvedTrack,
  SongCandidate,
  SpeedBucket,
  TasteProfile,
  TemperatureBucket,
} from "@longplay/core";
import { normalizeText, songKey } from "@longplay/core";
import { speedBucket, temperatureBucket } from "@longplay/telemetry";
import {
  assessDriveState,
  timeOfDayBand,
  weatherFeel,
} from "@longplay/recommendation";

import type { Db } from "./database.js";

const now = () => new Date().toISOString();

/** Spotify catalog is stable; cache search resolutions for 30 days. */
const SPOTIFY_SEARCH_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Taste evolves slowly; refresh the listener's top-artist profile at most once per day. */
const TASTE_PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAtIso?: string;
  userId?: string;
}

export interface TelemetrySnapshotReadModel extends NormalizedTelemetryEvent {
  speedBucket?: SpeedBucket;
  temperatureBucket?: TemperatureBucket;
  phase?: JourneyPhase;
  receivedAtIso?: string;
}

export class Store {
  constructor(private readonly db: Db) {}

  saveOauthState(state: string, codeVerifier: string): void {
    this.db.run(
      "INSERT INTO oauth_states (state, code_verifier, created_at) VALUES (?, ?, ?)",
      [state, codeVerifier, now()],
    );
  }

  consumeOauthState(state: string): string | undefined {
    const row = this.db.get<{ code_verifier: string }>(
      "SELECT code_verifier FROM oauth_states WHERE state = ?",
      [state],
    );
    this.db.run("DELETE FROM oauth_states WHERE state = ?", [state]);
    return row?.code_verifier;
  }

  saveCredentials(provider: string, encryptedPayload: string): void {
    this.db.run(
      `INSERT INTO provider_credentials (user_id, provider, encrypted_payload, updated_at)
       VALUES ('local', ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, updated_at = excluded.updated_at`,
      [provider, encryptedPayload, now()],
    );
  }

  getEncryptedCredentials(provider: string): string | undefined {
    return this.db.get<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM provider_credentials WHERE user_id = 'local' AND provider = ?",
      [provider],
    )?.encrypted_payload;
  }

  deleteCredentials(provider: string): void {
    this.db.run(
      "DELETE FROM provider_credentials WHERE user_id = 'local' AND provider = ?",
      [provider],
    );
  }

  createJourney(record: JourneyRecord): void {
    this.db.run(
      `INSERT INTO journeys
       (id, user_id, provider, destination, user_prompt, passenger_mode, phase, status, taste_weight, spotify_device_id, spotify_playlist_id, spotify_playlist_url, tidal_playlist_id, tidal_playlist_url, created_at, stopped_at)
       VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.provider,
        record.destination,
        record.userPrompt,
        record.passengerMode,
        record.phase,
        record.status,
        record.tasteWeight ?? null,
        record.spotifyDeviceId,
        record.spotifyPlaylistId ?? null,
        record.spotifyPlaylistUrl ?? null,
        record.tidalPlaylistId,
        record.tidalPlaylistUrl,
        record.createdAtIso,
        record.stoppedAtIso,
      ],
    );
  }

  updateJourneySpotifyPlaylist(
    journeyId: string,
    playlistId: string,
    playlistUrl?: string,
  ): void {
    this.db.run(
      "UPDATE journeys SET spotify_playlist_id = ?, spotify_playlist_url = ? WHERE id = ?",
      [playlistId, playlistUrl ?? null, journeyId],
    );
  }

  updateJourneyTasteWeight(journeyId: string, tasteWeight: number): void {
    this.db.run("UPDATE journeys SET taste_weight = ? WHERE id = ?", [
      tasteWeight,
      journeyId,
    ]);
  }

  updateJourneyDriveMode(journeyId: string, mode: DriveMode): void {
    this.db.run("UPDATE journeys SET drive_mode = ? WHERE id = ?", [
      mode,
      journeyId,
    ]);
  }

  updateJourneyLegIndex(
    journeyId: string,
    legIndex: number,
    legStartedAtIso?: string,
  ): void {
    this.db.run(
      "UPDATE journeys SET leg_index = ?, leg_started_at = ? WHERE id = ?",
      [legIndex, legStartedAtIso ?? null, journeyId],
    );
  }

  /** Refresh the car's current nav target (per leg). Never touches the final `destination`. */
  updateJourneyCurrentDestination(journeyId: string, destination: string): void {
    this.db.run("UPDATE journeys SET current_destination = ? WHERE id = ?", [
      destination,
      journeyId,
    ]);
  }

  setAdaptiveModeEnabled(journeyId: string, enabled: boolean): void {
    this.db.run("UPDATE journeys SET adaptive_mode_enabled = ? WHERE id = ?", [
      enabled ? 1 : 0,
      journeyId,
    ]);
  }

  setKidsMode(journeyId: string, enabled: boolean): void {
    this.db.run("UPDATE journeys SET kids_mode = ? WHERE id = ?", [
      enabled ? 1 : 0,
      journeyId,
    ]);
  }

  /**
   * Persists the last-known location used as the geo fallback. Higher-confidence sources win, and any
   * source may refresh a stale fix — so a real GPS/telemetry reading always updates, browser geo
   * replaces a destination seed (or a stale GPS fix), and the destination seed only fills an empty slot.
   */
  setLastGeo(
    journeyId: string,
    geo: {
      countryName?: string;
      countryCode?: string;
      coarseRegion?: string;
      source: "reverse-geocode" | "manual" | "browser-gps" | "destination";
    },
  ): void {
    if (!geo.countryName && !geo.countryCode && !geo.coarseRegion) return;
    const rank: Record<string, number> = {
      destination: 1,
      "browser-gps": 2,
      manual: 3,
      "reverse-geocode": 3,
    };
    const STALE_MS = 10 * 60 * 1000;
    const current = this.db.get<{
      last_geo_source: string | null;
      last_geo_country_code: string | null;
      last_geo_updated_at: string | null;
    }>(
      "SELECT last_geo_source, last_geo_country_code, last_geo_updated_at FROM journeys WHERE id = ?",
      [journeyId],
    );
    if (current?.last_geo_source === "manual" && geo.source !== "manual") {
      // Respect a manual override until a live fix shows the driver has moved to a *different*
      // country (then auto wins again); within the same country, keep the manual correction.
      const movedCountry =
        geo.countryCode &&
        current.last_geo_country_code &&
        geo.countryCode.toUpperCase() !== current.last_geo_country_code.toUpperCase();
      if (!movedCountry) return;
    } else if (current?.last_geo_source) {
      const incoming = rank[geo.source] ?? 0;
      const existing = rank[current.last_geo_source] ?? 0;
      const ageMs = current.last_geo_updated_at
        ? Date.now() - new Date(current.last_geo_updated_at).getTime()
        : Number.POSITIVE_INFINITY;
      if (incoming < existing && ageMs < STALE_MS) return;
    }
    this.db.run(
      `UPDATE journeys
       SET last_geo_country_name = ?, last_geo_country_code = ?,
           last_geo_coarse_region = ?, last_geo_source = ?, last_geo_updated_at = ?
       WHERE id = ?`,
      [
        geo.countryName ?? null,
        geo.countryCode ?? null,
        geo.coarseRegion ?? null,
        geo.source,
        new Date().toISOString(),
        journeyId,
      ],
    );
  }

  /** Stamps the journey's last meaningful-activity time (telemetry / owned playback / user action). */
  touchJourneyActivity(journeyId: string): void {
    this.db.run("UPDATE journeys SET last_active_at = ? WHERE id = ?", [
      now(),
      journeyId,
    ]);
  }

  /** Clears the last-known geo (e.g. when the driver reverts a manual override back to auto). */
  clearLastGeo(journeyId: string): void {
    this.db.run(
      `UPDATE journeys
       SET last_geo_country_name = NULL, last_geo_country_code = NULL,
           last_geo_coarse_region = NULL, last_geo_source = NULL, last_geo_updated_at = NULL
       WHERE id = ?`,
      [journeyId],
    );
  }

  /** Snapshot the planned trip duration once; subsequent calls are no-ops. */
  setPlannedDurationMinutes(journeyId: string, minutes: number): void {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    this.db.run(
      `UPDATE journeys
       SET planned_duration_minutes = ?, planned_duration_set_at = ?
       WHERE id = ? AND planned_duration_minutes IS NULL`,
      [Math.round(minutes), new Date().toISOString(), journeyId],
    );
  }

  updateJourneyProvider(
    journeyId: string,
    provider: "spotify" | "tidal",
  ): void {
    this.db.run("UPDATE journeys SET provider = ? WHERE id = ?", [
      provider,
      journeyId,
    ]);
  }

  updateJourneySpotifyDevice(
    journeyId: string,
    deviceId: string | undefined,
  ): void {
    this.db.run("UPDATE journeys SET spotify_device_id = ? WHERE id = ?", [
      deviceId,
      journeyId,
    ]);
  }

  updateJourneyPlaylist(
    journeyId: string,
    playlistId: string,
    playlistUrl?: string,
  ): void {
    this.db.run(
      "UPDATE journeys SET tidal_playlist_id = ?, tidal_playlist_url = ? WHERE id = ?",
      [playlistId, playlistUrl ?? null, journeyId],
    );
  }

  updateJourneyPhase(journeyId: string, phase: string): void {
    this.db.run("UPDATE journeys SET phase = ? WHERE id = ?", [
      phase,
      journeyId,
    ]);
  }

  stopJourney(journeyId: string): void {
    this.db.run(
      "UPDATE journeys SET status = 'stopped', stopped_at = ? WHERE id = ?",
      [now(), journeyId],
    );
  }

  getJourney(journeyId: string): JourneyRecord | undefined {
    const row = this.db.get<any>("SELECT * FROM journeys WHERE id = ?", [
      journeyId,
    ]);
    return row ? mapJourney(row) : undefined;
  }

  listJourneys(limit = 30): JourneyRecord[] {
    return this.db
      .all<any>("SELECT * FROM journeys ORDER BY created_at DESC LIMIT ?", [
        limit,
      ])
      .map(mapJourney);
  }

  listActiveJourneys(): JourneyRecord[] {
    return this.db
      .all<any>(
        "SELECT * FROM journeys WHERE status = 'active' ORDER BY created_at ASC",
      )
      .map(mapJourney);
  }

  saveTelemetry(
    journeyId: string | undefined,
    event: NormalizedTelemetryEvent,
    phase: string,
  ): void {
    this.db.run(
      `INSERT INTO telemetry_snapshots
       (journey_id, timestamp, coarse_region, country_name, country_code, geo_source, destination, eta_minutes, speed_kph, outside_temp_c, speed_bucket, temperature_bucket, phase, autopilot_state, battery_percent, charging_state, traffic_delay_minutes, energy_percent_at_arrival, audio_volume, longitudinal_accel_mps2, brake_pedal, hazards_active, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        journeyId,
        event.timestampIso,
        event.coarseRegion,
        event.countryName,
        event.countryCode,
        event.geoSource,
        event.destination,
        event.etaMinutes,
        event.speedKph,
        event.outsideTempC,
        speedBucket(event.speedKph),
        temperatureBucket(event.outsideTempC),
        phase,
        event.autopilotState,
        event.batteryPercent,
        event.chargingState ?? null,
        event.trafficDelayMinutes ?? null,
        event.energyPercentAtArrival ?? null,
        event.audioVolume ?? null,
        event.longitudinalAccelMps2 ?? null,
        event.brakePedal === undefined ? null : event.brakePedal ? 1 : 0,
        event.hazardsActive === undefined ? null : event.hazardsActive ? 1 : 0,
        new Date().toISOString(),
      ],
    );
  }

  /** Server-side ingest time of the most recent telemetry snapshot — drives the live badge. */
  latestTelemetryReceivedAt(journeyId: string): string | undefined {
    const row = this.db.get<{ received_at: string | null }>(
      "SELECT received_at FROM telemetry_snapshots WHERE journey_id = ? ORDER BY timestamp DESC LIMIT 1",
      [journeyId],
    );
    return row?.received_at ?? undefined;
  }

  latestTelemetry(journeyId: string): TelemetrySnapshotReadModel | undefined {
    const row = this.db.get<any>(
      "SELECT * FROM telemetry_snapshots WHERE journey_id = ? ORDER BY timestamp DESC LIMIT 1",
      [journeyId],
    );

    if (!row) return undefined;
    return mapTelemetrySnapshot(row);
  }

  recentTelemetry(journeyId: string, limit = 5): TelemetrySnapshotReadModel[] {
    return this.db
      .all<any>(
        "SELECT * FROM telemetry_snapshots WHERE journey_id = ? ORDER BY timestamp DESC LIMIT ?",
        [journeyId, limit],
      )
      .map(mapTelemetrySnapshot);
  }

  saveCandidate(journeyId: string, candidate: SongCandidate): string {
    const id = candidate.id ?? crypto.randomUUID();
    this.db.run(
      `INSERT OR IGNORE INTO song_candidates
       (id, journey_id, artist, title, album, year, isrc, genre, lens, role, scores_json, popularity, explicit, release_date, chart_rank, chart_playcount, chart_country, chart_source, mood_tags_json, reason, source, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        journeyId,
        candidate.artist,
        candidate.title,
        candidate.album,
        candidate.year,
        candidate.isrc,
        candidate.genre,
        candidate.lens,
        candidate.role,
        candidate.scores ? JSON.stringify(candidate.scores) : undefined,
        candidate.popularity,
        candidate.explicit === undefined
          ? undefined
          : candidate.explicit
            ? 1
            : 0,
        candidate.releaseDate,
        candidate.chartRank,
        candidate.chartPlaycount,
        candidate.chartCountry,
        candidate.chartSource,
        candidate.moodTags ? JSON.stringify(candidate.moodTags) : undefined,
        candidate.reason,
        candidate.source,
        candidate.confidence,
        now(),
      ],
    );
    return id;
  }

  saveResolvedTrack(
    journeyId: string,
    candidateId: string | undefined,
    track: ResolvedTrack,
  ): string {
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT OR IGNORE INTO resolved_tracks
       (id, journey_id, candidate_id, provider, provider_track_id, provider_uri, external_url, is_playable, market, album_art_url, artist, title, isrc, popularity, explicit, release_date, chart_rank, chart_playcount, chart_country, chart_source, mood_tags_json, energy, valence, match_confidence, match_reason, added_to_playlist, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        id,
        journeyId,
        candidateId,
        track.provider,
        track.providerTrackId,
        track.providerUri,
        track.externalUrl,
        track.isPlayable === undefined ? undefined : track.isPlayable ? 1 : 0,
        track.market,
        track.albumArtUrl,
        track.artist,
        track.title,
        track.isrc,
        track.popularity,
        track.explicit === undefined ? undefined : track.explicit ? 1 : 0,
        track.releaseDate,
        track.chartRank,
        track.chartPlaycount,
        track.chartCountry,
        track.chartSource,
        track.moodTags ? JSON.stringify(track.moodTags) : undefined,
        typeof track.energy === "number" ? track.energy : undefined,
        typeof track.valence === "number" ? track.valence : undefined,
        track.matchConfidence,
        track.matchReason,
        now(),
      ],
    );
    return (
      this.db.get<{ id: string }>(
        "SELECT id FROM resolved_tracks WHERE journey_id = ? AND provider = ? AND provider_track_id = ?",
        [journeyId, track.provider, track.providerTrackId],
      )?.id ?? id
    );
  }

  /**
   * Persistent Spotify search cache. Returns the cached resolved track, `null` for a cached
   * "no match", or `undefined` when never searched or the entry has expired (30-day TTL).
   */
  getCachedSpotifySearch(cacheKey: string): ResolvedTrack | null | undefined {
    const row = this.db.get<{ track_json: string | null; created_at: string }>(
      "SELECT track_json, created_at FROM spotify_search_cache WHERE cache_key = ?",
      [cacheKey],
    );
    if (!row) {
      return undefined;
    }
    if (
      Date.now() - new Date(row.created_at).getTime() >
      SPOTIFY_SEARCH_CACHE_TTL_MS
    ) {
      this.db.run("DELETE FROM spotify_search_cache WHERE cache_key = ?", [
        cacheKey,
      ]);
      return undefined;
    }
    return row.track_json
      ? (JSON.parse(row.track_json) as ResolvedTrack)
      : null;
  }

  saveCachedSpotifySearch(cacheKey: string, track: ResolvedTrack | null): void {
    this.db.run(
      "INSERT OR REPLACE INTO spotify_search_cache (cache_key, track_json, created_at) VALUES (?, ?, ?)",
      [cacheKey, track ? JSON.stringify(track) : null, now()],
    );
  }

  /**
   * Cached taste profile (derived from Spotify top artists). Returns `undefined` when never
   * cached or the entry has expired (24h TTL), so the caller refetches at most once per day.
   */
  getCachedTasteProfile(userId: string): TasteProfile | undefined {
    const row = this.db.get<{ profile_json: string; created_at: string }>(
      "SELECT profile_json, created_at FROM taste_profile_cache WHERE user_id = ?",
      [userId],
    );
    if (!row) {
      return undefined;
    }
    if (
      Date.now() - new Date(row.created_at).getTime() >
      TASTE_PROFILE_CACHE_TTL_MS
    ) {
      this.db.run("DELETE FROM taste_profile_cache WHERE user_id = ?", [
        userId,
      ]);
      return undefined;
    }
    return JSON.parse(row.profile_json) as TasteProfile;
  }

  saveCachedTasteProfile(userId: string, profile: TasteProfile): void {
    this.db.run(
      "INSERT OR REPLACE INTO taste_profile_cache (user_id, profile_json, created_at) VALUES (?, ?, ?)",
      [userId, JSON.stringify(profile), now()],
    );
  }

  saveMusicWish(wish: MusicWish): void {
    this.db.run(
      `INSERT INTO music_wishes
       (id, journey_id, raw_text, source, parsed_intents_json, status, confidence, summary, pinned, expires_after_tracks, remaining_tracks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         raw_text = excluded.raw_text,
         source = excluded.source,
         parsed_intents_json = excluded.parsed_intents_json,
         status = excluded.status,
         confidence = excluded.confidence,
         summary = excluded.summary,
         pinned = excluded.pinned,
         expires_after_tracks = excluded.expires_after_tracks,
         remaining_tracks = excluded.remaining_tracks,
         updated_at = excluded.updated_at`,
      [
        wish.id,
        wish.journeyId,
        wish.rawText,
        wish.source,
        JSON.stringify(wish.intents),
        wish.status,
        wish.confidence,
        wish.summary,
        wish.pinned ? 1 : 0,
        wish.expiresAfterTracks,
        wish.remainingTracks,
        wish.createdAtIso,
        wish.updatedAtIso,
      ],
    );
  }

  getMusicWish(journeyId: string, wishId: string): MusicWish | undefined {
    const row = this.db.get<any>(
      "SELECT * FROM music_wishes WHERE journey_id = ? AND id = ?",
      [journeyId, wishId],
    );
    return row ? mapMusicWish(row) : undefined;
  }

  listActiveMusicWishes(journeyId: string): MusicWish[] {
    return this.db
      .all<any>(
        "SELECT * FROM music_wishes WHERE journey_id = ? AND status IN ('active', 'soft_applied') ORDER BY created_at DESC",
        [journeyId],
      )
      .map(mapMusicWish);
  }

  listRecentMusicWishes(journeyId: string, limit = 10): MusicWish[] {
    return this.db
      .all<any>(
        "SELECT * FROM music_wishes WHERE journey_id = ? ORDER BY created_at DESC LIMIT ?",
        [journeyId, limit],
      )
      .map(mapMusicWish);
  }

  updateMusicWish(
    journeyId: string,
    wishId: string,
    patch: { pinned?: boolean; status?: MusicWishStatus; remainingTracks?: number },
  ): void {
    const existing = this.getMusicWish(journeyId, wishId);
    if (!existing) return;
    this.saveMusicWish({
      ...existing,
      pinned: patch.pinned ?? existing.pinned,
      status: patch.status ?? existing.status,
      remainingTracks: patch.remainingTracks ?? existing.remainingTracks,
      updatedAtIso: now(),
    });
  }

  decayActiveMusicWishes(journeyId: string, surfacedTrackCount: number): void {
    if (surfacedTrackCount <= 0) return;
    for (const wish of this.listActiveMusicWishes(journeyId)) {
      if (wish.pinned) continue;
      const remaining = Math.max(0, wish.remainingTracks - surfacedTrackCount);
      this.updateMusicWish(journeyId, wish.id, {
        remainingTracks: remaining,
        status: remaining === 0 ? "expired" : wish.status,
      });
    }
  }

  /** 30-day hard cap so the table never grows unbounded regardless of the fatigue window. */
  private static readonly RECENT_PLAYS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

  recordRecentPlays(
    journeyId: string,
    tracks: Array<{ artist: string; title: string }>,
    surfacedAtIso: string = now(),
  ): void {
    for (const track of tracks) {
      this.db.run(
        "INSERT INTO recent_plays (id, journey_id, artist, song_key, surfaced_at) VALUES (?, ?, ?, ?, ?)",
        [
          crypto.randomUUID(),
          journeyId,
          track.artist,
          songKey(track.artist, track.title),
          surfacedAtIso,
        ],
      );
    }
    const cutoff = new Date(
      Date.parse(surfacedAtIso) - Store.RECENT_PLAYS_MAX_AGE_MS,
    ).toISOString();
    this.db.run("DELETE FROM recent_plays WHERE surfaced_at < ?", [cutoff]);
  }

  listRecentlyPlayed(
    windowMs: number,
    nowMs: number = Date.now(),
  ): Array<{ artist: string; songKey: string; ageMs: number }> {
    const cutoff = new Date(nowMs - windowMs).toISOString();
    return this.db
      .all<any>(
        "SELECT artist, song_key, surfaced_at FROM recent_plays WHERE surfaced_at >= ? ORDER BY surfaced_at DESC",
        [cutoff],
      )
      .map((row) => ({
        artist: row.artist,
        songKey: row.song_key,
        ageMs: Math.max(0, nowMs - Date.parse(row.surfaced_at)),
      }));
  }

  /** Auftritte pro (normalisiertem) Artist im Fenster — Grundlage des Vielfalts-Banns. */
  artistPlayCounts(windowMs: number, nowMs: number = Date.now()): Map<string, number> {
    const cutoff = new Date(nowMs - windowMs).toISOString();
    const rows = this.db.all<any>(
      "SELECT artist FROM recent_plays WHERE surfaced_at >= ?",
      [cutoff],
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = normalizeText(row.artist);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  listResolvedTracks(
    journeyId: string,
  ): Array<
    ResolvedTrack & {
      id: string;
      addedToPlaylist: boolean;
      savedToPlaylist: boolean;
    }
  > {
    return this.db
      .all<any>(
        "SELECT * FROM resolved_tracks WHERE journey_id = ? ORDER BY created_at ASC",
        [journeyId],
      )
      .map((row) => ({
        id: row.id,
        provider: row.provider,
        providerTrackId: row.provider_track_id,
        providerUri: row.provider_uri ?? undefined,
        externalUrl: row.external_url ?? undefined,
        isPlayable:
          row.is_playable === null || row.is_playable === undefined
            ? undefined
            : row.is_playable === 1,
        market: row.market ?? undefined,
        albumArtUrl: row.album_art_url ?? undefined,
        artist: row.artist,
        title: row.title,
        isrc: row.isrc,
        popularity: row.popularity ?? undefined,
        explicit:
          row.explicit === null || row.explicit === undefined
            ? undefined
            : row.explicit === 1,
        releaseDate: row.release_date ?? undefined,
        chartRank: row.chart_rank ?? undefined,
        chartPlaycount: row.chart_playcount ?? undefined,
        chartCountry: row.chart_country ?? undefined,
        chartSource: row.chart_source ?? undefined,
        moodTags: row.mood_tags_json
          ? (JSON.parse(row.mood_tags_json) as string[])
          : undefined,
        energy:
          row.energy === null || row.energy === undefined
            ? undefined
            : row.energy,
        valence:
          row.valence === null || row.valence === undefined
            ? undefined
            : row.valence,
        matchConfidence: row.match_confidence,
        matchReason: row.match_reason,
        addedToPlaylist: row.added_to_playlist === 1,
        savedToPlaylist: row.saved_to_playlist === 1,
      }));
  }

  /** Resolved Tracks inkl. Kandidaten-Attribution für die whyLine. */
  listResolvedTracksDetailed(journeyId: string): Array<
    ReturnType<Store["listResolvedTracks"]>[number] & {
      candidateLens?: string;
      candidateReason?: string;
      candidateSource?: string;
      candidateChartCountry?: string;
    }
  > {
    const base = this.listResolvedTracks(journeyId);
    const rows = this.db.all<any>(
      `SELECT rt.id as rid, sc.lens, sc.reason, sc.source, sc.chart_country
       FROM resolved_tracks rt JOIN song_candidates sc ON sc.id = rt.candidate_id
       WHERE rt.journey_id = ?`,
      [journeyId],
    );
    const byId = new Map(rows.map((row) => [row.rid, row]));
    return base.map((track) => {
      const meta = byId.get(track.id);
      return meta
        ? {
            ...track,
            candidateLens: meta.lens ?? undefined,
            candidateReason: meta.reason ?? undefined,
            candidateSource: meta.source ?? undefined,
            candidateChartCountry: meta.chart_country ?? undefined,
          }
        : track;
    });
  }

  markTracksAdded(ids: string[]): void {
    for (const id of ids) {
      this.db.run(
        "UPDATE resolved_tracks SET added_to_playlist = 1 WHERE id = ?",
        [id],
      );
    }
  }

  markTracksSavedToPlaylist(ids: string[]): void {
    for (const id of ids) {
      this.db.run(
        "UPDATE resolved_tracks SET saved_to_playlist = 1 WHERE id = ?",
        [id],
      );
    }
  }

  savePlaylistUpdate(update: PlaylistUpdate): void {
    this.db.run(
      `INSERT INTO playlist_updates
       (id, journey_id, provider, batch_size, candidate_ids, resolved_track_ids, idempotency_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        update.id,
        update.journeyId,
        update.provider,
        update.batchSize,
        JSON.stringify(update.candidateIds),
        JSON.stringify(update.resolvedTrackIds),
        update.idempotencyKey,
        update.status,
        update.createdAtIso,
      ],
    );
  }

  latestPlaylistUpdate(journeyId: string): PlaylistUpdate | undefined {
    const row = this.db.get<any>(
      "SELECT * FROM playlist_updates WHERE journey_id = ? ORDER BY created_at DESC LIMIT 1",
      [journeyId],
    );
    return row
      ? {
          id: row.id,
          journeyId: row.journey_id,
          provider: row.provider ?? undefined,
          batchSize: row.batch_size,
          candidateIds: JSON.parse(row.candidate_ids),
          resolvedTrackIds: JSON.parse(row.resolved_track_ids),
          idempotencyKey: row.idempotency_key,
          status: row.status,
          createdAtIso: row.created_at,
        }
      : undefined;
  }

  savePlaybackSession(session: PlaybackSession): void {
    this.db.run(
      `INSERT INTO playback_sessions
       (journey_id, provider, device_id, status, active_track_id, queued_track_ids, played_track_ids, target_buffer_size, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(journey_id) DO UPDATE SET
         provider = excluded.provider,
         device_id = excluded.device_id,
         status = excluded.status,
         active_track_id = excluded.active_track_id,
         queued_track_ids = excluded.queued_track_ids,
         played_track_ids = excluded.played_track_ids,
         target_buffer_size = excluded.target_buffer_size,
         last_heartbeat_at = excluded.last_heartbeat_at`,
      [
        session.journeyId,
        session.provider,
        session.deviceId,
        session.status,
        session.activeTrack?.id,
        JSON.stringify(session.queuedTrackIds),
        JSON.stringify(session.playedTrackIds ?? []),
        session.targetBufferSize,
        session.lastHeartbeatAt,
      ],
    );
  }

  getPlaybackSession(journeyId: string): PlaybackSession | undefined {
    const row = this.db.get<any>(
      "SELECT * FROM playback_sessions WHERE journey_id = ?",
      [journeyId],
    );
    if (!row) return undefined;
    const activeTrack = row.active_track_id
      ? this.listResolvedTracks(journeyId).find(
          (track) => track.id === row.active_track_id,
        )
      : undefined;
    return {
      journeyId: row.journey_id,
      provider: row.provider,
      deviceId: row.device_id ?? undefined,
      status: row.status,
      activeTrack,
      queuedTrackIds: JSON.parse(row.queued_track_ids),
      playedTrackIds: JSON.parse(row.played_track_ids ?? "[]"),
      targetBufferSize: 5,
      lastHeartbeatAt: row.last_heartbeat_at,
    };
  }

  saveQueueOperation(operation: QueueOperation): void {
    this.db.run(
      `INSERT INTO queue_operations
       (id, journey_id, provider, provider_track_id, provider_uri, operation, status, device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.id,
        operation.journeyId,
        operation.provider,
        operation.providerTrackId,
        operation.providerUri,
        operation.operation,
        operation.status,
        operation.deviceId,
        operation.createdAtIso,
      ],
    );
  }

  listQueueOperations(journeyId: string): QueueOperation[] {
    return this.db
      .all<any>(
        "SELECT * FROM queue_operations WHERE journey_id = ? ORDER BY created_at ASC",
        [journeyId],
      )
      .map((row) => ({
        id: row.id,
        journeyId: row.journey_id,
        provider: row.provider,
        providerTrackId: row.provider_track_id,
        providerUri: row.provider_uri ?? undefined,
        operation: row.operation,
        status: row.status,
        deviceId: row.device_id ?? undefined,
        createdAtIso: row.created_at,
      }));
  }

  audit(
    journeyId: string | undefined,
    type: string,
    message: string,
    payload?: unknown,
  ): void {
    this.db.run(
      "INSERT INTO audit_events (journey_id, type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        journeyId,
        type,
        message,
        payload ? JSON.stringify(payload) : undefined,
        now(),
      ],
    );
  }

  latestAuditEvent(
    journeyId: string,
    type: string,
  ): { message: string; createdAtIso: string } | undefined {
    const row = this.db.get<{ message: string; created_at: string }>(
      "SELECT message, created_at FROM audit_events WHERE journey_id = ? AND type = ? ORDER BY id DESC LIMIT 1",
      [journeyId, type],
    );
    return row
      ? { message: row.message, createdAtIso: row.created_at }
      : undefined;
  }

  clearAuditEvents(journeyId: string, type: string): void {
    this.db.run("DELETE FROM audit_events WHERE journey_id = ? AND type = ?", [
      journeyId,
      type,
    ]);
  }

  /**
   * Most recent fired journey moment (type + optional country from the payload) for the family-event
   * banner. Returns undefined when none, or the payload can't be parsed.
   */
  latestMomentEvent(
    journeyId: string,
  ): { type: string; country?: string; createdAtIso: string } | undefined {
    const row = this.db.get<{ payload_json: string | null; created_at: string }>(
      "SELECT payload_json, created_at FROM audit_events WHERE journey_id = ? AND type = 'moment.triggered' ORDER BY id DESC LIMIT 1",
      [journeyId],
    );
    if (!row) return undefined;
    let payload: { type?: string; country?: string } = {};
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : {};
    } catch {
      payload = {};
    }
    if (!payload.type) return undefined;
    return {
      type: payload.type,
      country: payload.country,
      createdAtIso: row.created_at,
    };
  }

  auditEvents(
    journeyId: string,
    sinceId = 0,
  ): Array<{
    id: number;
    type: string;
    message: string;
    createdAtIso: string;
  }> {
    return this.db
      .all<any>(
        "SELECT id, type, message, created_at FROM audit_events WHERE journey_id = ? AND id > ? ORDER BY id ASC LIMIT 50",
        [journeyId, sinceId],
      )
      .map((row) => ({
        id: row.id,
        type: row.type,
        message: row.message,
        createdAtIso: row.created_at,
      }));
  }
}

function mapJourney(row: any): JourneyRecord {
  return {
    id: row.id,
    provider: row.provider ?? "tidal",
    destination: row.destination,
    currentDestination: row.current_destination ?? undefined,
    userPrompt: row.user_prompt,
    passengerMode: row.passenger_mode,
    phase: row.phase,
    status: row.status,
    tasteWeight: row.taste_weight ?? undefined,
    spotifyDeviceId: row.spotify_device_id ?? undefined,
    spotifyPlaylistId: row.spotify_playlist_id ?? undefined,
    spotifyPlaylistUrl: row.spotify_playlist_url ?? undefined,
    tidalPlaylistId: row.tidal_playlist_id ?? undefined,
    tidalPlaylistUrl: row.tidal_playlist_url ?? undefined,
    driveMode: (row.drive_mode as DriveMode | null) ?? undefined,
    adaptiveModeEnabled:
      row.adaptive_mode_enabled === undefined
        ? undefined
        : row.adaptive_mode_enabled !== 0,
    plannedDurationMinutes: row.planned_duration_minutes ?? undefined,
    legIndex: row.leg_index ?? undefined,
    legStartedAtIso: row.leg_started_at ?? undefined,
    kidsMode: row.kids_mode === 1,
    lastGeo:
      row.last_geo_country_name ||
      row.last_geo_country_code ||
      row.last_geo_coarse_region
        ? {
            countryName: row.last_geo_country_name ?? undefined,
            countryCode: row.last_geo_country_code ?? undefined,
            coarseRegion: row.last_geo_coarse_region ?? undefined,
            source: row.last_geo_source ?? undefined,
            updatedAtIso: row.last_geo_updated_at ?? undefined,
          }
        : undefined,
    createdAtIso: row.created_at,
    stoppedAtIso: row.stopped_at,
    lastActiveAtIso: row.last_active_at ?? row.created_at,
  };
}

function mapMusicWish(row: any): MusicWish {
  return {
    id: row.id,
    journeyId: row.journey_id,
    rawText: row.raw_text,
    source: row.source,
    intents: JSON.parse(row.parsed_intents_json),
    status: row.status,
    confidence: row.confidence,
    summary: row.summary,
    pinned: row.pinned === 1,
    expiresAfterTracks: row.expires_after_tracks,
    remainingTracks: row.remaining_tracks,
    createdAtIso: row.created_at,
    updatedAtIso: row.updated_at,
  };
}

function mapTelemetrySnapshot(row: any): TelemetrySnapshotReadModel {
  return {
    timestampIso: row.timestamp,
    coarseRegion: row.coarse_region ?? undefined,
    countryName: row.country_name ?? undefined,
    countryCode: row.country_code ?? undefined,
    geoSource: row.geo_source ?? undefined,
    destination: row.destination ?? undefined,
    etaMinutes: row.eta_minutes ?? undefined,
    speedKph: row.speed_kph ?? undefined,
    outsideTempC: row.outside_temp_c ?? undefined,
    speedBucket: row.speed_bucket ?? undefined,
    temperatureBucket: row.temperature_bucket ?? undefined,
    phase: row.phase ?? undefined,
    autopilotState: row.autopilot_state ?? undefined,
    batteryPercent: row.battery_percent ?? undefined,
    chargingState: row.charging_state ?? undefined,
    trafficDelayMinutes: row.traffic_delay_minutes ?? undefined,
    energyPercentAtArrival: row.energy_percent_at_arrival ?? undefined,
    audioVolume: row.audio_volume ?? undefined,
    longitudinalAccelMps2: row.longitudinal_accel_mps2 ?? undefined,
    brakePedal:
      row.brake_pedal === null || row.brake_pedal === undefined
        ? undefined
        : row.brake_pedal !== 0,
    hazardsActive:
      row.hazards_active === null || row.hazards_active === undefined
        ? undefined
        : row.hazards_active !== 0,
    receivedAtIso: row.received_at ?? undefined,
  };
}

function derivePaceTrend(
  history: TelemetrySnapshotReadModel[],
): JourneyContext["paceTrend"] {
  const ordered = [...history]
    .filter((item) => typeof item.speedKph === "number")
    .sort((a, b) => Date.parse(a.timestampIso) - Date.parse(b.timestampIso));
  if (ordered.length < 2) return undefined;
  const first = ordered[0].speedKph!;
  const last = ordered[ordered.length - 1].speedKph!;
  const delta = last - first;
  if (delta >= 12) return "accelerating";
  if (delta <= -12) return "slowing";
  return "steady";
}

function deriveEtaTrend(
  history: TelemetrySnapshotReadModel[],
): JourneyContext["etaTrend"] {
  const ordered = [...history]
    .filter((item) => typeof item.etaMinutes === "number")
    .sort((a, b) => Date.parse(a.timestampIso) - Date.parse(b.timestampIso));
  if (ordered.length < 2) return undefined;
  const first = ordered[0].etaMinutes!;
  const last = ordered[ordered.length - 1].etaMinutes!;
  if (last < first - 2) return "approaching";
  if (Math.abs(last - first) <= 2) return "steady";
  return "unknown";
}

export function contextFromJourney(
  journey: JourneyRecord,
  telemetry?: TelemetrySnapshotReadModel,
  recentTelemetry: TelemetrySnapshotReadModel[] = telemetry ? [telemetry] : [],
  telemetrySource?: "streaming" | "polling",
): JourneyContext {
  const speed = telemetry?.speedBucket ?? speedBucket(telemetry?.speedKph);
  const temp =
    telemetry?.temperatureBucket ?? temperatureBucket(telemetry?.outsideTempC);
  // Geo precedence: a manual correction wins over everything; otherwise live telemetry; otherwise the
  // journey's last-known location (browser geo, a prior GPS fix, or the destination seed) so the
  // "local touch" works without active GPS.
  const fallback = journey.lastGeo;
  const resolvedGeo =
    fallback?.source === "manual"
      ? fallback
      : {
          coarseRegion: telemetry?.coarseRegion ?? fallback?.coarseRegion,
          countryName: telemetry?.countryName ?? fallback?.countryName,
          countryCode: telemetry?.countryCode ?? fallback?.countryCode,
          source: telemetry?.geoSource ?? fallback?.source,
        };
  const localTimeIso = telemetry?.timestampIso ?? new Date().toISOString();
  const localDate = new Date(localTimeIso);
  const band = timeOfDayBand(localDate.getHours());
  return {
    destination: telemetry?.destination ?? journey.destination,
    // The seeded final target — lets moment detection tell an interim charge stop from the real arrival.
    finalDestination: journey.destination,
    coarseRegion: resolvedGeo.coarseRegion,
    countryName: resolvedGeo.countryName,
    countryCode: resolvedGeo.countryCode,
    geoSource: resolvedGeo.source,
    localTimeIso,
    weatherFeel: weatherFeel(
      telemetry?.outsideTempC,
      band,
      localDate.getMonth(),
    ),
    etaMinutes: telemetry?.etaMinutes,
    speedBucket: speed,
    temperatureBucket: temp,
    paceTrend: derivePaceTrend(recentTelemetry),
    etaTrend: deriveEtaTrend(recentTelemetry),
    autopilotState: telemetry?.autopilotState,
    batteryPercent: telemetry?.batteryPercent,
    phase: journey.phase,
    userPrompt: journey.userPrompt,
    passengerMode: journey.passengerMode,
    kidsMode: journey.kidsMode === true,
    driveState: driveStateForBrief(journey, recentTelemetry),
    telemetrySource,
    plannedDurationMinutes: journey.plannedDurationMinutes,
    legIndex: journey.legIndex,
    elapsedMinutes: Math.max(
      0,
      (Date.now() - Date.parse(journey.createdAtIso)) / 60000,
    ),
    // Minutes within the current leg — resets at each charge stop so the arc reopens per leg.
    // Falls back to whole-journey elapsed on leg 0 (no leg start recorded yet).
    legElapsedMinutes: Math.max(
      0,
      (Date.now() -
        Date.parse(journey.legStartedAtIso ?? journey.createdAtIso)) /
        60000,
    ),
    trafficDelayMinutes: telemetry?.trafficDelayMinutes,
    accelStyle: accelStyleFrom(recentTelemetry),
    quietCabin:
      typeof telemetry?.audioVolume === "number"
        ? telemetry.audioVolume <= 3
        : undefined,
  };
}

/** stop_and_go bei hoher Beschleunigungs-Varianz, smooth_glide bei sehr niedriger; sonst undefined. */
function accelStyleFrom(
  recent: TelemetrySnapshotReadModel[] | undefined,
): "stop_and_go" | "smooth_glide" | undefined {
  const values = (recent ?? [])
    .map((item) => item.longitudinalAccelMps2)
    .filter((v): v is number => typeof v === "number");
  if (values.length < 3) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  if (variance >= 0.8) return "stop_and_go";
  if (variance <= 0.05) return "smooth_glide";
  return undefined;
}

/**
 * Resolves the Adaptive Drive Mode assessment the Musical Brief should use. Uses the journey's
 * hysteresis-stabilized engaged mode (set by the service) so the brief stays stable; pairs it with
 * the latest raw reason/intensity for prompt grounding. Returns undefined when disabled or neutral.
 */
function driveStateForBrief(
  journey: JourneyRecord,
  recentTelemetry: TelemetrySnapshotReadModel[],
): JourneyContext["driveState"] {
  if (journey.adaptiveModeEnabled === false) return undefined;
  const engaged = journey.driveMode ?? "neutral";
  if (engaged === "neutral") return undefined;
  const ordered = [...recentTelemetry].sort(
    (a, b) => Date.parse(a.timestampIso) - Date.parse(b.timestampIso),
  );
  const raw = assessDriveState(
    ordered,
    ordered[ordered.length - 1]?.timestampIso ?? new Date().toISOString(),
  );
  if (raw.mode === engaged) return raw;
  return {
    mode: engaged,
    reason: engaged === "calm" ? "calmer driving" : "long drive",
    intensity: 0.4,
    signals: [],
  };
}
