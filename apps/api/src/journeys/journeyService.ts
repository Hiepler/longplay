import type {
  JourneyContext,
  JourneyPhase,
  JourneyRecord,
  MusicWish,
  MusicWishSource,
  MusicWishStatus,
  NormalizedTelemetryEvent,
  PlaybackSession,
  PlaylistUpdate,
  ResolvedTrack,
  SongCandidate,
  StreamingProvider,
  TasteProfile,
} from "@longplay/core";
import { normalizeText, songKey } from "@longplay/core";
import { derivePhase } from "@longplay/telemetry";
import {
  playbackOwnership,
  reconcilePlaybackModel,
  shouldRegenerate,
} from "../playback/reconcile.js";
import {
  detectJourneyMoment,
  type JourneyMoment,
} from "../playback/moments.js";
import { TidalResolver, type TidalAdapter } from "@longplay/tidal";
import {
  SpotifyResolver,
  isSpotifyDeviceNotFoundError,
  isSpotifyRateLimitError,
  queueTracksForBuffer,
  type SpotifyAdapter,
  type SpotifyAlbum,
  type SpotifyDevice,
} from "@longplay/spotify";
import type {
  OpenMusicClient,
  NoopOpenMusicClient,
} from "@longplay/open-music";
import type { SongScout } from "@longplay/recommendation";
import {
  assessDriveState,
  applyMusicWishesToPolicy,
  buildRecommendationPolicy,
  candidatesFromMusicWishes,
  deriveTasteProfile,
  fallbackCandidates,
  isWithinFreshWindow,
  lastfmTracksToCandidates,
  driveStoryAct,
  energyCurveForContext,
  makeVarietyContext,
  momentumRadioCandidates,
  orderByEnergyArc,
  releaseRadarCandidates,
  resolvedTrackEnergy,
  resolvedTrackValence01,
  parseMusicWish,
  rankResolvedTracksForPolicy,
  rotateWindow,
  seededExplorationAngle,
  selectRollingBatch,
  stabilizeDriveMode,
  type AlbumSource,
  type LastfmChartClient,
  type RecommendationPolicy,
} from "@longplay/recommendation";

/** Default familiarity↔discovery mix for a new drive — between "light" and "balanced". */
export const DEFAULT_TASTE_WEIGHT = 0.4;
/** Hard cap on the top-artists fetch so taste loading can never block a journey. */
const TASTE_FETCH_TIMEOUT_MS = 8_000;
/** Best-fit taste anchor: how many leading favorite artists to consider as opener candidates. */
const ANCHOR_ARTIST_FANOUT = 3;
/** Signature tracks to pull per favorite artist (kept low so we stay on iconic, not deep, cuts). */
const ANCHOR_TRACKS_PER_ARTIST = 2;
/** Overall cap on anchor options so the familiar shortlist never floods the candidate pool. */
const ANCHOR_OPTIONS_MAX = 4;
/**
 * Analyze reasons triggered by an explicit user action — these may push to the device even if the
 * user has "taken over". Anything not listed here is a background/automated pass that the
 * takeover guard can suppress (time-window, low-buffer, skip-refill, moment:*, phase-change, …).
 */
const USER_INITIATED_REASONS = new Set([
  "initial",
  "manual",
  "device-ready",
  "skip-next",
  "skip-previous",
  "music-wish",
  "music-wish-undo",
  "kids-mode",
  "kids-mode-off",
  "geo-manual",
  "taste-override",
  "tidal-fallback",
]);
/**
 * Explicit "vibe shift" toggles (Kids on/off). These force fresh candidate generation (so the new
 * lenses actually run), rebuild the upcoming queue, and start the freshly-curated anchor immediately
 * — so the driver hears the change at once instead of waiting out the append-only Spotify queue.
 */
const VIBE_SHIFT_REASONS = new Set(["kids-mode", "kids-mode-off"]);
const COUNTRY_NAME_BY_CODE: Record<string, string> = {
  AT: "Austria",
  CH: "Switzerland",
  DE: "Germany",
  ES: "Spain",
  FR: "France",
  GB: "United Kingdom",
  IT: "Italy",
  NL: "Netherlands",
  US: "United States",
};

import type { AppConfig } from "../config/env.js";
import { contextFromJourney, type Store } from "../db/store.js";
import { forwardGeocodeFor, geocodeFor } from "../telemetry/geocoder.js";
import type { TidalAuthService } from "../auth/tidalAuth.js";
import type { SpotifyAuthService } from "../auth/spotifyAuth.js";
import type { TeslaLiveReader } from "../telemetry/teslaFleetPoller.js";

export interface StartJourneyInput {
  destination: string;
  userPrompt: string;
  passengerMode: "solo" | "couple" | "family" | "friends";
  provider?: StreamingProvider;
  deviceId?: string;
  /**
   * Defend the start device for the journey (passive Connect-follow / auto-adopt won't rebind away
   * from it), exactly like an explicit picker tap. Set when Spotify is already playing on the
   * driver's chosen Connect device at start (the regular flow) so playback can't bounce to a
   * transient/foreign active device right after start. Ignored without a deviceId.
   */
  lockDevice?: boolean;
}

/** Minimal structured logger (satisfied by the Fastify/pino logger). */
export interface JourneyLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const noopLogger: JourneyLogger = {
  info() {},
  warn() {},
  error() {},
};

export class JourneyService {
  /** One in-flight analyze per journey; global chain avoids Spotify 429 dogpiles. */
  private readonly analyzeByJourney = new Map<
    string,
    Promise<PlaylistUpdate>
  >();
  private analyzeGlobalChain: Promise<void> = Promise.resolve();
  /** Last autoplay-reclaim attempt per journey — prevents fighting a user who chose Spotify. */
  private readonly reclaimAttemptAt = new Map<string, number>();
  /**
   * The locked Connect device id per journey. While a lock is live, passive Connect-follow /
   * auto-adopt won't rebind away to a transient active device and playback commands target the
   * locked device — so a "play on the Tesla" choice isn't silently lost. Set when the device is
   * established (explicit pick, auto-adopt, or a deviceId at start); cleared only when the journey
   * stops or a new choice replaces it.
   */
  private readonly lockedDeviceByJourney = new Map<string, string>();
  /** Journeys with a candidate-pool pre-warm in flight (dedupe; never two at once). */
  private readonly prewarmInFlight = new Set<string>();
  /** Per-journey, per-moment-type last-fire timestamp (cooldown enforcement). */
  private readonly lastMomentAt = new Map<string, Map<string, number>>();
  /** Pending journey moment consumed by the next analysis pass. */
  private readonly activeMoment = new Map<string, JourneyMoment>();
  /** Last observed playback progress per journey (native-skip heuristic). */
  private readonly lastProgress = new Map<
    string,
    { providerTrackId: string; progressMs: number; durationMs: number }
  >();
  /** Session learning signal accumulated from skips (per journey). */
  private readonly skipFeedback = new Map<
    string,
    { artists: Map<string, number>; moodTags: Map<string, number> }
  >();
  /** On-demand live telemetry reader (injected post-construction; absent in mock/tests). */
  private liveTelemetryReader?: TeslaLiveReader;
  /**
   * AlbumSource backed by the Spotify adapter — wraps getArtistAlbums / getNewReleases with an
   * in-memory TTL cache keyed by artist id (mirroring the moment-cooldown Map pattern).
   * Undefined when the adapter lacks the methods (best-effort, no crash).
   */
  private readonly freshAlbumSource: AlbumSource | undefined;
  /**
   * In-memory album cache keyed by artist id (plus a reserved key for the curated new-releases
   * feed): { at: epoch ms, albums }. Restart-loss is acceptable (same as moment cooldowns).
   * TTL = FRESH_CACHE_HOURS.
   */
  private readonly freshAlbumCache = new Map<
    string,
    { at: number; albums: SpotifyAlbum[] }
  >();
  /**
   * Cached taste artists with Spotify ids — populated alongside the TasteProfile by loadTasteProfile.
   * Used as seed for the release-radar candidate source.
   */
  private cachedTasteArtistsWithIds:
    | Array<{ id: string; name: string }>
    | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly tidalAuth: TidalAuthService,
    private readonly tidalAdapter: TidalAdapter,
    private readonly spotifyAuth: SpotifyAuthService,
    private readonly spotifyAdapter: SpotifyAdapter,
    private readonly songScout: SongScout,
    private readonly openMusic: OpenMusicClient | NoopOpenMusicClient,
    private readonly lastfmCharts?: LastfmChartClient,
    private readonly logger: JourneyLogger = noopLogger,
  ) {
    if (typeof this.spotifyAdapter.getArtistAlbums === "function") {
      const adapter = this.spotifyAdapter;
      const cacheMap = this.freshAlbumCache;
      const getCacheHours = () => this.config.FRESH_CACHE_HOURS;
      const getAccessToken = () => this.spotifyAuth.getAccessToken();
      // Reserved cache key for the curated new-releases feed; ':' never appears in a Spotify id.
      const NEW_RELEASES_KEY = "::new-releases::";
      const cachedFetch = async (
        key: string,
        fetchAlbums: (token: string) => Promise<SpotifyAlbum[]>,
      ): Promise<SpotifyAlbum[]> => {
        const now = Date.now();
        const cached = cacheMap.get(key);
        if (cached && now - cached.at < getCacheHours() * 3_600_000) {
          return cached.albums;
        }
        let token: string;
        try {
          token = await getAccessToken();
        } catch {
          return [];
        }
        const albums = await fetchAlbums(token);
        cacheMap.set(key, { at: now, albums });
        return albums;
      };
      this.freshAlbumSource = {
        getArtistAlbums: (artistId: string) =>
          cachedFetch(artistId, (accessToken) =>
            adapter.getArtistAlbums!({ accessToken, artistId }),
          ),
        getNewReleases: adapter.getNewReleases
          ? () =>
              cachedFetch(NEW_RELEASES_KEY, (accessToken) =>
                adapter.getNewReleases!({ accessToken }),
              )
          : undefined,
      };
    }
  }

  /**
   * Wires the on-demand Tesla reader after construction so a journey can seed its first queue with a
   * live reading. Optional: without it (mock mode, tests) the engine just waits for the poller.
   */
  setLiveTelemetryReader(reader: TeslaLiveReader): void {
    this.liveTelemetryReader = reader;
  }

  /**
   * Best-effort: pull one live telemetry reading *now* and persist it, so the journey's very first
   * analysis already reflects real region / ETA / phase instead of waiting up to a full
   * `TESLA_POLL_SECONDS` for the background poller. Never throws and never triggers a recurate — the
   * `initial` analyze that follows consumes the freshly saved telemetry.
   */
  private async seedLiveTelemetry(journeyId: string): Promise<void> {
    const reader = this.liveTelemetryReader;
    if (!reader?.available()) return;
    // Fully guarded: a slow/failed read or any store write must never abort journey creation. The
    // tighter timeout keeps the worst-case stall on the "Start" tap small (often a cache hit anyway,
    // since the start screen just read moments earlier).
    try {
      const event = await reader.read(3_000);
      if (!event) return;
      const journey = this.store.getJourney(journeyId);
      if (!journey) return;
      this.persistTelemetryReading(journey, event);
      this.store.audit(
        journeyId,
        "telemetry.seeded",
        "Seeded the first queue with a live telemetry reading.",
      );
    } catch (error) {
      this.logger.warn(
        {
          journeyId,
          err: error instanceof Error ? error.message : String(error),
        },
        "telemetry.seed_error",
      );
    }
  }

  /**
   * Persists one telemetry reading for a journey: derives the phase, captures the planned trip
   * duration on the first usable ETA, saves the reading, and advances the stored phase if it changed.
   * Pure store writes — no analysis — so both the live poll/ingest path and the start-up seed share
   * exactly one persistence rule. Returns the derived phase so callers can decide whether to recurate.
   */
  private persistTelemetryReading(
    journey: JourneyRecord,
    event: NormalizedTelemetryEvent,
  ): JourneyPhase {
    const phase = derivePhase(event, journey.phase);
    if (
      journey.plannedDurationMinutes === undefined &&
      typeof event.etaMinutes === "number" &&
      event.etaMinutes > 0
    ) {
      this.store.setPlannedDurationMinutes(journey.id, event.etaMinutes);
    }
    this.store.saveTelemetry(journey.id, event, phase);
    // Telemetry arriving means the car is on / driving → keep the journey alive (inactivity auto-stop).
    this.store.touchJourneyActivity(journey.id);
    if (event.countryName || event.countryCode || event.coarseRegion) {
      // Persist the last real GPS fix so the country survives telemetry gaps / app reloads.
      this.store.setLastGeo(journey.id, {
        countryName: event.countryName,
        countryCode: event.countryCode,
        coarseRegion: event.coarseRegion,
        source: event.geoSource === "manual" ? "manual" : "reverse-geocode",
      });
    }
    // Track the car's current nav target (the next charge stop or final destination) so the cockpit
    // can show the next stop. The immutable journey.destination stays the final target.
    if (
      typeof event.destination === "string" &&
      event.destination.length > 0 &&
      event.destination !== journey.currentDestination
    ) {
      this.store.updateJourneyCurrentDestination(journey.id, event.destination);
    }
    if (phase !== journey.phase) {
      this.store.updateJourneyPhase(journey.id, phase);
    }
    return phase;
  }

  /**
   * Seeds the journey's geo fallback from its destination text (forward geocode) when no location is
   * known yet. Runs at most once per journey (the persisted seed makes later calls cheap no-ops) and
   * never overwrites a real GPS fix. Best-effort: any failure leaves the journey geo-less as before.
   */
  private async ensureBaselineGeo(journey: JourneyRecord): Promise<void> {
    if (journey.lastGeo?.countryName || journey.lastGeo?.countryCode) return;
    const latest = this.store.latestTelemetry(journey.id);
    if (latest?.countryName || latest?.countryCode) return;
    const result = await forwardGeocodeFor(journey.destination, {
      baseUrl: this.config.GEOCODER_SEARCH_URL,
    }).catch(() => undefined);
    if (!result) return;
    this.store.setLastGeo(journey.id, {
      countryName: result.countryName,
      countryCode: result.countryCode,
      coarseRegion: result.coarseRegion,
      source: "destination",
    });
    this.store.audit(
      journey.id,
      "geo.baseline_seeded",
      `Seeded location from destination: ${result.coarseRegion ?? result.countryName ?? journey.destination}.`,
      { source: "destination" },
    );
  }

  /**
   * Browser-geolocation fallback: reverse-geocodes coordinates the web client obtained from the
   * device (Tesla browser / phone) and stores them as the last-known location. Higher-confidence than
   * the destination seed; deferred to live telemetry when that's present (see store.setLastGeo).
   */
  async setBrowserGeo(
    journeyId: string,
    lat: number,
    lon: number,
  ): Promise<void> {
    const journey = this.store.getJourney(journeyId);
    if (!journey || journey.status !== "active") return;
    const result = await geocodeFor(lat, lon, {
      baseUrl: this.config.GEOCODER_URL,
    }).catch(() => undefined);
    if (!result) return;
    this.store.setLastGeo(journeyId, {
      countryName: result.countryName,
      countryCode: result.countryCode,
      coarseRegion: result.coarseRegion,
      source: "browser-gps",
    });
    this.store.audit(
      journeyId,
      "geo.browser_fix",
      `Browser location: ${result.coarseRegion ?? result.countryName ?? "unknown"}.`,
      { source: "browser-gps" },
    );
  }

  /**
   * Manual location override: the driver types a place ("Marseille", "France"); we forward-geocode it
   * and pin it as the highest-confidence geo (wins over auto-detection until they cross into a
   * different country or revert). A blank place clears the override. Re-curates immediately.
   */
  async setManualGeo(journeyId: string, place: string): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot set the location of a stopped journey.");
    }
    const trimmed = place.trim();
    if (!trimmed) {
      this.store.clearLastGeo(journeyId);
      this.store.audit(
        journeyId,
        "geo.manual_cleared",
        "Manual location cleared — back to auto-detection.",
        {},
      );
      await this.analyzeJourney(journeyId, "geo-manual");
      return this.getJourneyOrThrow(journeyId);
    }
    const result = await forwardGeocodeFor(trimmed, {
      baseUrl: this.config.GEOCODER_SEARCH_URL,
    }).catch(() => undefined);
    if (!result) {
      throw new Error(`Couldn't find a place called "${trimmed}".`);
    }
    this.store.setLastGeo(journeyId, {
      countryName: result.countryName,
      countryCode: result.countryCode,
      coarseRegion: result.coarseRegion,
      source: "manual",
    });
    this.store.audit(
      journeyId,
      "geo.manual_set",
      `Manual location: ${result.coarseRegion ?? result.countryName ?? trimmed}.`,
      { source: "manual" },
    );
    await this.analyzeJourney(journeyId, "geo-manual");
    return this.getJourneyOrThrow(journeyId);
  }

  async startJourney(input: StartJourneyInput): Promise<JourneyRecord> {
    const provider = input.provider ?? "spotify";
    const id = crypto.randomUUID();
    const createdAtIso = new Date().toISOString();
    const journey: JourneyRecord = {
      id,
      provider,
      destination: input.destination,
      userPrompt: input.userPrompt,
      passengerMode: input.passengerMode,
      phase: "departure",
      status: "active",
      tasteWeight: DEFAULT_TASTE_WEIGHT,
      spotifyDeviceId: provider === "spotify" ? input.deviceId : undefined,
      createdAtIso,
    };

    this.store.createJourney(journey);
    this.store.audit(id, "journey.created", "Journey started.", {
      destination: input.destination,
      provider,
    });

    if (provider === "tidal") {
      await this.ensureTidalPlaylist(id, input.destination);
    } else {
      this.saveSession({
        journeyId: id,
        provider: "spotify",
        deviceId: input.deviceId,
        status: input.deviceId ? "ready" : "idle",
        queuedTrackIds: [],
        targetBufferSize: 5,
        lastHeartbeatAt: new Date().toISOString(),
      });
      // Spotify is already playing on the driver's chosen Connect device (the regular flow: the
      // native Tesla app) → lock it for the journey before the first analyze, so curation/start
      // targets it and the passive Connect-follow can't bounce playback to a transient/foreign
      // active device right after start. Same defended treatment as an explicit picker tap.
      if (input.deviceId && input.lockDevice) {
        this.lockDevice(id, input.deviceId);
      }
    }

    // Pull a live reading right now so the first queue is context-aware (region / ETA / phase),
    // rather than blind until the next background poll. Best-effort and time-boxed; degrades silently.
    await this.seedLiveTelemetry(id);

    try {
      await this.analyzeJourney(id, "initial");
    } catch (error) {
      await this.stopJourney(id);
      throw error;
    }
    return this.getJourneyOrThrow(id);
  }

  getJourneyOrThrow(id: string): JourneyRecord {
    const journey = this.store.getJourney(id);
    if (!journey) {
      throw new Error("Journey not found.");
    }
    return journey;
  }

  async stopJourney(id: string): Promise<JourneyRecord> {
    this.lockedDeviceByJourney.delete(id);
    this.store.stopJourney(id);
    this.store.audit(id, "journey.stopped", "Journey stopped.");
    return this.getJourneyOrThrow(id);
  }

  async ingestTelemetry(event: NormalizedTelemetryEvent): Promise<void> {
    const active = this.store.listActiveJourneys();
    for (const journey of active) {
      const phase = this.persistTelemetryReading(journey, event);
      if (phase !== journey.phase) {
        this.store.audit(
          journey.id,
          "telemetry.phase_changed",
          `Journey phase changed to ${phase}.`,
        );
        await this.analyzeJourney(journey.id, "phase-change");
        continue; // the phase re-curation already reflects the latest telemetry
      }
      await this.evaluateDriveMode(journey.id);
      await this.evaluateJourneyMoments(journey.id).catch(() => undefined);
    }
  }

  /** Momente-Erkennung am Telemetrie-Ingest; feuert eine vibe-changing Analyse. */
  async evaluateJourneyMoments(journeyId: string): Promise<void> {
    if (!this.config.MOMENTS_ENABLED) return;
    const journey = this.store.getJourney(journeyId);
    if (
      !journey ||
      journey.provider !== "spotify" ||
      journey.status !== "active"
    )
      return;
    const telemetry = this.store.latestTelemetry(journeyId);
    const history = this.store.recentTelemetry(journeyId, 6);
    const context = contextFromJourney(journey, telemetry, history);
    const perJourney =
      this.lastMomentAt.get(journeyId) ?? new Map<string, number>();
    this.lastMomentAt.set(journeyId, perJourney);
    const story = driveStoryAct({
      elapsedMinutes: context.elapsedMinutes,
      plannedDurationMinutes: context.plannedDurationMinutes,
      etaMinutes: context.etaMinutes,
      isFirstPass: !this.store.latestPlaylistUpdate(journeyId),
      arrivalWindowMinutes: this.config.ARRIVAL_MOMENT_MINUTES,
    });
    const moment = detectJourneyMoment({
      context,
      history,
      previousPhase: journey.phase,
      act: story.act,
      lastMomentAt: perJourney,
      nowMs: Date.now(),
      config: {
        jamDelayMinutes: this.config.TRAFFIC_JAM_DELAY_MINUTES,
        releaseDelayMinutes: this.config.TRAFFIC_RELEASE_DELAY_MINUTES,
        cooldownMs: this.config.MOMENT_COOLDOWN_MINUTES * 60 * 1000,
        arrivalWindowMinutes: this.config.ARRIVAL_MOMENT_MINUTES,
      },
    });
    if (!moment) return;
    if (
      moment.type === "arrival" &&
      this.store.latestAuditEvent(journeyId, "moment.arrival_fired")
    ) {
      return; // einmal pro Journey
    }
    perJourney.set(moment.type, Date.now());
    this.activeMoment.set(journeyId, moment);
    this.store.audit(journeyId, "moment.triggered", moment.directive, {
      type: moment.type,
      // Surfaced to the cockpit family-event banner (e.g. "Welcome to Italy!").
      country:
        moment.candidateRequest?.kind === "geo-charts"
          ? moment.candidateRequest.country
          : undefined,
    });
    if (moment.type === "arrival") {
      this.store.audit(
        journeyId,
        "moment.arrival_fired",
        "Arrival anthem scheduled.",
        {},
      );
    }
    if (moment.type === "charge_resume") {
      // A completed charge stop starts a new leg — each leg opens its own arc. Stamp the leg start
      // so the brief can reset trip progress per leg (fresh opening → build).
      const nextLeg = (journey.legIndex ?? 0) + 1;
      this.store.updateJourneyLegIndex(
        journeyId,
        nextLeg,
        new Date().toISOString(),
      );
      this.store.audit(
        journeyId,
        "moment.charge_resume_leg",
        `Charge stop done — starting leg ${nextLeg + 1}.`,
        { legIndex: nextLeg },
      );
    }
    try {
      await this.analyzeJourney(journeyId, `moment:${moment.type}`);
    } catch (error) {
      this.logger.warn(
        {
          journeyId,
          err: error instanceof Error ? error.message : String(error),
        },
        "moment.recurate_error",
      );
    }
  }

  /** Test-/Diagnose-Zugriff auf das Session-Lernsignal. */
  skipFeedbackFor(journeyId: string): {
    artists: Map<string, number>;
    moodTags: Map<string, number>;
  } {
    const entry = this.skipFeedback.get(journeyId) ?? {
      artists: new Map<string, number>(),
      moodTags: new Map<string, number>(),
    };
    this.skipFeedback.set(journeyId, entry);
    return entry;
  }

  private recordSkipFeedback(
    journeyId: string,
    track: { artist: string; moodTags?: string[] },
  ): void {
    if (!this.config.SKIP_FEEDBACK_ENABLED) return;
    const entry = this.skipFeedbackFor(journeyId);
    const artistKey = normalizeText(track.artist);
    entry.artists.set(
      artistKey,
      Math.min(
        1,
        (entry.artists.get(artistKey) ?? 0) +
          this.config.SKIP_FEEDBACK_ARTIST_PENALTY,
      ),
    );
    for (const tag of track.moodTags ?? []) {
      const key = normalizeText(tag);
      entry.moodTags.set(
        key,
        Math.min(0.6, (entry.moodTags.get(key) ?? 0) + 0.15),
      );
    }
    this.store.audit(
      journeyId,
      "feedback.skip_learned",
      `Skip-Signal: ${track.artist}`,
      { artist: track.artist },
    );
  }

  /**
   * Adaptive Drive Mode: classify the situation from recent telemetry, apply hysteresis, and re-curate
   * when the engaged mode actually flips. Comfort feature — biases selection only; never throws.
   */
  private async evaluateDriveMode(journeyId: string): Promise<void> {
    if (!this.config.ADAPTIVE_DRIVE_MODE_ENABLED) return;
    const journey = this.store.getJourney(journeyId);
    if (!journey || journey.adaptiveModeEnabled === false) return;

    // recentTelemetry returns newest-first; sort to oldest→newest for the classifier.
    const recent = [...this.store.recentTelemetry(journeyId, 5)].sort(
      (a, b) => Date.parse(a.timestampIso) - Date.parse(b.timestampIso),
    );
    if (recent.length === 0) return;

    const now = recent[recent.length - 1].timestampIso;
    const raw = assessDriveState(recent, now);
    // Derive the previous poll's raw mode from history (no extra state to persist). With only one
    // snapshot the history is unknown → treat as neutral so a fresh mode genuinely needs two polls.
    const rawPrev =
      recent.length >= 2
        ? assessDriveState(
            recent.slice(0, -1),
            recent[recent.length - 2].timestampIso,
          )
        : { mode: "neutral" as const, reason: "", intensity: 0, signals: [] };
    const engagedPrev = journey.driveMode ?? "neutral";
    const engagedNew = stabilizeDriveMode(
      engagedPrev,
      [rawPrev.mode, raw.mode],
      2,
    );

    if (engagedNew === engagedPrev) return;
    this.store.updateJourneyDriveMode(journeyId, engagedNew);
    this.store.audit(
      journeyId,
      "drive_mode.changed",
      `Adaptive Drive Mode → ${engagedNew}${raw.reason ? ` (${raw.reason})` : ""}.`,
      {
        mode: engagedNew,
        reason: raw.reason,
        signals: raw.signals,
      },
    );
    try {
      await this.analyzeJourney(journeyId, `drive-state:${engagedNew}`);
    } catch (error) {
      this.logger.warn(
        {
          journeyId,
          err: error instanceof Error ? error.message : String(error),
        },
        "drive_mode.recurate_error",
      );
    }
  }

  async createMusicWish(
    journeyId: string,
    input: {
      text: string;
      source: MusicWishSource;
      apply?: boolean;
      pinned?: boolean;
    },
  ): Promise<{ wish: MusicWish }> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot add a music wish to a stopped journey.");
    }
    const parsed = parseMusicWish(input.text);
    const createdAtIso = new Date().toISOString();
    const wish: MusicWish = {
      id: crypto.randomUUID(),
      journeyId,
      rawText: parsed.rawText,
      source: input.source,
      intents: parsed.intents,
      status: parsed.status,
      confidence: parsed.confidence,
      summary: parsed.summary,
      pinned: input.pinned ?? false,
      expiresAfterTracks: 5,
      remainingTracks: 5,
      createdAtIso,
      updatedAtIso: createdAtIso,
    };
    this.store.saveMusicWish(wish);
    this.store.audit(journeyId, "music_wish.created", wish.summary, {
      wishId: wish.id,
      status: wish.status,
    });
    if (wish.status === "active" && input.apply !== false) {
      // Curation runs in the background — the wish response must be instant. Failures land
      // in the existing analysis.failed audit; analysisPending clears via the in-flight map.
      void this.analyzeJourney(journeyId, "music-wish").catch(() => undefined);
    }
    return { wish: this.store.getMusicWish(journeyId, wish.id) ?? wish };
  }

  async updateMusicWish(
    journeyId: string,
    wishId: string,
    patch: { pinned?: boolean; status?: MusicWishStatus },
  ): Promise<MusicWish> {
    this.getJourneyOrThrow(journeyId);
    this.store.updateMusicWish(journeyId, wishId, patch);
    const wish = this.store.getMusicWish(journeyId, wishId);
    if (!wish) throw new Error("Music wish not found.");
    this.store.audit(journeyId, "music_wish.updated", wish.summary, {
      wishId,
      pinned: wish.pinned,
      status: wish.status,
    });
    return wish;
  }

  async undoMusicWish(journeyId: string, wishId: string): Promise<MusicWish> {
    const wish = await this.updateMusicWish(journeyId, wishId, {
      status: "undone",
    });
    // Re-curate only while the journey is still running; the undo itself is
    // already persisted, so a stopped journey must not surface as a failed undo.
    if (this.getJourneyOrThrow(journeyId).status === "active") {
      void this.analyzeJourney(journeyId, "music-wish-undo").catch(
        () => undefined,
      );
    }
    return wish;
  }

  async analyzeJourney(
    journeyId: string,
    reason = "manual",
  ): Promise<PlaylistUpdate> {
    const inFlight = this.analyzeByJourney.get(journeyId);
    if (inFlight) {
      return inFlight;
    }

    const run = this.analyzeGlobalChain
      .catch(() => undefined)
      .then(() => this.analyzeJourneyBody(journeyId, reason));
    this.analyzeGlobalChain = run.then(
      () => undefined,
      () => undefined,
    );

    const tracked = run.finally(() => {
      if (this.analyzeByJourney.get(journeyId) === tracked) {
        this.analyzeByJourney.delete(journeyId);
      }
    });
    this.analyzeByJourney.set(journeyId, tracked);
    // The pool only shrinks during analysis passes, so post-analysis is complete trigger
    // coverage for pre-warming (fire-and-forget; runs after the in-flight map cleared).
    void tracked
      .catch(() => undefined)
      .then(() => this.maybePrewarmCandidatePool(journeyId))
      .catch(() => undefined);
    return tracked;
  }

  /** True while a (re-)curation pass for this journey is in flight. */
  isAnalysisPending(journeyId: string): boolean {
    return this.analyzeByJourney.has(journeyId);
  }

  /**
   * Keeps a reserve of unused, playable resolved tracks per journey so refills never have
   * to wait for LLM generation mid-drive. Cost-neutral: gated by the same shouldRegenerate
   * throttle as refills — generation is only moved EARLIER, never made more frequent.
   */
  private async maybePrewarmCandidatePool(journeyId: string): Promise<void> {
    if (this.config.CANDIDATE_POOL_FLOOR <= 0) return;
    if (this.prewarmInFlight.has(journeyId)) return;
    if (this.analyzeByJourney.has(journeyId)) return;
    const journey = this.store.getJourney(journeyId);
    if (
      !journey ||
      journey.provider !== "spotify" ||
      journey.status !== "active"
    )
      return;

    const session = this.store.getPlaybackSession(journeyId);
    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    const consumed = new Set<string>([
      ...(session?.queuedTrackIds ?? []),
      ...(session?.playedTrackIds ?? []),
      ...(session?.activeTrack?.id ? [session.activeTrack.id] : []),
    ]);
    const unused = stored.filter(
      (track) =>
        track.providerUri &&
        track.isPlayable !== false &&
        !track.addedToPlaylist &&
        !consumed.has(track.id),
    );
    if (unused.length >= this.config.CANDIDATE_POOL_FLOOR) return;

    const last = this.store.latestPlaylistUpdate(journeyId);
    const minIntervalMs =
      this.config.SPOTIFY_REFILL_MIN_INTERVAL_SECONDS * 1000;
    if (!shouldRegenerate(last?.createdAtIso, Date.now(), minIntervalMs))
      return;

    this.prewarmInFlight.add(journeyId);
    try {
      const telemetry = this.store.latestTelemetry(journeyId);
      const context = contextFromJourney(
        journey,
        telemetry,
        this.store.recentTelemetry(journeyId),
      );
      const activeMusicWishes = this.store.listActiveMusicWishes(journeyId);
      const variety = makeVarietyContext({
        journeyId,
        elapsedMinutes: context.elapsedMinutes,
        bucketMinutes: this.config.VARIETY_BUCKET_MINUTES,
        phase: context.phase,
        speedBucket: context.speedBucket,
        driveMode: context.driveState?.mode ?? journey.driveMode,
      });
      const prewarmContext: JourneyContext = {
        ...context,
        activeMusicWishes,
        varietyAngle: seededExplorationAngle(variety.seed),
      };
      const policy = applyMusicWishesToPolicy(
        buildRecommendationPolicy(prewarmContext),
        activeMusicWishes,
      );
      const accessToken = await this.spotifyAuth.getAccessToken();
      const candidates = await this.generateAndStoreCandidateSet(
        journeyId,
        prewarmContext,
        policy,
        8,
        variety.seed,
      );
      const resolver = new SpotifyResolver(this.spotifyAdapter, {
        accessToken,
        market: this.config.SPOTIFY_MARKET,
        searchTimeoutMs: 8_000,
        targetResolveCount: policy.cleanRequired ? 12 : 10,
        cache: {
          get: (key) => this.store.getCachedSpotifySearch(key),
          set: (key, value) => this.store.saveCachedSpotifySearch(key, value),
        },
      });
      const storedBefore = this.store
        .listResolvedTracks(journeyId)
        .filter((track) => track.provider === "spotify").length;
      const resolved = await resolver.resolveCandidates(candidates);
      this.storeResolved(journeyId, candidates, resolved);
      const added =
        this.store
          .listResolvedTracks(journeyId)
          .filter((track) => track.provider === "spotify").length -
        storedBefore;
      this.store.audit(
        journeyId,
        "recommendation.pool_prewarmed",
        `Pre-warmed the candidate pool (+${added} new resolved tracks).`,
        {
          resolved: resolved.length,
          added,
          floor: this.config.CANDIDATE_POOL_FLOOR,
        },
      );
    } catch (error) {
      this.logger.warn(
        {
          journeyId,
          err: error instanceof Error ? error.message : String(error),
        },
        "recommendation.prewarm_failed",
      );
    } finally {
      this.prewarmInFlight.delete(journeyId);
    }
  }

  private async analyzeJourneyBody(
    journeyId: string,
    reason: string,
  ): Promise<PlaylistUpdate> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot analyze a stopped journey.");
    }

    // Seed a geo baseline from the destination once, so "local touch" works before/without live GPS.
    await this.ensureBaselineGeo(journey);

    const startedAt = Date.now();
    this.logger.info(
      { journeyId, reason, provider: journey.provider },
      "journey.analyze.start",
    );
    this.store.clearAuditEvents(journeyId, "analysis.failed");
    try {
      const update =
        journey.provider === "tidal"
          ? await this.analyzeTidalJourney(journey, reason)
          : await this.analyzeSpotifyJourney(journey, reason);
      const trackCount = this.store.listResolvedTracks(journeyId).length;
      if (trackCount > 0) {
        this.store.clearAuditEvents(journeyId, "analysis.failed");
      }
      this.logger.info(
        {
          journeyId,
          reason,
          status: update.status,
          batchSize: update.batchSize,
          trackCount,
          ms: Date.now() - startedAt,
        },
        "journey.analyze.done",
      );
      return update;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { journeyId, reason, ms: Date.now() - startedAt, err: message },
        "journey.analyze.failed",
      );
      this.store.audit(journeyId, "analysis.failed", message, { reason });
      throw error;
    }
  }

  async setPhase(
    journeyId: string,
    phase: JourneyPhase,
  ): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot change the phase of a stopped journey.");
    }
    this.store.updateJourneyPhase(journeyId, phase);
    this.store.audit(
      journeyId,
      "phase.manual_override",
      `Drive phase manually set to ${phase}.`,
      { phase },
    );
    await this.analyzeJourney(journeyId, "phase-override");
    return this.getJourneyOrThrow(journeyId);
  }

  /** Sets the familiarity↔discovery mix (0..1) and re-curates the queue around it. */
  async setTasteWeight(
    journeyId: string,
    weight: number,
  ): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot change the taste mix of a stopped journey.");
    }
    const clamped = Math.max(0, Math.min(1, weight));
    this.store.updateJourneyTasteWeight(journeyId, clamped);
    this.store.audit(
      journeyId,
      "taste.weight_set",
      `Vibe mix set to ${Math.round(clamped * 100)}% familiar.`,
      {
        tasteWeight: clamped,
      },
    );
    await this.analyzeJourney(journeyId, "taste-override");
    return this.getJourneyOrThrow(journeyId);
  }

  /**
   * "Kids am Steuer": toggle the kids bias and re-curate immediately so the change is felt at once.
   * Lets Disney/film/animated singalongs in (which family mode otherwise avoids) while staying clean.
   */
  async setKidsMode(
    journeyId: string,
    enabled: boolean,
  ): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.status !== "active") {
      throw new Error("Cannot change kids mode of a stopped journey.");
    }
    this.store.setKidsMode(journeyId, enabled);
    this.store.audit(
      journeyId,
      "kids_mode.toggled",
      `Kids mode ${enabled ? "enabled" : "disabled"}.`,
      { enabled },
    );
    // Distinct reason for OFF so the queue rebuild also flushes the now-stale kids tracks.
    await this.analyzeJourney(
      journeyId,
      enabled ? "kids-mode" : "kids-mode-off",
    );
    return this.getJourneyOrThrow(journeyId);
  }

  /**
   * Device-independent playback position for the karaoke view — works on the car's / phone's native
   * Spotify (Connect) too, not just the in-browser SDK player. Best-effort: degrades to not-playing on
   * any error so the cockpit simply shows static lyrics. `activeProviderTrackId`/`durationMs` let the
   * client request a duration-matched lyrics version for the *actually playing* track.
   */
  async getPlaybackProgress(journeyId: string): Promise<{
    progressMs?: number;
    durationMs?: number;
    isPlaying: boolean;
    activeProviderTrackId?: string;
  }> {
    const journey = this.store.getJourney(journeyId);
    if (!journey || journey.provider !== "spotify") {
      return { isPlaying: false };
    }
    try {
      const accessToken = await this.spotifyAuth.getAccessToken();
      const state = await this.spotifyAdapter.getPlaybackState({
        accessToken,
        market: this.config.SPOTIFY_MARKET,
      });
      return {
        progressMs: state.progressMs,
        durationMs: state.durationMs,
        isPlaying: state.isPlaying,
        activeProviderTrackId: state.activeProviderTrackId,
      };
    } catch {
      return { isPlaying: false };
    }
  }

  /** Per-journey master switch for Adaptive Drive Mode. Disabling clears any engaged mode. */
  async setAdaptiveMode(
    journeyId: string,
    enabled: boolean,
  ): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    this.store.setAdaptiveModeEnabled(journeyId, enabled);
    if (!enabled && journey.driveMode && journey.driveMode !== "neutral") {
      this.store.updateJourneyDriveMode(journeyId, "neutral");
    }
    this.store.audit(
      journeyId,
      "drive_mode.toggled",
      `Adaptive Drive Mode ${enabled ? "enabled" : "disabled"}.`,
      {
        enabled,
      },
    );
    return this.getJourneyOrThrow(journeyId);
  }

  /**
   * Loads the listener's taste profile (top artists → favored genres) for personalization.
   * Cached ~24h so the Spotify API is touched at most once/day; any failure degrades to no taste.
   * Also caches the raw {id, name} artists for the release-radar source in cachedTasteArtistsWithIds.
   */
  private async loadTasteProfile(
    accessToken: string,
  ): Promise<TasteProfile | undefined> {
    try {
      const cached = this.store.getCachedTasteProfile("local");
      if (cached) {
        // On a DB cache hit, cachedTasteArtistsWithIds is empty after a restart (in-memory only).
        // Re-fetch top artists best-effort so the release-radar source has its seed even without
        // waiting for the ~24h profile TTL to expire.
        if (!this.cachedTasteArtistsWithIds && this.spotifyAdapter.getTopArtists) {
          try {
            const artists = await this.spotifyAdapter.getTopArtists({
              accessToken,
              timeRange: "medium_term",
              limit: 30,
              signal: AbortSignal.timeout(TASTE_FETCH_TIMEOUT_MS),
            });
            this.cachedTasteArtistsWithIds = artists
              .filter((a) => a.id && a.name)
              .map((a) => ({ id: a.id, name: a.name }));
          } catch {
            // Best-effort: if the fetch fails the release-radar source simply produces nothing
            // this session, which is the same degraded behaviour as before this fix.
          }
        }
        return cached;
      }
      if (!this.spotifyAdapter.getTopArtists) {
        return undefined;
      }
      const artists = await this.spotifyAdapter.getTopArtists({
        accessToken,
        timeRange: "medium_term",
        limit: 30,
        signal: AbortSignal.timeout(TASTE_FETCH_TIMEOUT_MS),
      });
      if (artists.length === 0) {
        return undefined;
      }
      const profile = deriveTasteProfile(artists);
      this.store.saveCachedTasteProfile("local", profile);
      // Stash artist ids for the release-radar source (in-memory, restart-loss acceptable).
      this.cachedTasteArtistsWithIds = artists
        .filter((a) => a.id && a.name)
        .map((a) => ({ id: a.id, name: a.name }));
      return profile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: message }, "taste.load.failed");
      return undefined;
    }
  }

  /** The locked Connect device id for a journey, or undefined if none is locked. */
  private getLockedDeviceId(journeyId: string): string | undefined {
    return this.lockedDeviceByJourney.get(journeyId);
  }

  /**
   * Lock a journey to a Connect device so the passive Connect-follow / auto-adopt can't rebind away
   * from it and playback commands target it. No-op when device locking is disabled. The single
   * writer for the lock — every establishment path (explicit pick, auto-adopt, start) routes here.
   */
  private lockDevice(journeyId: string, deviceId: string): void {
    if (!this.config.PLAYBACK_DEVICE_LOCK_ENABLED) return;
    this.lockedDeviceByJourney.set(journeyId, deviceId);
    this.store.audit(
      journeyId,
      "spotify.device_locked",
      "Locked the journey to the chosen Connect device.",
      { deviceId },
    );
  }

  /**
   * The device a playback command should target: the locked device wins (a journey defends its
   * chosen Connect device), then the caller-supplied device, then the journey/session device. The
   * single source of the lock-first targeting precedence used by skip/transport/refill.
   */
  private resolveTargetDevice(
    journeyId: string,
    journey: JourneyRecord,
    session: PlaybackSession | undefined,
    callerDeviceId?: string,
  ): string | undefined {
    return (
      this.getLockedDeviceId(journeyId) ??
      callerDeviceId ??
      journey.spotifyDeviceId ??
      session?.deviceId
    );
  }

  async registerSpotifyDevice(
    journeyId: string,
    deviceId: string,
    status: PlaybackSession["status"] = "ready",
    options: { syncOnly?: boolean; transfer?: boolean; pin?: boolean } = {},
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error("Cannot register a Spotify device for a TIDAL journey.");
    }

    const existing = this.store.getPlaybackSession(journeyId);

    // An explicit human pick (the driver tapped this device in the picker, or auto-adopt when they
    // opened Spotify on the Tesla) locks it for the journey so the passive Connect-follow can't
    // rebind away to a transient browser device. A non-locking registration passes pin:false.
    if (options.pin) {
      this.lockDevice(journeyId, deviceId);
    }

    const lockedDeviceId = this.getLockedDeviceId(journeyId);
    if (!options.pin && lockedDeviceId && lockedDeviceId !== deviceId) {
      this.store.audit(
        journeyId,
        "spotify.device_register_suppressed",
        "Kept the explicitly chosen device; ignored passive device registration.",
        { lockedDeviceId, requestedDeviceId: deviceId },
      );
      if (existing) {
        return existing;
      }
    }

    // Device affinity: a passive registration (page load, refresh) must never steal playback
    // from a device that is actively playing (e.g. the Tesla via Connect). Only an explicit
    // user choice (transfer: true) may switch devices.
    if (
      !options.transfer &&
      existing?.status === "playing" &&
      existing.deviceId &&
      existing.deviceId !== deviceId
    ) {
      this.store.audit(
        journeyId,
        "spotify.device_register_skipped",
        "Device registration skipped; another device is actively playing.",
        { requestedDeviceId: deviceId, activeDeviceId: existing.deviceId },
      );
      return existing;
    }

    this.store.updateJourneySpotifyDevice(journeyId, deviceId);
    this.saveSession({
      journeyId,
      provider: "spotify",
      deviceId,
      status,
      activeTrack: existing?.activeTrack,
      queuedTrackIds: existing?.queuedTrackIds ?? [],
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString(),
    });
    this.store.audit(
      journeyId,
      "spotify.device_ready",
      "Spotify Web Playback device registered.",
      { deviceId, status },
    );

    const hasTracks = this.store
      .listResolvedTracks(journeyId)
      .some((track) => track.provider === "spotify");
    if (options.syncOnly && hasTracks) {
      return this.syncExistingSpotifyPlayback(journeyId, deviceId);
    }

    await this.analyzeJourney(journeyId, "device-ready");
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async syncExistingSpotifyPlayback(
    journeyId: string,
    deviceId: string,
  ): Promise<PlaybackSession> {
    const accessToken = await this.spotifyAuth.getAccessToken();
    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    const session = this.store.getPlaybackSession(journeyId);
    const { activeTrack, queueTracks, queuedTrackIds } =
      this.pickSpotifyPlaybackTracks(stored, session);

    const playbackApplied = await this.syncSpotifyPlayback({
      journeyId,
      accessToken,
      deviceId,
      activeTrack,
      queueTracks,
      shouldStart: true,
      automated: false, // device registration is a user action
    });

    const playedActiveTrack = playbackApplied.deviceReachable
      ? activeTrack
      : (session?.activeTrack ?? activeTrack);
    const status = playbackApplied.deviceReachable
      ? playbackApplied.rateLimited
        ? "degraded"
        : "playing"
      : "degraded";

    this.saveSession({
      journeyId,
      provider: "spotify",
      deviceId,
      status,
      activeTrack: playedActiveTrack,
      queuedTrackIds,
      playedTrackIds: session?.playedTrackIds ?? [],
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString(),
    });

    if (playbackApplied.rateLimited) {
      this.store.audit(
        journeyId,
        "spotify.rate_limited",
        "Spotify rate limit hit while syncing playback; try Play audio again in a few seconds.",
        { deviceId },
      );
    }

    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async skipSpotifyTrack(
    journeyId: string,
    direction: "next" | "previous",
    deviceId?: string,
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error("Track skip is only supported for Spotify journeys.");
    }
    if (journey.status !== "active") {
      throw new Error("Cannot skip tracks on a stopped journey.");
    }

    const session = this.store.getPlaybackSession(journeyId);
    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    const playedIds = session?.playedTrackIds ?? [];
    const { activeTrack, queueTracks } = this.pickSpotifyPlaybackTracks(
      stored,
      session,
    );
    const effectiveDeviceId = this.resolveTargetDevice(
      journeyId,
      journey,
      session,
      deviceId,
    );
    const accessToken = await this.spotifyAuth.getAccessToken();

    if (direction === "next") {
      // Bewusster In-App-Skip → Session-Lernsignal für den übersprungenen Track.
      if (activeTrack) this.recordSkipFeedback(journeyId, activeTrack);
      if (queueTracks.length === 0) {
        await this.analyzeJourney(journeyId, "skip-next");
        const refreshed = this.store.getPlaybackSession(journeyId);
        const refreshedStored = this.store
          .listResolvedTracks(journeyId)
          .filter((track) => track.provider === "spotify");
        const picked = this.pickSpotifyPlaybackTracks(
          refreshedStored,
          refreshed,
        );
        if (effectiveDeviceId && picked.activeTrack) {
          const resolvedDeviceId =
            await this.spotifyAdapter.resolvePlaybackDeviceId({
              accessToken,
              preferredDeviceId: effectiveDeviceId,
            });
          await this.syncSpotifyPlayback({
            journeyId,
            accessToken,
            deviceId: resolvedDeviceId,
            activeTrack: picked.activeTrack,
            queueTracks: picked.queueTracks,
            shouldStart: true,
            automated: false, // explicit skip is a user action
          });
        }
        return this.store.getPlaybackSession(journeyId) as PlaybackSession;
      }

      const newActive = queueTracks[0];
      const newQueue = queueTracks.slice(1);
      const newPlayed = activeTrack?.id
        ? [...playedIds, activeTrack.id]
        : playedIds;

      if (effectiveDeviceId && newActive) {
        // Single source of truth: command Spotify to play THIS exact track and reset its context to
        // our queue, so the SDK can't drift onto its own stale queue. (The SDK only skips relatively,
        // which walks Spotify's own queue — that is what made played ≠ shown.)
        const applied = await this.playExact({
          journeyId,
          accessToken,
          deviceId: effectiveDeviceId,
          activeTrack: newActive,
          queueTracks: newQueue,
        });
        if (!applied.deviceReachable) {
          throw new Error("Could not skip to the next track on Spotify.");
        }
      }

      this.saveSession({
        journeyId,
        provider: "spotify",
        deviceId: effectiveDeviceId,
        status: effectiveDeviceId ? "playing" : "degraded",
        activeTrack: newActive,
        queuedTrackIds: newQueue.map((track) => track.id),
        playedTrackIds: newPlayed,
        targetBufferSize: 5,
        lastHeartbeatAt: new Date().toISOString(),
      });

      if (newQueue.length < 4) {
        void this.analyzeJourney(journeyId, "low-buffer").catch(
          () => undefined,
        );
      }
    } else {
      if (playedIds.length === 0) {
        throw new Error("No previous track in this journey yet.");
      }

      const previousId = playedIds[playedIds.length - 1];
      const newActive = stored.find((track) => track.id === previousId);
      if (!newActive) {
        throw new Error("Previous track is no longer available.");
      }

      const newPlayed = playedIds.slice(0, -1);
      const newQueueIds = [
        activeTrack?.id,
        ...queueTracks.map((track) => track.id),
      ].filter((id): id is string => Boolean(id));
      const newQueueTracks = newQueueIds
        .map((id) => stored.find((track) => track.id === id))
        .filter(
          (
            track,
          ): track is ResolvedTrack & {
            id: string;
            addedToPlaylist: boolean;
            savedToPlaylist: boolean;
          } => Boolean(track),
        );

      if (effectiveDeviceId) {
        // Single source of truth: play the exact previous track and reset Spotify's context to our
        // queue, so playback matches the web app instead of Spotify's own drifting queue.
        const applied = await this.playExact({
          journeyId,
          accessToken,
          deviceId: effectiveDeviceId,
          activeTrack: newActive,
          queueTracks: newQueueTracks,
        });
        if (!applied.deviceReachable) {
          throw new Error("Could not skip to the previous track on Spotify.");
        }
      }

      this.saveSession({
        journeyId,
        provider: "spotify",
        deviceId: effectiveDeviceId,
        status: effectiveDeviceId ? "playing" : "degraded",
        activeTrack: newActive,
        queuedTrackIds: newQueueIds.slice(0, 5),
        playedTrackIds: newPlayed,
        targetBufferSize: 5,
        lastHeartbeatAt: new Date().toISOString(),
      });
    }

    this.store.audit(journeyId, "spotify.skip", `Skipped ${direction} track.`, {
      direction,
    });
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async listSpotifyDevices(): Promise<SpotifyDevice[]> {
    if (!this.spotifyAdapter.listDevices) return [];
    try {
      const accessToken = await this.spotifyAuth.getAccessToken();
      return await this.spotifyAdapter.listDevices({ accessToken });
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "spotify.devices.failed",
      );
      return [];
    }
  }

  async setSpotifyTransport(
    journeyId: string,
    action: "pause" | "resume",
    deviceId?: string,
  ): Promise<PlaybackSession> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.provider !== "spotify") {
      throw new Error(
        "Transport control is only supported for Spotify journeys.",
      );
    }
    const session = this.store.getPlaybackSession(journeyId);
    const effectiveDeviceId = this.resolveTargetDevice(
      journeyId,
      journey,
      session,
      deviceId,
    );
    if (effectiveDeviceId) {
      try {
        const accessToken = await this.spotifyAuth.getAccessToken();
        const resolved = await this.spotifyAdapter.resolvePlaybackDeviceId({
          accessToken,
          preferredDeviceId: effectiveDeviceId,
        });
        if (action === "pause") {
          await this.spotifyAdapter.pausePlayback?.({
            accessToken,
            deviceId: resolved,
          });
        } else {
          await this.spotifyAdapter.resumePlayback?.({
            accessToken,
            deviceId: resolved,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { journeyId, action, err: message },
          "spotify.transport.degraded",
        );
        this.store.audit(
          journeyId,
          "spotify.playback_error",
          `Spotify ${action} command failed.`,
          { error: message },
        );
      }
    }
    return this.store.getPlaybackSession(journeyId) as PlaybackSession;
  }

  async switchToTidalFallback(journeyId: string): Promise<JourneyRecord> {
    const journey = this.getJourneyOrThrow(journeyId);
    await this.ensureTidalPlaylist(journeyId, journey.destination);
    this.store.updateJourneyProvider(journeyId, "tidal");
    this.saveSession({
      journeyId,
      provider: "tidal",
      status: "fallback",
      queuedTrackIds: [],
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString(),
    });
    this.store.audit(
      journeyId,
      "tidal.fallback_enabled",
      "Journey switched to TIDAL fallback mode.",
    );
    await this.analyzeJourney(journeyId, "tidal-fallback");
    return this.getJourneyOrThrow(journeyId);
  }

  private async analyzeTidalJourney(
    journey: JourneyRecord,
    reason: string,
  ): Promise<PlaylistUpdate> {
    const journeyId = journey.id;
    const telemetry = this.store.latestTelemetry(journeyId);
    const context = contextFromJourney(
      journey,
      telemetry,
      this.store.recentTelemetry(journeyId),
    );
    // NOTE: Music wishes currently steer only Spotify journeys (the default
    // provider); TIDAL is a fallback path, so wishes are stored and surfaced but
    // intentionally not applied to curation or decayed here. See analyzeSpotifyJourney.
    const policy = buildRecommendationPolicy(context);
    const candidates = await this.generateAndStoreCandidateSet(
      journeyId,
      context,
      policy,
      12,
    );
    const accessToken = await this.tidalAuth.getAccessToken();
    const resolver = new TidalResolver(this.tidalAdapter, {
      accessToken,
      countryCode: this.config.TIDAL_COUNTRY_CODE,
    });
    const resolved = await resolver.resolveCandidates(candidates);
    const resolvedIds = this.storeResolved(journeyId, candidates, resolved);
    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "tidal");
    const alreadyAdded = new Set(
      stored
        .filter((track) => track.addedToPlaylist)
        .map((track) => track.providerTrackId),
    );
    let selected = selectRollingBatch(stored, alreadyAdded, 5);

    if (selected.length < 5) {
      this.store.audit(
        journeyId,
        "recommendation.fallback",
        "Initial analysis resolved fewer than 5 tracks; running fallback.",
      );
      const fallbackCandidates = await this.generateAndStoreCandidateSet(
        journeyId,
        context,
        policy,
        8,
      );
      const fallbackResolved =
        await resolver.resolveCandidates(fallbackCandidates);
      this.storeResolved(journeyId, fallbackCandidates, fallbackResolved);
      selected = selectRollingBatch(
        this.store
          .listResolvedTracks(journeyId)
          .filter((track) => track.provider === "tidal"),
        alreadyAdded,
        5,
      );
    }

    const status =
      selected.length === 5
        ? "success"
        : selected.length > 0
          ? "degraded"
          : "failed";
    const update: PlaylistUpdate = {
      id: crypto.randomUUID(),
      journeyId,
      provider: "tidal",
      batchSize: selected.length,
      candidateIds: candidates
        .map((candidate) => candidate.id)
        .filter(Boolean) as string[],
      resolvedTrackIds: selected.map((track) => track.id),
      idempotencyKey: `journey-${journeyId}-${Date.now()}`,
      status,
      createdAtIso: new Date().toISOString(),
    };

    if (selected.length > 0 && journey.tidalPlaylistId) {
      await this.tidalAdapter.addTracks({
        accessToken,
        playlistId: journey.tidalPlaylistId,
        trackIds: selected.map((track) => track.providerTrackId),
        countryCode: this.config.TIDAL_COUNTRY_CODE,
        idempotencyKey: update.idempotencyKey,
      });
      this.store.markTracksAdded(selected.map((track) => track.id));
    }

    this.store.savePlaylistUpdate(update);
    this.store.audit(
      journeyId,
      "playlist.updated",
      `Playlist update ${status}: ${selected.length} tracks added.`,
      {
        reason,
        trackIds: selected.map((track) => track.providerTrackId),
        resolvedIds,
      },
    );
    return update;
  }

  private async analyzeSpotifyJourney(
    journey: JourneyRecord,
    reason: string,
  ): Promise<PlaylistUpdate> {
    const journeyId = journey.id;
    const telemetry = this.store.latestTelemetry(journeyId);
    const context = contextFromJourney(
      journey,
      telemetry,
      this.store.recentTelemetry(journeyId),
    );
    const activeMusicWishes = this.store.listActiveMusicWishes(journeyId);
    const contextWithWishes: JourneyContext = { ...context, activeMusicWishes };

    const variety = makeVarietyContext({
      journeyId,
      elapsedMinutes: context.elapsedMinutes,
      bucketMinutes: this.config.VARIETY_BUCKET_MINUTES,
      phase: context.phase,
      speedBucket: context.speedBucket,
      driveMode: context.driveState?.mode ?? journey.driveMode,
    });
    const recentPlays = this.config.RECENT_FATIGUE_ENABLED
      ? this.store.listRecentlyPlayed(
          this.config.RECENT_FATIGUE_HOURS * 60 * 60 * 1000,
        )
      : [];
    const recentArtistPenalty = new Map<string, number>();
    const recentSongPenalty = new Map<string, number>();
    const fatigueHorizonMs = Math.max(
      1,
      this.config.RECENT_FATIGUE_HOURS * 60 * 60 * 1000,
    );
    for (const play of recentPlays) {
      const decay = Math.max(0, 1 - play.ageMs / fatigueHorizonMs);
      const artistKey = normalizeText(play.artist);
      recentArtistPenalty.set(
        artistKey,
        Math.max(
          recentArtistPenalty.get(artistKey) ?? 0,
          this.config.RECENT_FATIGUE_ARTIST_PENALTY * decay,
        ),
      );
      recentSongPenalty.set(
        play.songKey,
        Math.max(
          recentSongPenalty.get(play.songKey) ?? 0,
          this.config.RECENT_FATIGUE_SONG_PENALTY * decay,
        ),
      );
    }
    // Session-Lernsignal: übersprungene Artisten zusätzlich abwerten.
    const skipEntry = this.skipFeedbackFor(journeyId);
    for (const [artist, penalty] of skipEntry.artists) {
      recentArtistPenalty.set(
        artist,
        Math.max(recentArtistPenalty.get(artist) ?? 0, penalty),
      );
    }
    const banWindowMs = this.config.ARTIST_BAN_WINDOW_HOURS * 60 * 60 * 1000;
    const ledgerCounts =
      this.config.ARTIST_BAN_PLAYS > 0
        ? this.store.artistPlayCounts(banWindowMs)
        : new Map<string, number>();
    const bannedArtists = new Set<string>(
      [...ledgerCounts.entries()]
        .filter(([, count]) => count >= this.config.ARTIST_BAN_PLAYS)
        .map(([artist]) => artist),
    );
    const wishArtists = activeMusicWishes
      .flatMap((wish) => wish.intents)
      .flatMap((intent) =>
        intent.type === "artist"
          ? [intent.artist]
          : intent.type === "song" && intent.artist
            ? [intent.artist]
            : [],
      );
    const priorSession = this.store.getPlaybackSession(journeyId);
    const isFirstPass = !this.store.latestPlaylistUpdate(journeyId);
    const story = this.config.DRIVE_STORY_ENABLED
      ? driveStoryAct({
          elapsedMinutes: contextWithWishes.elapsedMinutes,
          plannedDurationMinutes: contextWithWishes.plannedDurationMinutes,
          etaMinutes: contextWithWishes.etaMinutes,
          isFirstPass,
          arrivalWindowMinutes: this.config.ARRIVAL_MOMENT_MINUTES,
        })
      : undefined;
    const moment = this.activeMoment.get(journeyId);
    this.activeMoment.delete(journeyId);
    // Vibe-Direktiven: tempo-/wake_up-Wünsche verschieben die Ziel-Energie direkt.
    const vibeBias = (activeMusicWishes ?? [])
      .flatMap((wish) => wish.intents)
      .reduce((sum, intent) => {
        if (intent.type === "tempo")
          return sum + (intent.direction === "faster" ? 0.15 : -0.15);
        if (intent.type === "role" && intent.role === "wake_up")
          return sum + 0.15;
        return sum;
      }, 0);
    const clampedVibeBias = Math.max(-0.2, Math.min(0.2, vibeBias));
    const groundedContext: JourneyContext = {
      ...contextWithWishes,
      varietyAngle: seededExplorationAngle(variety.seed),
      recentlyPlayedArtists: [
        ...skipEntry.artists.keys(),
        ...[...ledgerCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([artist]) => artist),
      ].slice(0, this.config.ARTIST_AVOID_PROMPT_LIMIT),
      // Session learning at *generation* time: once a mood has been skipped enough to build a
      // clear signal (≥2 skips), tell the scout to steer away from it — not just the ranker.
      skippedMoodTags: this.config.SKIP_FEEDBACK_ENABLED
        ? [...skipEntry.moodTags.entries()]
            .filter(([, penalty]) => penalty >= 0.3)
            .sort((a, b) => b[1] - a[1])
            .map(([tag]) => tag)
            .slice(0, 6)
        : [],
      nowPlaying:
        priorSession?.activeTrack?.provider === "spotify" &&
        priorSession.activeTrack.artist &&
        priorSession.activeTrack.title
          ? {
              artist: priorSession.activeTrack.artist,
              title: priorSession.activeTrack.title,
            }
          : undefined,
      storyDirective: story?.directive,
      momentDirective: moment?.directive,
      energyBias: Math.max(
        -0.3,
        Math.min(
          0.3,
          clampedVibeBias +
            (story?.energyOffset ?? 0) +
            (moment?.energyBias ?? 0),
        ),
      ),
    };

    // Cost control: only the LLM lenses cost tokens. Run them when the vibe actually changes;
    // for routine top-ups, reuse the already-generated candidate pool if it can refill the buffer.
    const vibeChangingReasons = new Set([
      "initial",
      "phase-change",
      "phase-override",
      "taste-override",
      "manual",
      "recovery",
      "music-wish",
      "music-wish-undo",
      // Kids on/off must regenerate so the kids/normal lenses actually run (Disney is fetched, not
      // just re-ranked from a pool that never contained it).
      "kids-mode",
      "kids-mode-off",
    ]);
    const storedForGate = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");

    // "Consumed" = every track already surfaced this journey (active, queued, played, or ever added
    // to the buffer). Selection and generation must never resurface these — neither the exact
    // recording (provider id) nor another version of the same song (song key).
    const consumedTrackIds = new Set<string>();
    for (const id of priorSession?.queuedTrackIds ?? [])
      consumedTrackIds.add(id);
    for (const id of priorSession?.playedTrackIds ?? [])
      consumedTrackIds.add(id);
    if (priorSession?.activeTrack?.id)
      consumedTrackIds.add(priorSession.activeTrack.id);
    for (const track of storedForGate) {
      if (track.addedToPlaylist) consumedTrackIds.add(track.id);
    }
    const consumedTracks = storedForGate.filter((track) =>
      consumedTrackIds.has(track.id),
    );
    const consumedProviderIds = new Set(
      consumedTracks.map((track) => track.providerTrackId),
    );
    const consumedSongKeys = new Set(
      consumedTracks.map((track) => songKey(track.artist, track.title)),
    );

    const unusedPool = storedForGate.filter(
      (track) =>
        track.providerUri &&
        track.isPlayable !== false &&
        !consumedTrackIds.has(track.id) &&
        !consumedSongKeys.has(songKey(track.artist, track.title)),
    );
    const neededNow = Math.max(
      0,
      5 - (priorSession?.queuedTrackIds?.length ?? 0),
    );
    const mustGenerate =
      vibeChangingReasons.has(reason) ||
      reason.startsWith("drive-state:") ||
      reason.startsWith("moment:") ||
      unusedPool.length < neededNow;
    if (unusedPool.length < neededNow) {
      // Observability: pre-warming should keep this from ever happening mid-drive.
      this.store.audit(
        journeyId,
        "recommendation.pool_exhausted",
        "Refill found an exhausted candidate pool; generation will block this pass.",
        { poolSize: unusedPool.length, needed: neededNow, reason },
      );
    }

    const tokenStartedAt = Date.now();
    const accessToken = await this.spotifyAuth.getAccessToken();
    this.logger.info(
      { journeyId, ms: Date.now() - tokenStartedAt },
      "spotify.token.done",
    );

    // Personalize the brief with the listener's taste (cached ~24h). Built once and reused for any
    // fallback regeneration below so the whole drive shares one taste signal.
    let scoutContext: JourneyContext = groundedContext;
    let policy = applyMusicWishesToPolicy(
      buildRecommendationPolicy(groundedContext),
      activeMusicWishes,
    );
    if (moment?.moodTagBias.length) {
      policy = {
        ...policy,
        moodTags: [...policy.moodTags, ...moment.moodTagBias],
      };
    }
    let candidates: SongCandidate[] = [];
    if (mustGenerate) {
      const tasteProfile = await this.loadTasteProfile(accessToken);
      scoutContext = {
        ...groundedContext,
        tasteProfile,
        tasteWeight: journey.tasteWeight ?? DEFAULT_TASTE_WEIGHT,
        tasteArtistsWithIds: this.cachedTasteArtistsWithIds,
      };
      policy = applyMusicWishesToPolicy(
        buildRecommendationPolicy(scoutContext),
        activeMusicWishes,
      );
      if (moment?.moodTagBias.length) {
        policy = {
          ...policy,
          moodTags: [...policy.moodTags, ...moment.moodTagBias],
        };
      }
      // Currency-lens grounding: surface real release-radar titles to the AI scout so the
      // "current" lens prompt can name actual recent tracks instead of hallucinating them.
      // Best-effort: errors or empty results ⇒ no grounding line (harmless).
      if (
        this.config.CURRENCY_LENS_GROUNDING_ENABLED &&
        this.config.SPOTIFY_FRESH_ENABLED &&
        this.freshAlbumSource
      ) {
        const freshForGrounding = await releaseRadarCandidates({
          albums: this.freshAlbumSource,
          tasteArtists: this.freshSeedArtists(scoutContext),
          bannedArtists: bannedArtists,
          moodTags: policy.moodTags,
          windowDays: this.config.FRESH_WINDOW_DAYS,
          limit: 12,
        }).catch(() => [] as SongCandidate[]);
        if (freshForGrounding.length > 0) {
          scoutContext = {
            ...scoutContext,
            currentReleases: freshForGrounding.map(
              (c) => `${c.artist} – ${c.title}`,
            ),
          };
        }
      }
      candidates = this.filterFreshCandidates(
        await this.generateAndStoreCandidateSet(
          journeyId,
          scoutContext,
          policy,
          8,
          variety.seed,
          { bannedArtists },
        ),
        consumedSongKeys,
      );
      if (isFirstPass && story?.act === "opening") {
        const anchors = await this.tasteAnchorCandidates(
          "opening",
          scoutContext.tasteProfile?.representativeArtists ?? [],
          variety.seed,
        );
        if (anchors.length > 0) {
          candidates = [
            ...(await this.enrichAndStoreCandidates(journeyId, anchors)),
            ...candidates,
          ];
        }
      }
      if (moment?.candidateRequest) {
        let momentCandidates: SongCandidate[] = [];
        if (
          moment.candidateRequest.kind === "geo-charts" &&
          this.lastfmCharts
        ) {
          const localTracks = await this.lastfmCharts
            .getGeoTopTracks(moment.candidateRequest.country, 20, 1)
            .catch(() => []);
          momentCandidates = lastfmTracksToCandidates(
            localTracks,
            scoutContext,
            policy.moodTags,
          )
            .slice(0, 3)
            .map((candidate) => ({
              ...candidate,
              lens: `moment:${moment.type}`,
            }));
        } else if (moment.candidateRequest.kind === "taste-anchor") {
          momentCandidates = await this.tasteAnchorCandidates(
            "arrival",
            scoutContext.tasteProfile?.representativeArtists ?? [],
            variety.seed,
          );
        }
        if (momentCandidates.length > 0) {
          candidates = [
            ...(await this.enrichAndStoreCandidates(
              journeyId,
              momentCandidates,
            )),
            ...candidates,
          ];
        }
      }
    } else {
      this.logger.info(
        { journeyId, reason, poolSize: unusedPool.length, needed: neededNow },
        "scout.pool_reuse",
      );
      this.store.audit(
        journeyId,
        "recommendation.pool_reuse",
        `Reused ${unusedPool.length} already-generated candidates; skipped AI generation.`,
        { reason },
      );
    }
    const resolver = new SpotifyResolver(this.spotifyAdapter, {
      accessToken,
      market: this.config.SPOTIFY_MARKET,
      searchTimeoutMs: 8_000,
      targetResolveCount: policy.cleanRequired ? 12 : 10,
      // Persistent cache: each song is searched on Spotify at most once across the whole drive.
      cache: {
        get: (key) => this.store.getCachedSpotifySearch(key),
        set: (key, value) => this.store.saveCachedSpotifySearch(key, value),
      },
    });
    const resolveStartedAt = Date.now();
    const resolved = await resolver.resolveCandidates(candidates);
    this.logger.info(
      {
        journeyId,
        candidates: candidates.length,
        resolved: resolved.length,
        ms: Date.now() - resolveStartedAt,
      },
      "spotify.resolve.done",
    );
    const resolvedIds = this.storeResolved(journeyId, candidates, resolved);

    let stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    let session = this.store.getPlaybackSession(journeyId);
    const consumedArtistKeys = new Set(
      consumedTracks.map((track) => normalizeText(track.artist)),
    );

    // Musik vor Doktrin: drückt der Bann die spielbare Auswahl unter den Buffer-Bedarf,
    // wird er für diesen Pass gelockert (Fatigue-Malus wirkt weiter) und auditiert.
    const playableUnbanned = stored.filter(
      (track) =>
        track.providerUri &&
        track.isPlayable !== false &&
        !bannedArtists.has(normalizeText(track.artist)),
    ).length;
    const effectiveBannedArtists =
      playableUnbanned >= 5 ? bannedArtists : new Set<string>();
    if (bannedArtists.size > 0 && effectiveBannedArtists.size === 0) {
      this.store.audit(
        journeyId,
        "variety.ban_relaxed",
        "Artist ban relaxed for this pass; pool too small.",
        { banned: bannedArtists.size, playableUnbanned },
      );
    }

    const rankedStored = rankResolvedTracksForPolicy(
      stored,
      {
        ...policy,
        avoidArtists: [...consumedArtistKeys],
        avoidSongKeys: [...consumedSongKeys],
      },
      {
        consumedArtists: consumedTracks.map((track) => track.artist),
        seed: variety.seed,
        jitterStrength: this.config.RANK_JITTER_ENABLED
          ? this.config.RANK_JITTER_STRENGTH
          : 0,
        recentArtistPenalty,
        recentSongPenalty,
        fatigueExemptArtists: wishArtists,
        bannedArtists: effectiveBannedArtists,
        softMoodPenalty: skipEntry.moodTags,
        excludeSpokenWord: this.config.SPOKEN_WORD_FILTER_ENABLED,
        recencyDateScoring: this.config.RECENCY_DATE_SCORING_ENABLED,
      },
    );
    const immediateWishKeys = this.immediateWishSongKeys(activeMusicWishes);
    const immediateWishTrack = rankedStored.find((track) => {
      const exact = songKey(track.artist, track.title);
      const titleOnly = songKey("", track.title);
      return immediateWishKeys.has(exact) || immediateWishKeys.has(titleOnly);
    });
    const isWishApplicationPass =
      reason === "music-wish" || reason === "music-wish-undo";
    const shouldRebuildQueueForWish =
      isWishApplicationPass ||
      (reason === "manual" && activeMusicWishes.length > 0);
    // An explicit vibe shift (Kids on/off) rebuilds the upcoming queue too, so stale non-vibe tracks
    // don't sit in front of the freshly-curated ones. Kept separate from the wish gate so it never
    // consumes music-wish budgets (the decay branch below stays keyed to shouldRebuildQueueForWish).
    const isVibeShift = VIBE_SHIFT_REASONS.has(reason);
    const shouldRebuildQueueForVibeShift =
      shouldRebuildQueueForWish || isVibeShift;
    const anchorKeys = new Set(
      candidates
        .filter((candidate) =>
          candidate.lens?.startsWith("taste-anchor:opening"),
        )
        .map((candidate) => songKey(candidate.artist, candidate.title)),
    );
    const openingAnchorTrack =
      isFirstPass && anchorKeys.size > 0
        ? rankedStored.find((track) =>
            anchorKeys.has(songKey(track.artist, track.title)),
          )
        : undefined;
    // On a vibe shift, lead with the top freshly-curated playable pick so the listener hears the new
    // direction immediately (it becomes the started anchor — see shouldStart below).
    const vibeShiftAnchor = isVibeShift
      ? rankedStored.find(
          (track) => track.providerUri && track.isPlayable !== false,
        )
      : undefined;
    let activeTrack =
      immediateWishTrack ??
      vibeShiftAnchor ??
      openingAnchorTrack ??
      (session?.activeTrack && session.activeTrack.provider === "spotify"
        ? stored.find((track) => track.id === session?.activeTrack?.id)
        : undefined);

    if (!activeTrack) {
      activeTrack = rankedStored.find(
        (track) => track.providerUri && track.isPlayable !== false,
      );
    }

    const currentQueued = (session?.queuedTrackIds ?? [])
      .map((id) => stored.find((track) => track.id === id))
      .filter(
        (
          track,
        ): track is ResolvedTrack & {
          id: string;
          addedToPlaylist: boolean;
          savedToPlaylist: boolean;
        } => Boolean(track),
      );
    const preservedQueued = shouldRebuildQueueForVibeShift ? [] : currentQueued;
    const needed = Math.max(0, 5 - preservedQueued.length);
    const selected = queueTracksForBuffer(rankedStored, {
      activeProviderTrackId: activeTrack?.providerTrackId,
      alreadyQueuedProviderIds: new Set(
        preservedQueued.map((track) => track.providerTrackId),
      ),
      excludeProviderTrackIds: consumedProviderIds,
      excludeSongKeys: consumedSongKeys,
      excludeArtistKeys: consumedArtistKeys,
      preferDistinctArtists: policy.preferDistinctArtists,
      preferDistinctGenres: this.config.GENRE_SPREAD_ENABLED,
      cleanRequired: policy.cleanRequired,
      targetBufferSize: needed,
    });

    if (preservedQueued.length + selected.length < 5) {
      this.store.audit(
        journeyId,
        "recommendation.fallback",
        "Spotify analysis resolved fewer than 5 future tracks; running fallback.",
      );
      const fallbackCandidates = this.filterFreshCandidates(
        await this.generateAndStoreCandidateSet(
          journeyId,
          scoutContext,
          policy,
          8,
          variety.seed,
          { bannedArtists },
        ),
        consumedSongKeys,
      );
      const fallbackResolved =
        await resolver.resolveCandidates(fallbackCandidates);
      this.storeResolved(journeyId, fallbackCandidates, fallbackResolved);
      stored = this.store
        .listResolvedTracks(journeyId)
        .filter((track) => track.provider === "spotify");
      const rankedFallbackStored = rankResolvedTracksForPolicy(
        stored,
        {
          ...policy,
          avoidArtists: [...consumedArtistKeys],
          avoidSongKeys: [...consumedSongKeys],
        },
        {
          consumedArtists: consumedTracks.map((track) => track.artist),
          seed: variety.seed,
          jitterStrength: this.config.RANK_JITTER_ENABLED
            ? this.config.RANK_JITTER_STRENGTH
            : 0,
          recentArtistPenalty,
          recentSongPenalty,
          fatigueExemptArtists: wishArtists,
          bannedArtists: effectiveBannedArtists,
          softMoodPenalty: skipEntry.moodTags,
          excludeSpokenWord: this.config.SPOKEN_WORD_FILTER_ENABLED,
          recencyDateScoring: this.config.RECENCY_DATE_SCORING_ENABLED,
        },
      );
      const alreadyQueued = new Set([
        ...preservedQueued.map((track) => track.providerTrackId),
        ...selected.map((track) => track.providerTrackId),
      ]);
      const additional = queueTracksForBuffer(rankedFallbackStored, {
        activeProviderTrackId: activeTrack?.providerTrackId,
        alreadyQueuedProviderIds: alreadyQueued,
        excludeProviderTrackIds: consumedProviderIds,
        excludeSongKeys: consumedSongKeys,
        excludeArtistKeys: consumedArtistKeys,
        preferDistinctArtists: policy.preferDistinctArtists,
        cleanRequired: policy.cleanRequired,
        targetBufferSize: Math.max(
          0,
          5 - preservedQueued.length - selected.length,
        ),
      });
      for (const track of additional) {
        if (
          !selected.some(
            (item) => item.providerTrackId === track.providerTrackId,
          )
        ) {
          selected.push(track);
        }
        if (preservedQueued.length + selected.length >= 5) {
          break;
        }
      }
    }

    const momentKeys = new Set(
      candidates
        .filter(
          (candidate) =>
            candidate.lens?.startsWith("moment:") ||
            candidate.lens === "taste-anchor:arrival",
        )
        .map((candidate) => songKey(candidate.artist, candidate.title)),
    );
    const priorityTrack =
      momentKeys.size > 0
        ? rankedStored.find((track) =>
            momentKeys.has(songKey(track.artist, track.title)),
          )
        : undefined;
    const quotaSelected = this.enforcePrioritySlots({
      selected,
      rankedStored,
      wishes: activeMusicWishes,
      excludeProviderIds: consumedProviderIds,
      priorityTrack,
    });
    selected.length = 0;
    selected.push(...quotaSelected);

    // Sequence the freshly added tracks along the energy curve so the upcoming buffer plays as a
    // shaped arc rather than a score-sorted list. The first new pick (a priority/anchor/wish slot)
    // is pinned; the already-queued tracks are left in place — Spotify's queue is FIFO and cannot
    // be reordered — and the tail continues their arc via baseIndex.
    if (this.config.ENERGY_ARC_SEQUENCING_ENABLED && selected.length > 2) {
      const arcCurve = energyCurveForContext(scoutContext);
      const arranged = orderByEnergyArc(
        selected,
        arcCurve,
        (track) => resolvedTrackEnergy(track),
        (track) => resolvedTrackValence01(track),
        { keepFirst: true, baseIndex: preservedQueued.length },
      );
      selected.length = 0;
      selected.push(...arranged);
    }

    session = this.store.getPlaybackSession(journeyId);
    // Target the locked device first so all starts/refills land on the driver's chosen Connect
    // device (e.g. the native Tesla app), never a lingering web player.
    const deviceId = this.resolveTargetDevice(journeyId, journey, session);
    // The visible model decides what reaches the device: Spotify must never be sent a
    // track the 5-slot model doesn't show, or the reconciler later flags our own queue
    // as "external". Compute the model first and sync exactly its delta.
    const queuedTracks = [...preservedQueued, ...selected].slice(0, 5);
    const preservedIds = new Set(preservedQueued.map((track) => track.id));
    const queueDelta = queuedTracks.filter(
      (track) => !preservedIds.has(track.id),
    );
    const playbackApplied = deviceId
      ? await this.syncSpotifyPlayback({
          journeyId,
          accessToken,
          deviceId,
          activeTrack,
          queueTracks: queueDelta,
          // A vibe shift starts the freshly-curated anchor immediately (interrupts the current song)
          // so the change is felt at once — the context reset is the only way past Spotify's
          // append-only queue. Automated/refill passes keep the "only start if idle" behavior.
          shouldStart: Boolean(
            activeTrack?.providerUri &&
            (isVibeShift ||
              !session?.activeTrack ||
              session.status !== "playing"),
          ),
          automated: !USER_INITIATED_REASONS.has(reason),
        })
      : { deviceReachable: false };

    const playedActiveTrack = playbackApplied.deviceReachable
      ? activeTrack
      : (session?.activeTrack ?? activeTrack);
    const status =
      queuedTracks.length === 5 &&
      playbackApplied.deviceReachable &&
      !playbackApplied.rateLimited
        ? "success"
        : queuedTracks.length > 0
          ? "degraded"
          : "failed";
    const update: PlaylistUpdate = {
      id: crypto.randomUUID(),
      journeyId,
      provider: "spotify",
      batchSize: selected.length,
      candidateIds: candidates
        .map((candidate) => candidate.id)
        .filter(Boolean) as string[],
      resolvedTrackIds: queuedTracks.map((track) => track.id),
      idempotencyKey: `journey-${journeyId}-${Date.now()}`,
      status,
      createdAtIso: new Date().toISOString(),
    };

    this.store.markTracksAdded(
      [activeTrack?.id, ...queuedTracks.map((track) => track.id)].filter(
        Boolean,
      ) as string[],
    );
    // Decay wishes only on passes driven by actual playback progression, by the tracks
    // the listener advanced through (the buffer deficit we just refilled, `needed`).
    // NEVER on a wish refresh pass: the listener has not advanced through a
    // track yet, so the wish must keep its budget instead of expiring during
    // re-curation.
    if (!shouldRebuildQueueForWish) {
      this.store.decayActiveMusicWishes(
        journeyId,
        needed + (immediateWishTrack ? 1 : 0),
      );
    }
    if (this.config.RECENT_FATIGUE_ENABLED) {
      const surfaced = [activeTrack, ...queuedTracks].filter(
        (track): track is NonNullable<typeof track> => Boolean(track),
      );
      this.store.recordRecentPlays(
        journeyId,
        surfaced.map((track) => ({ artist: track.artist, title: track.title })),
      );
    }
    this.store.savePlaylistUpdate(update);
    this.saveSession({
      journeyId,
      provider: "spotify",
      deviceId,
      status: status === "success" ? "playing" : deviceId ? "degraded" : "idle",
      activeTrack: playedActiveTrack,
      queuedTrackIds: queuedTracks.map((track) => track.id),
      // Preserve skip-back history across refreshes/refills (was dropped → wiped played on every analyze).
      playedTrackIds: session?.playedTrackIds ?? [],
      targetBufferSize: 5,
      lastHeartbeatAt: new Date().toISOString(),
    });
    this.store.audit(
      journeyId,
      "spotify.queue_updated",
      `Spotify queue update ${status}: ${queuedTracks.length}/5 future tracks.`,
      {
        reason,
        activeTrackId: activeTrack?.providerTrackId,
        queuedTrackIds: queuedTracks.map((track) => track.providerTrackId),
        resolvedIds,
      },
    );
    // Mirror the curated set into the saved journey playlist (best-effort; never blocks the journey).
    await this.syncJourneyPlaylist(journey, accessToken);
    return update;
  }

  private immediateWishSongKeys(wishes: MusicWish[]): Set<string> {
    const keys = new Set<string>();
    for (const wish of wishes) {
      if (wish.status !== "active" && wish.status !== "soft_applied") continue;
      for (const intent of wish.intents) {
        if (intent.type === "song" && intent.immediate) {
          keys.add(songKey(intent.artist ?? "", intent.title));
          keys.add(songKey("", intent.title));
        }
      }
    }
    return keys;
  }

  /**
   * Enforces priority slots and the hard wish quota. A priorityTrack (journey moment /
   * arrival anthem) takes the FIRST queue slot, beating the wish quota for that one slot.
   * Then ensures at least WISH_QUOTA_MIN tracks per active artist wish are in the next
   * queue, capped at WISH_QUOTA_MAX_SLOTS total wish slots, by swapping the lowest-ranked
   * non-wish selected tracks for the top-ranked unused wish-artist tracks. Returns the
   * (possibly modified) selected list.
   */
  private enforcePrioritySlots<T extends ResolvedTrack & { id: string }>(args: {
    selected: T[];
    rankedStored: T[];
    wishes: MusicWish[];
    excludeProviderIds: Set<string>;
    /** Track, der den ERSTEN Queue-Slot bekommt (Moment/Anthem); schlägt die Wunsch-Quote für einen Slot. */
    priorityTrack?: T;
  }): T[] {
    let selected = [...args.selected];
    if (args.priorityTrack) {
      const id = args.priorityTrack.providerTrackId;
      selected = [
        args.priorityTrack,
        ...selected.filter((t) => t.providerTrackId !== id),
      ].slice(0, Math.max(selected.length, 1));
    }
    const min = this.config.WISH_QUOTA_MIN;
    const maxSlots = this.config.WISH_QUOTA_MAX_SLOTS;

    const wishArtistKeys = new Set(
      args.wishes
        .filter(
          (wish) => wish.status === "active" || wish.status === "soft_applied",
        )
        .flatMap((wish) => wish.intents)
        .flatMap((intent) =>
          intent.type === "artist" ? [normalizeText(intent.artist)] : [],
        ),
    );

    const isWishTrack = (track: ResolvedTrack) =>
      wishArtistKeys.size > 0 &&
      wishArtistKeys.has(normalizeText(track.artist));

    if (min > 0 && maxSlots > 0 && wishArtistKeys.size > 0) {
      const inQueueIds = new Set(
        selected.map((track) => track.providerTrackId),
      );
      let wishSlots = selected.filter(isWishTrack).length;

      const wishCandidates = args.rankedStored.filter(
        (track) =>
          isWishTrack(track) &&
          track.providerUri &&
          track.isPlayable !== false &&
          !inQueueIds.has(track.providerTrackId) &&
          !args.excludeProviderIds.has(track.providerTrackId),
      );

      const target = Math.min(maxSlots, Math.max(min, wishSlots));
      for (const candidate of wishCandidates) {
        if (wishSlots >= target) break;
        const victimIndex = [...selected]
          .map((track, index) => ({ track, index }))
          .reverse()
          .find(
            ({ track, index }) =>
              !isWishTrack(track) && !(args.priorityTrack && index === 0),
          )?.index;
        if (victimIndex === undefined) break;
        selected[victimIndex] = candidate;
        inQueueIds.add(candidate.providerTrackId);
        wishSlots += 1;
      }
    }

    const freshMin = this.config.FRESH_QUOTA_MIN;
    if (freshMin > 0) {
      const isFresh = (track: ResolvedTrack) =>
        isWithinFreshWindow(track.releaseDate, this.config.FRESH_WINDOW_DAYS);
      const freshInQueueIds = new Set(
        selected.map((track) => track.providerTrackId),
      );
      let freshSlots = selected.filter(isFresh).length;
      const freshCandidates = args.rankedStored.filter(
        (track) =>
          isFresh(track) &&
          track.providerUri &&
          track.isPlayable !== false &&
          !freshInQueueIds.has(track.providerTrackId) &&
          !args.excludeProviderIds.has(track.providerTrackId),
      );
      for (const candidate of freshCandidates) {
        if (freshSlots >= freshMin) break;
        const victimIndex = [...selected]
          .map((track, index) => ({ track, index }))
          .reverse()
          .find(
            ({ track, index }) =>
              !isWishTrack(track) &&
              !isFresh(track) &&
              !(args.priorityTrack && index === 0),
          )?.index;
        if (victimIndex === undefined) break;
        selected[victimIndex] = candidate;
        freshInQueueIds.add(candidate.providerTrackId);
        freshSlots += 1;
      }
    }

    return selected;
  }

  /** Taste-Anchor-Kandidat (Opening/Arrival): realer Top-Track via Last.fm, sonst Radio-Fallback. */
  /** Shape one familiar anchor option from a favorite artist + (optionally) a signature title. */
  private anchorCandidateOf(
    artist: string,
    title: string,
    kind: "opening" | "arrival",
  ): SongCandidate {
    return {
      artist,
      title,
      lens: `taste-anchor:${kind}`,
      role: "anchor",
      reason:
        kind === "opening"
          ? `Familiar way in: a signature track from ${artist}, matched to the destination mood`
          : `Arrival anthem: a familiar ${artist} finale before you arrive`,
      source: "fallback",
      confidence: 0.9,
      moodTags: ["anchor"],
    };
  }

  /**
   * Best-fit taste anchor: instead of one arbitrary top track, surface a small shortlist of
   * signature songs across the listener's leading favorite artists (seed-rotated for cross-journey
   * variety). They flow through the normal resolve+rank pipeline, so the policy ranker picks the
   * single best fit for *this* drive — recognizability (popularity), era fit (recencyBias:
   * nostalgic→older classics, fresh→recent), mood and skip feedback all already weigh in. The
   * caller's anchor selector then pins the top-ranked option as the opener.
   */
  private async tasteAnchorCandidates(
    kind: "opening" | "arrival",
    tasteArtists: string[],
    seed: number,
  ): Promise<SongCandidate[]> {
    const cleaned = tasteArtists.map((a) => a.trim()).filter(Boolean);
    if (cleaned.length === 0) return [];
    // Rotate which favorites lead so the opener varies across drives, but consider several so the
    // ranker has real choice rather than a fixed #1.
    const offset = seed % cleaned.length;
    const leadArtists = [
      ...cleaned.slice(offset),
      ...cleaned.slice(0, offset),
    ].slice(0, ANCHOR_ARTIST_FANOUT);
    const radioSeed = (): SongCandidate[] => [
      this.anchorCandidateOf(leadArtists[0], `${leadArtists[0]} radio`, kind),
    ];
    if (!this.lastfmCharts) {
      // No catalog source: fall back to a single radio seed for the leading favorite.
      return radioSeed();
    }
    const perArtist = await Promise.all(
      leadArtists.map((artist) =>
        this.lastfmCharts!.getArtistTopTracks(
          artist,
          ANCHOR_TRACKS_PER_ARTIST,
        ).catch(() => []),
      ),
    );
    const options: SongCandidate[] = [];
    leadArtists.forEach((artist, index) => {
      // The most iconic few per artist — an opener should be a signature song, not a deep cut.
      const top = (perArtist[index] ?? []).slice(0, ANCHOR_TRACKS_PER_ARTIST);
      for (const track of top) {
        if (track.title) {
          options.push(this.anchorCandidateOf(artist, track.title, kind));
        }
      }
    });
    return options.length > 0
      ? options.slice(0, ANCHOR_OPTIONS_MAX)
      : radioSeed();
  }

  private pickSpotifyPlaybackTracks(
    stored: Array<
      ResolvedTrack & {
        id: string;
        addedToPlaylist: boolean;
        savedToPlaylist: boolean;
      }
    >,
    session?: PlaybackSession,
  ): {
    activeTrack?: ResolvedTrack & {
      id: string;
      addedToPlaylist: boolean;
      savedToPlaylist: boolean;
    };
    queueTracks: Array<
      ResolvedTrack & {
        id: string;
        addedToPlaylist: boolean;
        savedToPlaylist: boolean;
      }
    >;
    queuedTrackIds: string[];
  } {
    const queued = (session?.queuedTrackIds ?? [])
      .map((id) => stored.find((track) => track.id === id))
      .filter(
        (
          track,
        ): track is ResolvedTrack & {
          id: string;
          addedToPlaylist: boolean;
          savedToPlaylist: boolean;
        } => Boolean(track),
      );

    if (session?.activeTrack) {
      const active = stored.find(
        (track) => track.id === session.activeTrack?.id,
      );
      if (active) {
        const queueTracks = queued.filter((track) => track.id !== active.id);
        return {
          activeTrack: active,
          queueTracks,
          // Convention everywhere else in this service: queuedTrackIds are the FUTURE
          // tracks only. Prepending the active here used to shift the real 5th queue
          // track out of the model while it stayed queued on the device.
          queuedTrackIds: queueTracks.map((track) => track.id).slice(0, 5),
        };
      }
    }

    if (queued.length > 0) {
      const [head, ...tail] = queued;
      return {
        activeTrack: head,
        queueTracks: tail,
        queuedTrackIds: queued.map((track) => track.id).slice(0, 5),
      };
    }

    const fallback = stored.find(
      (track) => track.providerUri && track.isPlayable !== false,
    );
    return {
      activeTrack: fallback,
      queueTracks: [],
      queuedTrackIds: fallback ? [fallback.id] : [],
    };
  }

  /**
   * Plays an EXACT track list on the already-active device via a single absolute `startPlayback`
   * (no transfer/pause dance), so Spotify's playback and "next" become identical to our model.
   * Falls back to the full transfer+start sync only if the device isn't active yet.
   */
  private async playExact(args: {
    journeyId: string;
    accessToken: string;
    deviceId: string;
    activeTrack?: ResolvedTrack;
    queueTracks: ResolvedTrack[];
  }): Promise<{ deviceReachable: boolean; rateLimited?: boolean }> {
    // Same single-ordering-source contract as syncSpotifyPlayback: play ONLY the exact
    // track as the context and keep the upcoming order in Spotify's queue. A multi-track
    // context would be preempted by previously queued items and drift from the model.
    const startUri =
      args.activeTrack?.providerUri ??
      args.queueTracks
        .map((track) => track.providerUri)
        .find((uri): uri is string => Boolean(uri));
    if (!startUri) {
      return { deviceReachable: false };
    }

    const deviceId = await this.spotifyAdapter.resolvePlaybackDeviceId({
      accessToken: args.accessToken,
      preferredDeviceId: args.deviceId,
    });

    try {
      await this.spotifyAdapter.startPlayback({
        accessToken: args.accessToken,
        deviceId,
        uris: [startUri],
      });
      if (args.activeTrack?.providerUri) {
        this.store.saveQueueOperation({
          id: crypto.randomUUID(),
          journeyId: args.journeyId,
          provider: "spotify",
          providerTrackId: args.activeTrack.providerTrackId,
          providerUri: args.activeTrack.providerUri,
          operation: "start",
          status: "success",
          deviceId,
          createdAtIso: new Date().toISOString(),
        });
      }
      // Top up the device queue with whatever part of the modeled queue it is missing
      // (no-ops for entries that are already queued — Spotify's queue is append-only).
      const queueOutcome = await this.queueMissingTracks({
        journeyId: args.journeyId,
        accessToken: args.accessToken,
        deviceId,
        tracks: args.queueTracks,
        excludeUri: startUri,
      });
      if (queueOutcome === "unreachable") {
        return { deviceReachable: false };
      }
      return {
        deviceReachable: true,
        rateLimited: queueOutcome === "rate-limited" || undefined,
      };
    } catch (error) {
      // Device not active yet (e.g. Webplayer just (re)connected): fall back to transfer + start.
      if (isSpotifyDeviceNotFoundError(error)) {
        return this.syncSpotifyPlayback({
          journeyId: args.journeyId,
          accessToken: args.accessToken,
          deviceId,
          activeTrack: args.activeTrack,
          queueTracks: args.queueTracks,
          shouldStart: true,
          automated: false, // playExact is only reached via explicit skip/reclaim
        });
      }
      if (isSpotifyRateLimitError(error)) {
        return { deviceReachable: true, rateLimited: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { journeyId: args.journeyId, deviceId, err: message },
        "spotify.play.degraded",
      );
      this.store.audit(
        args.journeyId,
        "spotify.playback_error",
        "Spotify play failed; queue saved, playback degraded.",
        {
          deviceId,
          error: message,
        },
      );
      return { deviceReachable: false };
    }
  }

  /**
   * Appends the given tracks to the device queue, skipping anything the device already has
   * queued. Spotify's queue is append-only (no remove/reorder API), so re-syncs MUST be
   * idempotent or every webplayer reload / device-ready pass would duplicate the queue.
   */
  private async queueMissingTracks(args: {
    journeyId: string;
    accessToken: string;
    deviceId: string;
    tracks: ResolvedTrack[];
    /** URI just started as the playback context — never re-queue it. */
    excludeUri?: string;
  }): Promise<"ok" | "rate-limited" | "unreachable"> {
    const candidates = args.tracks.filter(
      (track) => track.providerUri && track.providerUri !== args.excludeUri,
    );
    if (candidates.length === 0) return "ok";

    let deviceQueuedIds: ReadonlySet<string> = new Set<string>();
    try {
      const state = await this.spotifyAdapter.getPlaybackState({
        accessToken: args.accessToken,
        market: this.config.SPOTIFY_MARKET,
      });
      deviceQueuedIds = new Set(state.queuedProviderTrackIds);
    } catch {
      // Best-effort: without queue visibility we still add — a rare duplicate beats a gap.
    }

    for (const track of candidates) {
      if (deviceQueuedIds.has(track.providerTrackId)) continue;
      try {
        await this.spotifyAdapter.addToQueue({
          accessToken: args.accessToken,
          deviceId: args.deviceId,
          uri: track.providerUri as string,
        });
        this.store.saveQueueOperation({
          id: crypto.randomUUID(),
          journeyId: args.journeyId,
          provider: "spotify",
          providerTrackId: track.providerTrackId,
          providerUri: track.providerUri as string,
          operation: "queue",
          status: "success",
          deviceId: args.deviceId,
          createdAtIso: new Date().toISOString(),
        });
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.SPOTIFY_QUEUE_ADD_DELAY_MS),
        );
      } catch (error) {
        if (isSpotifyDeviceNotFoundError(error)) {
          return "unreachable";
        }
        if (isSpotifyRateLimitError(error)) {
          return "rate-limited";
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { journeyId: args.journeyId, deviceId: args.deviceId, err: message },
          "spotify.queue.degraded",
        );
        this.store.audit(
          args.journeyId,
          "spotify.playback_error",
          "Spotify queue add failed; remaining tracks saved, playback degraded.",
          {
            deviceId: args.deviceId,
            error: message,
          },
        );
        return "unreachable";
      }
    }
    return "ok";
  }

  private async syncSpotifyPlayback(args: {
    journeyId: string;
    accessToken: string;
    deviceId: string;
    activeTrack?: ResolvedTrack;
    queueTracks: ResolvedTrack[];
    shouldStart: boolean;
    /** True for background/automated passes — these are suppressed when the user has taken over. */
    automated: boolean;
  }): Promise<{ deviceReachable: boolean; rateLimited?: boolean }> {
    // Don't hijack the user: on automated passes, bail if they're playing a podcast or have moved
    // playback to another device. (Foreign off-journey tracks are handled in reconcileSpotifyPlayback.)
    if (args.automated && this.config.PLAYBACK_RESPECT_USER_TAKEOVER) {
      const state = await this.spotifyAdapter
        .getPlaybackState({
          accessToken: args.accessToken,
          market: this.config.SPOTIFY_MARKET,
        })
        .catch(() => undefined);
      if (
        state &&
        playbackOwnership({
          isPlaying: state.isPlaying,
          currentlyPlayingType: state.currentlyPlayingType,
          activeDeviceId: state.activeDeviceId,
          journeyDeviceId: args.deviceId,
        }) === "handed-over"
      ) {
        const session = this.store.getPlaybackSession(args.journeyId);
        if (session && session.status !== "external") {
          this.saveSession({
            ...session,
            status: "external",
            lastHeartbeatAt: new Date().toISOString(),
          });
        }
        this.logger.info(
          { journeyId: args.journeyId, device: state.activeDeviceId },
          "playback.suppressed_user_takeover",
        );
        return { deviceReachable: false };
      }
    }
    const deviceId = await this.spotifyAdapter.resolvePlaybackDeviceId({
      accessToken: args.accessToken,
      preferredDeviceId: args.deviceId,
    });

    let transferFailed = false;
    // Only (re)assert the device when we actually intend to (re)start playback. A pure queue
    // refill (shouldStart:false) must NEVER transfer — that would yank playback back to the
    // bound browser player from whatever Connect device (e.g. the native Tesla app) the user
    // moved it to. Refills only append to the queue of the device already playing.
    if (args.shouldStart) {
      const priorSession = this.store.getPlaybackSession(args.journeyId);
      const deviceChanged = priorSession?.deviceId !== deviceId;
      try {
        await this.spotifyAdapter.transferPlayback({
          accessToken: args.accessToken,
          deviceId,
        });
        // Spotify needs a settle moment only when playback actually moves between devices.
        if (deviceChanged) {
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      } catch (error) {
        if (isSpotifyDeviceNotFoundError(error)) {
          transferFailed = true;
          this.store.audit(
            args.journeyId,
            "spotify.device_missing",
            "Spotify Webplayer not active yet; will retry play.",
            {
              deviceId,
            },
          );
        } else if (isSpotifyRateLimitError(error)) {
          return { deviceReachable: true, rateLimited: true };
        } else {
          // Playback is best-effort: a transient Spotify error (e.g. 500) must not fail the
          // journey. The queue is already saved; degrade and let the user retry playback.
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            { journeyId: args.journeyId, deviceId, err: message },
            "spotify.transfer.degraded",
          );
          this.store.audit(
            args.journeyId,
            "spotify.playback_error",
            "Spotify transfer failed; queue saved, playback degraded.",
            {
              deviceId,
              error: message,
            },
          );
          return { deviceReachable: false };
        }
      }
    }

    // Single ordering source: start ONLY the active track as the playback context and feed
    // every upcoming track through Spotify's queue. A multi-track context cannot be kept in
    // sync with later queue adds — Spotify plays manually queued items BEFORE the context
    // remainder — which made the device order diverge from the model on real drives until
    // the reconciler flagged our own curation as "external".
    const startUri =
      args.activeTrack?.providerUri ??
      args.queueTracks
        .map((track) => track.providerUri)
        .find((uri): uri is string => Boolean(uri));

    let startedActive = false;
    if (args.shouldStart && startUri) {
      try {
        await this.spotifyAdapter.startPlayback({
          accessToken: args.accessToken,
          deviceId,
          uris: [startUri],
        });
        startedActive = true;
        if (args.activeTrack?.providerUri) {
          this.store.saveQueueOperation({
            id: crypto.randomUUID(),
            journeyId: args.journeyId,
            provider: "spotify",
            providerTrackId: args.activeTrack.providerTrackId,
            providerUri: args.activeTrack.providerUri,
            operation: "start",
            status: "success",
            deviceId,
            createdAtIso: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (isSpotifyDeviceNotFoundError(error)) {
          return { deviceReachable: false };
        }
        if (isSpotifyRateLimitError(error)) {
          return { deviceReachable: true, rateLimited: true };
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          { journeyId: args.journeyId, deviceId, err: message },
          "spotify.start.degraded",
        );
        this.store.audit(
          args.journeyId,
          "spotify.playback_error",
          "Spotify start playback failed; queue saved, playback degraded.",
          {
            deviceId,
            error: message,
          },
        );
        return { deviceReachable: false };
      }
    }

    const queueOutcome = await this.queueMissingTracks({
      journeyId: args.journeyId,
      accessToken: args.accessToken,
      deviceId,
      tracks: args.queueTracks,
      excludeUri: startedActive ? startUri : undefined,
    });
    if (queueOutcome === "unreachable") {
      return { deviceReachable: false };
    }

    if (!startedActive && transferFailed) {
      return { deviceReachable: false };
    }
    return {
      deviceReachable: true,
      rateLimited: queueOutcome === "rate-limited" || undefined,
    };
  }

  async maybeRefreshActiveJourneys(): Promise<void> {
    if (this.analyzeByJourney.size > 0) {
      return;
    }

    for (const journey of this.store.listActiveJourneys()) {
      // Inactivity auto-stop: car off overnight (no telemetry / no owned playback for a long
      // time) → end the journey so it stops curating and never silently resumes the next day.
      const inactivityMs = this.config.JOURNEY_INACTIVITY_STOP_MINUTES * 60_000;
      if (inactivityMs > 0) {
        const lastActive = new Date(
          journey.lastActiveAtIso ?? journey.createdAtIso,
        ).getTime();
        if (Date.now() - lastActive > inactivityMs) {
          this.store.audit(
            journey.id,
            "journey.auto_stopped",
            `Auto-stopped after ${this.config.JOURNEY_INACTIVITY_STOP_MINUTES} min of inactivity.`,
            { reason: "inactivity" },
          );
          await this.stopJourney(journey.id);
          continue;
        }
      }

      const session = this.store.getPlaybackSession(journey.id);
      // The user has taken over playback (podcast / another device) — don't re-curate or push.
      if (session?.status === "external") {
        continue;
      }

      const latest = this.store.latestPlaylistUpdate(journey.id);
      if (!latest) {
        await this.analyzeJourney(journey.id, "recovery");
        continue;
      }

      const ageMs = Date.now() - new Date(latest.createdAtIso).getTime();
      const unresolvedBuffer =
        journey.provider === "spotify"
          ? (session?.queuedTrackIds.length ?? 0)
          : this.store
              .listResolvedTracks(journey.id)
              .filter(
                (track) => track.provider === "tidal" && !track.addedToPlaylist,
              ).length;
      if (ageMs > this.config.journeyRefreshMs || unresolvedBuffer < 5) {
        await this.analyzeJourney(
          journey.id,
          ageMs > this.config.journeyRefreshMs ? "time-window" : "low-buffer",
        );
      }
    }
  }

  /**
   * Reconciles the backend playback model against the track Spotify reports as actually playing,
   * so skips made in the native Tesla Spotify miniplayer (which the server never sees otherwise)
   * advance our `played`/`active`/`queued` state and trigger curated refill. Best-effort: never throws.
   *
   * @returns the playback outcome, used by the poller to pick its next (adaptive) interval.
   */
  async reconcileSpotifyPlayback(
    journeyId: string,
  ): Promise<"playing" | "idle" | "external"> {
    const journey = this.store.getJourney(journeyId);
    if (
      !journey ||
      journey.provider !== "spotify" ||
      journey.status !== "active"
    ) {
      return "idle";
    }
    let session = this.store.getPlaybackSession(journeyId);
    if (!session) {
      return "idle";
    }

    let accessToken: string;
    let state: Awaited<ReturnType<SpotifyAdapter["getPlaybackState"]>>;
    try {
      accessToken = await this.spotifyAuth.getAccessToken();
      state = await this.spotifyAdapter.getPlaybackState({
        accessToken,
        market: this.config.SPOTIFY_MARKET,
      });
    } catch (error) {
      this.logger.warn(
        {
          journeyId,
          err: error instanceof Error ? error.message : String(error),
        },
        "spotify.reconcile_error",
      );
      return "idle";
    }

    // Live-Skip-Feedback: vergleiche den letzten Fortschritt mit dem aktuellen Track. Ein
    // Trackwechsel weit vor Ende (< Schwelle) zählt als bewusster Skip → Lernsignal.
    const previousProgress = this.lastProgress.get(journeyId);
    if (state.activeProviderTrackId && typeof state.progressMs === "number") {
      this.lastProgress.set(journeyId, {
        providerTrackId: state.activeProviderTrackId,
        progressMs: state.progressMs,
        durationMs: state.durationMs ?? 0,
      });
    }
    if (
      this.config.SKIP_FEEDBACK_ENABLED &&
      previousProgress &&
      state.activeProviderTrackId &&
      previousProgress.providerTrackId !== state.activeProviderTrackId &&
      previousProgress.durationMs > 0 &&
      previousProgress.progressMs / previousProgress.durationMs <
        this.config.SKIP_FEEDBACK_THRESHOLD
    ) {
      const skippedTrack = this.store
        .listResolvedTracks(journeyId)
        .find(
          (track) => track.providerTrackId === previousProgress.providerTrackId,
        );
      if (skippedTrack) this.recordSkipFeedback(journeyId, skippedTrack);
    }

    const now = new Date().toISOString();

    // Nothing playing → leave the model untouched, just back the poller off. A session that
    // was playing is now truthfully "paused" so the UI doesn't show a stopped journey as live.
    if (!state.isPlaying || !state.activeProviderTrackId) {
      if (session.status === "playing") {
        this.saveSession({
          ...session,
          status: "paused",
          lastHeartbeatAt: now,
        });
      }
      return "idle";
    }

    // User took over: a podcast/episode is on air, or playback moved to another device. Don't
    // reclaim or refill — mark the session external and back off until they return.
    if (
      this.config.PLAYBACK_RESPECT_USER_TAKEOVER &&
      playbackOwnership({
        isPlaying: state.isPlaying,
        currentlyPlayingType: state.currentlyPlayingType,
        activeDeviceId: state.activeDeviceId,
        journeyDeviceId: journey.spotifyDeviceId ?? session.deviceId,
      }) === "handed-over"
    ) {
      if (session.status !== "external") {
        this.saveSession({
          ...session,
          status: "external",
          lastHeartbeatAt: now,
        });
      }
      return "external";
    }

    const stored = this.store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    const { activeTrack, queueTracks } = this.pickSpotifyPlaybackTracks(
      stored,
      session,
    );
    const model = [activeTrack, ...queueTracks].filter(
      (
        track,
      ): track is ResolvedTrack & {
        id: string;
        addedToPlaylist: boolean;
        savedToPlaylist: boolean;
      } => Boolean(track),
    );
    const result = reconcilePlaybackModel(
      model.map((track) => track.providerTrackId),
      state.activeProviderTrackId,
      new Set(stored.map((track) => track.providerTrackId)),
    );

    // A journey track is genuinely on air → the journey is alive (feeds inactivity auto-stop),
    // and — when it's playing on a device other than the one we're bound to (the user moved
    // playback to the native Tesla app via Connect) — we follow Spotify Connect by re-binding
    // the journey + session to the active device so subsequent refills/curation target where
    // the user is actually listening, instead of queueing to the now-idle browser player. The
    // follow is passive: we never transfer or start, so we don't disrupt the playback we follow.
    if (
      result.kind === "same" ||
      result.kind === "skipped" ||
      result.kind === "drifted"
    ) {
      this.store.touchJourneyActivity(journeyId);
      const lockedDeviceId = this.getLockedDeviceId(journeyId);
      if (state.activeDeviceId && state.activeDeviceId !== session.deviceId) {
        if (lockedDeviceId && state.activeDeviceId !== lockedDeviceId) {
          // A different (transient/foreign, e.g. a lingering web player) device is momentarily
          // active right after the device was locked. Don't follow it — that would silently undo
          // the driver's choice. Keep the session bound to the locked device so refills target it.
          this.store.audit(
            journeyId,
            "spotify.device_follow_suppressed",
            "Kept the explicitly chosen device; ignored a transient active device.",
            { lockedDeviceId, activeDeviceId: state.activeDeviceId },
          );
        } else {
          const previousDeviceId = session.deviceId;
          this.store.updateJourneySpotifyDevice(
            journeyId,
            state.activeDeviceId,
          );
          session = { ...session, deviceId: state.activeDeviceId };
          this.saveSession({ ...session, lastHeartbeatAt: now });
          this.store.audit(
            journeyId,
            "spotify.device_followed",
            "Followed Spotify Connect to the active playback device.",
            {
              fromDeviceId: previousDeviceId,
              toDeviceId: state.activeDeviceId,
            },
          );
        }
      }
    }

    if (result.kind === "drifted") {
      // One of OUR journey tracks is on air, just not at a position the 6-slot model shows.
      // Spotify's queue is append-only (no remove/reorder), so stale adds or a wish rebuild
      // can legitimately put such a track on air. Re-anchor the model on reality instead of
      // pausing curation as "external".
      const driftedTrack = stored.find(
        (track) => track.providerTrackId === state.activeProviderTrackId,
      );
      if (driftedTrack) {
        const remainingQueue = model
          .filter(
            (track) =>
              track.id !== driftedTrack.id && track.id !== activeTrack?.id,
          )
          .map((track) => track.id)
          .slice(0, 5);
        this.saveSession({
          journeyId,
          provider: "spotify",
          deviceId: session.deviceId,
          status: "playing",
          activeTrack: driftedTrack,
          queuedTrackIds: remainingQueue,
          playedTrackIds: [
            ...(session.playedTrackIds ?? []),
            ...(activeTrack?.id && activeTrack.id !== driftedTrack.id
              ? [activeTrack.id]
              : []),
          ],
          targetBufferSize: 5,
          lastHeartbeatAt: now,
        });
        this.store.audit(
          journeyId,
          "spotify.playback_reanchored",
          "Re-anchored curation on a journey track playing outside the model.",
          {
            activeProviderTrackId: state.activeProviderTrackId,
            remainingQueue: remainingQueue.length,
          },
        );
        return "playing";
      }
    }

    if (result.kind === "external") {
      // Heuristic: a foreign track right after our queue drained is Spotify AUTOPLAY taking
      // over, not a deliberate user choice — reclaim with the next unused curated track.
      const lastReclaim = this.reclaimAttemptAt.get(journeyId) ?? 0;
      const cooldownMs = this.config.PLAYBACK_RECLAIM_COOLDOWN_SECONDS * 1000;
      const queueDrained = session.queuedTrackIds.length <= 1;
      // Reclaim onto the device autoplay actually took over (the one the user is listening on
      // via Connect), not the bound browser player — otherwise we'd steal back to the browser.
      // The lock wins: reclaim there so a queue-drained moment also (re)asserts the driver's chosen
      // Tesla device instead of starting our next track on a transient/foreign active one.
      const reclaimDeviceId =
        this.getLockedDeviceId(journeyId) ??
        state.activeDeviceId ??
        session.deviceId;
      if (
        this.config.PLAYBACK_RECLAIM_ENABLED &&
        queueDrained &&
        reclaimDeviceId &&
        Date.now() - lastReclaim > cooldownMs
      ) {
        const consumedIds = new Set<string>([
          ...(session.playedTrackIds ?? []),
          ...session.queuedTrackIds,
          ...(session.activeTrack?.id ? [session.activeTrack.id] : []),
        ]);
        const nextTrack = stored.find(
          (track) =>
            track.providerUri &&
            track.isPlayable !== false &&
            !consumedIds.has(track.id),
        );
        if (nextTrack) {
          this.reclaimAttemptAt.set(journeyId, Date.now());
          const applied = await this.playExact({
            journeyId,
            accessToken,
            deviceId: reclaimDeviceId,
            activeTrack: nextTrack,
            queueTracks: [],
          });
          if (applied.deviceReachable) {
            if (reclaimDeviceId !== session.deviceId) {
              this.store.updateJourneySpotifyDevice(journeyId, reclaimDeviceId);
            }
            this.saveSession({
              journeyId,
              provider: "spotify",
              deviceId: reclaimDeviceId,
              status: "playing",
              activeTrack: nextTrack,
              queuedTrackIds: [],
              playedTrackIds: [
                ...(session.playedTrackIds ?? []),
                ...(session.activeTrack?.id ? [session.activeTrack.id] : []),
              ],
              targetBufferSize: 5,
              lastHeartbeatAt: now,
            });
            this.store.audit(
              journeyId,
              "spotify.playback_reclaimed",
              "Reclaimed playback after autoplay took over a drained queue.",
              { activeProviderTrackId: nextTrack.providerTrackId },
            );
            // Refill the now-empty queue in the background.
            void this.analyzeJourney(journeyId, "skip-refill").catch(
              () => undefined,
            );
            return "playing";
          }
        }
      }
    }

    if (result.kind === "external" || result.kind === "drifted") {
      if (session.status !== "external") {
        this.saveSession({
          ...session,
          status: "external",
          lastHeartbeatAt: now,
        });
        this.store.audit(
          journeyId,
          "spotify.playback_external",
          "External track playing; Longplay curation paused.",
          {
            activeProviderTrackId: state.activeProviderTrackId,
          },
        );
      }
      return "external";
    }

    if (result.kind === "empty" || result.kind === "same") {
      // Same curated track still playing (or nothing to reconcile). If we were paused for an external
      // track, this means we're back on a journey track → resume curation.
      if (session.status !== "playing") {
        this.saveSession({
          ...session,
          status: "playing",
          lastHeartbeatAt: now,
        });
      }
      return "playing";
    }

    // result.kind === "skipped": playback advanced `index` tracks into our queue.
    const idx = result.index;
    const newlyPlayed = model.slice(0, idx).map((track) => track.id);
    const newActive = model[idx];
    const newQueue = model.slice(idx + 1);

    this.saveSession({
      journeyId,
      provider: "spotify",
      deviceId: session.deviceId,
      status: "playing",
      activeTrack: newActive,
      queuedTrackIds: newQueue.map((track) => track.id),
      playedTrackIds: [...(session.playedTrackIds ?? []), ...newlyPlayed],
      targetBufferSize: 5,
      lastHeartbeatAt: now,
    });
    this.store.audit(
      journeyId,
      "spotify.playback_reconciled",
      `Reconciled external skip: advanced ${idx} track(s).`,
      {
        advanced: idx,
        activeTrackId: newActive?.providerTrackId,
        remainingQueue: newQueue.length,
      },
    );

    // Refill curated tracks when the buffer runs low — throttled to bound AI/overhead cost.
    if (newQueue.length < this.config.SPOTIFY_REFILL_THRESHOLD) {
      const last = this.store.latestPlaylistUpdate(journeyId);
      const minIntervalMs =
        this.config.SPOTIFY_REFILL_MIN_INTERVAL_SECONDS * 1000;
      if (shouldRegenerate(last?.createdAtIso, Date.now(), minIntervalMs)) {
        try {
          // "skip-refill" is not a vibe-changing reason → analyzeJourney recycles the existing
          // candidate pool (no LLM call) and appends to Spotify's up-next without interrupting.
          await this.analyzeJourney(journeyId, "skip-refill");
        } catch (error) {
          this.logger.warn(
            {
              journeyId,
              err: error instanceof Error ? error.message : String(error),
            },
            "spotify.reconcile_refill_error",
          );
        }
      }
    }

    return "playing";
  }

  /** Lazily creates the private per-journey Spotify playlist; returns its id (or existing/undefined). */
  private async ensureJourneySpotifyPlaylist(
    journey: JourneyRecord,
    accessToken: string,
  ): Promise<string | undefined> {
    if (journey.provider !== "spotify" || !this.spotifyAdapter.createPlaylist) {
      return journey.spotifyPlaylistId;
    }
    if (journey.spotifyPlaylistId) {
      return journey.spotifyPlaylistId;
    }
    const date = journey.createdAtIso.slice(0, 10);
    const playlist = await this.spotifyAdapter.createPlaylist({
      accessToken,
      name: `Longplay — ${journey.destination} · ${date}`,
      description: `Telemetry-aware soundtrack generated for ${journey.destination}.`,
    });
    this.store.updateJourneySpotifyPlaylist(
      journey.id,
      playlist.id,
      playlist.url,
    );
    this.store.audit(
      journey.id,
      "spotify.playlist_created",
      "Journey playlist created.",
      { playlistId: playlist.id },
    );
    return playlist.id;
  }

  /** Mirrors newly-curated tracks into the journey playlist. Best-effort: never throws. */
  private async syncJourneyPlaylist(
    journey: JourneyRecord,
    accessToken: string,
  ): Promise<void> {
    if (
      journey.provider !== "spotify" ||
      !this.spotifyAdapter.addTracksToPlaylist
    ) {
      return;
    }
    try {
      const pending = this.store
        .listResolvedTracks(journey.id)
        .filter(
          (track) =>
            track.provider === "spotify" &&
            track.addedToPlaylist &&
            !track.savedToPlaylist &&
            track.providerUri,
        );
      if (pending.length === 0) {
        return;
      }
      const playlistId = await this.ensureJourneySpotifyPlaylist(
        journey,
        accessToken,
      );
      if (!playlistId) {
        return;
      }
      const uris = pending.map((track) => track.providerUri as string);
      for (let i = 0; i < uris.length; i += 100) {
        await this.spotifyAdapter.addTracksToPlaylist({
          accessToken,
          playlistId,
          uris: uris.slice(i, i + 100),
        });
      }
      this.store.markTracksSavedToPlaylist(pending.map((track) => track.id));
      this.store.audit(
        journey.id,
        "spotify.playlist_extended",
        `Added ${pending.length} tracks to the journey playlist.`,
        {
          count: pending.length,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { journeyId: journey.id, err: message },
        "spotify.playlist.degraded",
      );
      this.store.audit(
        journey.id,
        "spotify.playlist_error",
        "Could not update the journey playlist; will retry next analysis.",
        {
          error: message,
        },
      );
    }
  }

  private async generateAndStoreCandidates(
    journeyId: string,
    context: Parameters<SongScout["generateCandidates"]>[0],
    targetCount: number,
    policy = buildRecommendationPolicy(context),
  ): Promise<SongCandidate[]> {
    let generated: SongCandidate[];
    const scoutStartedAt = Date.now();
    this.logger.info({ journeyId, targetCount }, "scout.generate.start");
    try {
      generated = await this.songScout.generateCandidates(
        context,
        targetCount,
        policy,
      );
    } catch (error) {
      if (!isRecoverableScoutError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { journeyId, ms: Date.now() - scoutStartedAt, err: message },
        "scout.generate.fallback",
      );
      this.store.audit(
        journeyId,
        "recommendation.scout_failed",
        "Song scout returned unusable output; using deterministic fallback candidates.",
        { error: message },
      );
      generated = fallbackCandidates(context, targetCount);
    }
    this.logger.info(
      {
        journeyId,
        count: generated.length,
        source: generated[0]?.source,
        ms: Date.now() - scoutStartedAt,
      },
      "scout.generate.done",
    );

    return this.enrichAndStoreCandidates(journeyId, generated);
  }

  private async generateAndStoreCandidateSet(
    journeyId: string,
    context: JourneyContext,
    policy: RecommendationPolicy,
    targetCount: number,
    seed = 0,
    extras: { bannedArtists?: ReadonlySet<string> } = {},
  ): Promise<SongCandidate[]> {
    const wishCandidates = await this.enrichAndStoreCandidates(
      journeyId,
      candidatesFromMusicWishes(context.activeMusicWishes ?? []),
    );
    // Dritte Quelle: Momentum-Radio aus dem Last.fm-Similar-Graph — umkreist den
    // aktuellen Moment (Now-Playing, Wünsche, Taste) statt der üblichen Chart-Tops.
    const similarPromise: Promise<SongCandidate[]> =
      this.config.SIMILAR_SOURCE_ENABLED && this.lastfmCharts
        ? momentumRadioCandidates({
            lastfm: this.lastfmCharts,
            nowPlaying: context.nowPlaying,
            wishArtists: (context.activeMusicWishes ?? [])
              .flatMap((wish) => wish.intents)
              .flatMap((intent) =>
                intent.type === "artist" ? [intent.artist] : [],
              ),
            tasteArtists: context.tasteProfile?.representativeArtists ?? [],
            tasteWeight: context.tasteWeight ?? 0.5,
            seed,
            bannedArtists: extras.bannedArtists ?? new Set(),
            moodTags: policy.moodTags,
            limit: 8,
            rankMin: this.config.SIMILAR_RANK_MIN,
            rankMax: this.config.SIMILAR_RANK_MAX,
          }).catch(() => [] as SongCandidate[])
        : Promise.resolve([] as SongCandidate[]);
    // Vierte Quelle: Release-Radar — frische Alben/Singles der Taste-Artisten + kuratierte New Releases.
    const freshPromise: Promise<SongCandidate[]> =
      this.config.SPOTIFY_FRESH_ENABLED && this.freshAlbumSource
        ? releaseRadarCandidates({
            albums: this.freshAlbumSource,
            tasteArtists: this.freshSeedArtists(context),
            bannedArtists: extras.bannedArtists ?? new Set(),
            moodTags: policy.moodTags,
            windowDays: this.config.FRESH_WINDOW_DAYS,
            limit: 8,
          }).catch(() => [] as SongCandidate[])
        : Promise.resolve([] as SongCandidate[]);
    const [chartCandidates, aiCandidates, similarCandidates, freshCandidates] =
      await Promise.all([
        this.generateAndStoreLastfmCandidates(
          journeyId,
          context,
          policy,
          targetCount + 8,
          seed,
        ),
        this.generateAndStoreCandidates(
          journeyId,
          context,
          targetCount,
          policy,
        ),
        similarPromise.then((items) =>
          this.enrichAndStoreCandidates(journeyId, items),
        ),
        freshPromise.then((items) =>
          this.enrichAndStoreCandidates(journeyId, items),
        ),
      ]);
    const seen = new Set<string>();
    return [
      ...wishCandidates,
      ...freshCandidates,
      ...similarCandidates,
      ...chartCandidates,
      ...aiCandidates,
    ].filter((candidate) => {
      const key = songKey(candidate.artist, candidate.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private filterFreshCandidates(
    candidates: SongCandidate[],
    consumedSongKeys: Set<string>,
  ): SongCandidate[] {
    const seen = new Set(consumedSongKeys);
    return candidates.filter((candidate) => {
      const key = songKey(candidate.artist, candidate.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Seed artists for the release radar: the cached taste profile's artists with their Spotify ids. */
  private freshSeedArtists(
    context: JourneyContext,
  ): Array<{ id: string; name: string }> {
    return (context.tasteArtistsWithIds ?? [])
      .filter((a) => a.id && a.name)
      .slice(0, 8);
  }

  private async generateAndStoreLastfmCandidates(
    journeyId: string,
    context: JourneyContext,
    policy: RecommendationPolicy,
    targetCount: number,
    seed = 0,
  ): Promise<SongCandidate[]> {
    if (!this.lastfmCharts) return [];
    const country = this.countryNameForCharts(context);
    const tags = policy.moodTags.slice(0, policy.familyMode ? 5 : 3);
    const rotation = this.config.LASTFM_CHART_ROTATION_ENABLED;
    const page = rotation ? (seed % this.config.LASTFM_CHART_PAGES) + 1 : 1;
    const window = rotation
      ? this.config.FRESH_CHART_WINDOW
      : Math.max(targetCount, 30);
    const [geoTracks, tagTracks] = await Promise.all([
      this.lastfmCharts.getGeoTopTracks(country, window, page),
      Promise.all(
        tags.map((tag) => this.lastfmCharts!.getTagTopTracks(tag, 12, page)),
      ),
    ]);
    const pool = [...geoTracks, ...tagTracks.flat()];
    const rotated = rotation ? rotateWindow(pool, seed, pool.length) : pool;
    const candidates = lastfmTracksToCandidates(
      rotated,
      context,
      policy.moodTags,
    ).slice(0, targetCount);
    if (candidates.length === 0) return [];
    this.logger.info(
      { journeyId, country, tags, count: candidates.length },
      "lastfm.candidates.done",
    );
    this.store.audit(
      journeyId,
      "recommendation.lastfm",
      `Loaded ${candidates.length} Last.fm chart/tag candidates.`,
      {
        country,
        tags,
      },
    );
    return this.enrichAndStoreCandidates(journeyId, candidates);
  }

  private countryNameForCharts(context: JourneyContext): string | undefined {
    if (context.countryName) return context.countryName;
    if (
      context.countryCode &&
      COUNTRY_NAME_BY_CODE[context.countryCode.toUpperCase()]
    ) {
      return COUNTRY_NAME_BY_CODE[context.countryCode.toUpperCase()];
    }
    const regionCountry = context.coarseRegion
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1);
    if (regionCountry) return regionCountry;
    return (
      COUNTRY_NAME_BY_CODE[this.config.SPOTIFY_MARKET.toUpperCase()] ??
      COUNTRY_NAME_BY_CODE[this.config.TIDAL_COUNTRY_CODE.toUpperCase()]
    );
  }

  private async enrichAndStoreCandidates(
    journeyId: string,
    generated: SongCandidate[],
  ): Promise<SongCandidate[]> {
    const enrichStartedAt = Date.now();
    const enriched = await Promise.all(
      generated.map((candidate) => this.openMusic.enrichCandidate(candidate)),
    );
    this.logger.info(
      { journeyId, count: enriched.length, ms: Date.now() - enrichStartedAt },
      "scout.enrich.done",
    );
    return enriched.map((candidate) => {
      const id = this.store.saveCandidate(journeyId, candidate);
      return { ...candidate, id };
    });
  }

  private storeResolved(
    journeyId: string,
    candidates: SongCandidate[],
    resolved: ResolvedTrack[],
  ): string[] {
    return resolved.map((track) => {
      const candidate = candidates.find(
        (item) => item.artist === track.artist || item.title === track.title,
      );
      return this.store.saveResolvedTrack(journeyId, candidate?.id, track);
    });
  }

  private async ensureTidalPlaylist(
    journeyId: string,
    destination: string,
  ): Promise<void> {
    const journey = this.getJourneyOrThrow(journeyId);
    if (journey.tidalPlaylistId) {
      return;
    }

    const accessToken = await this.tidalAuth.getAccessToken();
    const playlist = await this.tidalAdapter.createPlaylist({
      accessToken,
      name: `Longplay - ${destination}`,
      description: `Generated for ${destination}. Updated in 5-track rolling batches.`,
      countryCode: this.config.TIDAL_COUNTRY_CODE,
      idempotencyKey: `playlist-${journeyId}`,
    });

    this.store.updateJourneyPlaylist(
      journeyId,
      playlist.id,
      playlist.url ?? undefined,
    );
    this.store.audit(
      journeyId,
      "tidal.playlist_created",
      "TIDAL playlist created.",
      { playlistId: playlist.id },
    );
  }

  private saveSession(session: PlaybackSession): void {
    this.store.savePlaybackSession({
      ...session,
      targetBufferSize: 5,
    });
  }
}

function isRecoverableScoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  if (error.message.startsWith("Prompt contains forbidden data hints")) {
    return false;
  }

  return true;
}
