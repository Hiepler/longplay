import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeText } from "@longplay/core";
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
import { Store, contextFromJourney } from "../src/db/store.js";
import { JourneyService } from "../src/journeys/journeyService.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Adapter whose reported "currently playing" track is fully controllable per test. */
class ControllableAdapter implements SpotifyAdapter {
  playbackState: SpotifyPlaybackState = {
    isPlaying: false,
    queuedProviderTrackIds: [],
  };
  startCalls: { deviceId: string; uris: string[] }[] = [];
  queueCalls: { deviceId: string; uri: string }[] = [];
  transferCalls: { deviceId: string }[] = [];

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
        externalUrl: `https://open.spotify.com/track/${id}`,
        albumArtUrl: `https://img/${id}`,
      },
    ];
  }

  async transferPlayback(args: { deviceId: string }): Promise<void> {
    this.transferCalls.push({ deviceId: args.deviceId });
  }
  async resolvePlaybackDeviceId(args: {
    preferredDeviceId: string;
  }): Promise<string> {
    return args.preferredDeviceId;
  }
  async skipToNext(): Promise<void> {}
  async skipToPrevious(): Promise<void> {}
  async startPlayback(args: {
    deviceId: string;
    uris: string[];
  }): Promise<void> {
    this.startCalls.push({ deviceId: args.deviceId, uris: args.uris });
  }
  async addToQueue(args: { deviceId: string; uri: string }): Promise<void> {
    this.queueCalls.push({ deviceId: args.deviceId, uri: args.uri });
  }
  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    // Mirror a real device: everything added via addToQueue shows up in the device queue,
    // on top of whatever base state the test pinned explicitly.
    return {
      ...this.playbackState,
      queuedProviderTrackIds: [
        ...new Set([
          ...this.playbackState.queuedProviderTrackIds,
          ...this.queueCalls
            .map((call) => call.uri.split(":").pop())
            .filter((id): id is string => Boolean(id)),
        ]),
      ],
    };
  }
}

function buildService(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-reconcile-"));
  tmpDirs.push(dir);
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173",
    ...overrides,
  });
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const adapter = new ControllableAdapter();
  const service = new JourneyService(
    config,
    store,
    new TidalAuthService(config, store),
    new MockTidalAdapter(),
    new SpotifyAuthService(config, store),
    adapter,
    new XaiSongScout({
      apiKey: config.XAI_API_KEY,
      baseUrl: config.XAI_BASE_URL,
      model: config.XAI_MODEL,
      mock: true,
    }),
    new NoopOpenMusicClient(),
  );
  return { service, store, adapter, db };
}

async function startSpotifyJourney(service: JourneyService) {
  const journey = await service.startJourney({
    destination: "Dijon",
    userPrompt: "cinematic golden-hour drive",
    passengerMode: "solo",
    provider: "spotify",
    deviceId: "tesla-web-device",
  });
  await service.registerSpotifyDevice(journey.id, "tesla-web-device", "ready", {
    syncOnly: true,
  });
  return journey;
}

async function explicitlyPickDevice(
  service: JourneyService,
  journeyId: string,
  deviceId: string,
) {
  await service.registerSpotifyDevice(journeyId, deviceId, "ready", {
    syncOnly: true,
    transfer: true,
    pin: true,
  });
}

/**
 * Reconstructs the ordered playback model exactly as the service does: [active, ...queued]
 * with the active track de-duplicated out of the queue. Returns both the internal track id
 * (what the session stores in played/queued) and the providerTrackId (what Spotify reports).
 */
function modelOf(
  store: Store,
  journeyId: string,
): Array<{ id: string; providerTrackId: string }> {
  const session = store.getPlaybackSession(journeyId)!;
  const stored = store
    .listResolvedTracks(journeyId)
    .filter((t) => t.provider === "spotify");
  const byId = new Map(stored.map((t) => [t.id, t]));
  const activeId = session.activeTrack?.id;
  const orderedIds = [
    ...(activeId ? [activeId] : []),
    ...session.queuedTrackIds.filter((id) => id !== activeId),
  ];
  return orderedIds
    .map((id) => byId.get(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({ id: t.id, providerTrackId: t.providerTrackId }));
}

describe("reconcileSpotifyPlayback", () => {
  it("no-ops when the active track is still the one playing", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const before = store.getPlaybackSession(journey.id)!;
    const model = modelOf(store, journey.id);

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    const after = store.getPlaybackSession(journey.id)!;
    expect(after.playedTrackIds ?? []).toEqual(before.playedTrackIds ?? []);
    expect(after.queuedTrackIds).toEqual(before.queuedTrackIds);
  });

  it("advances played/active/queued when the user skipped natively", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);
    expect(model.length).toBeGreaterThanOrEqual(3);

    // Simulate two native skips: Spotify is now playing the 3rd track in our model.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[2].providerTrackId,
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    const after = store.getPlaybackSession(journey.id)!;
    expect(
      (after.activeTrack as { providerTrackId: string }).providerTrackId,
    ).toBe(model[2].providerTrackId);
    // The two skipped-over tracks moved into history (session stores internal track ids).
    expect(after.playedTrackIds).toContain(model[0].id);
    expect(after.playedTrackIds).toContain(model[1].id);
  });

  it(
    "native Tesla skip advances and refills on the locked device without restarting",
    { timeout: 30_000 },
    async () => {
      const { service, store, adapter } = buildService({
        SPOTIFY_REFILL_MIN_INTERVAL_SECONDS: "0",
        SPOTIFY_REFILL_THRESHOLD: "4",
        SPOTIFY_QUEUE_ADD_DELAY_MS: "0",
      });
      const journey = await startSpotifyJourney(service);
      await explicitlyPickDevice(service, journey.id, "native-tesla-app");
      const model = modelOf(store, journey.id);
      expect(model.length).toBeGreaterThanOrEqual(3);

      adapter.startCalls.length = 0;
      adapter.queueCalls.length = 0;
      adapter.transferCalls.length = 0;
      adapter.playbackState = {
        isPlaying: true,
        activeProviderTrackId: model[2].providerTrackId,
        queuedProviderTrackIds: [],
        activeDeviceId: "native-tesla-app",
        progressMs: 1_000,
        durationMs: 180_000,
      };

      const outcome = await service.reconcileSpotifyPlayback(journey.id);

      expect(outcome).toBe("playing");
      const after = store.getPlaybackSession(journey.id)!;
      expect(
        (after.activeTrack as { providerTrackId: string }).providerTrackId,
      ).toBe(model[2].providerTrackId);
      expect(after.playedTrackIds).toContain(model[0].id);
      expect(after.playedTrackIds).toContain(model[1].id);
      expect(adapter.startCalls.length).toBe(0);
      expect(adapter.transferCalls.length).toBe(0);
      expect(adapter.queueCalls.length).toBeGreaterThan(0);
      expect(
        adapter.queueCalls.every(
          (call) => call.deviceId === "native-tesla-app",
        ),
      ).toBe(true);
    },
  );

  it("pauses curation (status=external) when an off-journey track is playing", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const before = store.getPlaybackSession(journey.id)!;

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "foreign-track-not-ours",
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("external");
    const after = store.getPlaybackSession(journey.id)!;
    expect(after.status).toBe("external");
    // Off-journey must not advance our curated queue.
    expect(after.queuedTrackIds).toEqual(before.queuedTrackIds);
  });

  it("resumes curation once a journey track plays again after going external", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "foreign",
      queuedProviderTrackIds: [],
    };
    await service.reconcileSpotifyPlayback(journey.id);
    expect(store.getPlaybackSession(journey.id)!.status).toBe("external");

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    expect(store.getPlaybackSession(journey.id)!.status).toBe("playing");
  });

  it("stays idle (no throw, no change) when nothing is playing", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const before = store.getPlaybackSession(journey.id)!;

    adapter.playbackState = { isPlaying: false, queuedProviderTrackIds: [] };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("idle");
    const after = store.getPlaybackSession(journey.id)!;
    expect(after.queuedTrackIds).toEqual(before.queuedTrackIds);
  });

  it("returns idle for a non-existent / non-spotify journey without throwing", async () => {
    const { service } = buildService();
    await expect(
      service.reconcileSpotifyPlayback("does-not-exist"),
    ).resolves.toBe("idle");
  });

  it("marks the session paused when the remote device stops playing, and resumes", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);
    expect(store.getPlaybackSession(journey.id)!.status).toBe("playing");

    // Tesla miniplayer pause → Spotify reports nothing playing.
    adapter.playbackState = { isPlaying: false, queuedProviderTrackIds: [] };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);
    expect(outcome).toBe("idle");
    expect(store.getPlaybackSession(journey.id)!.status).toBe("paused");

    // Resume in the miniplayer on the curated track → back to playing.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
    };
    await service.reconcileSpotifyPlayback(journey.id);
    expect(store.getPlaybackSession(journey.id)!.status).toBe("playing");
  });

  it("follows Spotify Connect to the active device without stealing playback", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);
    adapter.startCalls.length = 0;
    adapter.transferCalls.length = 0;
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "tesla-web-device",
    );

    // Our active track is now playing on a *different* Connect device (native Tesla app).
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "native-tesla-app",
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    // Re-bound to the device the user is actually listening on…
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "native-tesla-app",
    );
    expect(store.getPlaybackSession(journey.id)!.deviceId).toBe(
      "native-tesla-app",
    );
    // …and nothing was transferred or (re)started — following is passive.
    expect(adapter.startCalls.length).toBe(0);
    expect(adapter.transferCalls.length).toBe(0);
  });

  it("queues a refill against the followed device, not the original browser id", async () => {
    const { service, store, adapter } = buildService({
      SPOTIFY_REFILL_MIN_INTERVAL_SECONDS: "0",
    });
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);

    // Follow the native app first (skipped far enough to drop the buffer under the refill floor).
    const skipTarget = model[Math.min(model.length - 1, 3)];
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: skipTarget.providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "native-tesla-app",
    };
    adapter.queueCalls.length = 0;
    await service.reconcileSpotifyPlayback(journey.id);

    const deadline = Date.now() + 20_000;
    while (service.isAnalysisPending(journey.id)) {
      if (Date.now() > deadline)
        throw new Error("refill analysis did not finish");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Every queue add issued after the follow targets the followed device.
    expect(adapter.queueCalls.length).toBeGreaterThan(0);
    for (const call of adapter.queueCalls) {
      expect(call.deviceId).toBe("native-tesla-app");
    }
  });

  it("re-anchors instead of pausing when one of OUR tracks plays outside the model", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);
    const modelIds = new Set(model.map((track) => track.providerTrackId));
    const stored = store
      .listResolvedTracks(journey.id)
      .filter((track) => track.provider === "spotify");
    // The resolver stores more tracks than the 6-slot model shows — exactly the kind of
    // track a stale (append-only) Spotify queue can put on air during a real drive.
    const ours = stored.find((track) => !modelIds.has(track.providerTrackId));
    expect(ours).toBeDefined();

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: ours!.providerTrackId,
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    const after = store.getPlaybackSession(journey.id)!;
    expect(after.status).toBe("playing");
    expect(
      (after.activeTrack as { providerTrackId: string }).providerTrackId,
    ).toBe(ours!.providerTrackId);
    // The modeled queue stays upcoming instead of being wiped.
    expect(after.queuedTrackIds.length).toBeGreaterThan(0);
  });

  it("reclaims playback when autoplay takes over after the queue drained", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const session = store.getPlaybackSession(journey.id)!;

    // Simulate a drained queue: everything modeled was consumed.
    store.savePlaybackSession({
      ...session,
      queuedTrackIds: [],
      playedTrackIds: [
        ...(session.playedTrackIds ?? []),
        ...session.queuedTrackIds,
      ],
    });
    adapter.startCalls.length = 0;

    // Spotify autoplay put a foreign track on air.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "spotify-autoplay-foreign",
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    // Assert immediately after reconcile — before any background work.
    expect(adapter.startCalls.length).toBe(1);
    expect(adapter.startCalls[0].uris).toHaveLength(1);
    const after = store.getPlaybackSession(journey.id)!;
    expect(after.status).toBe("playing");
    expect(after.activeTrack?.providerUri).toBe(adapter.startCalls[0].uris[0]);

    // Wait for any in-flight background analyze to finish before afterEach cleanup.
    const deadline = Date.now() + 20_000;
    while (service.isAnalysisPending(journey.id)) {
      if (Date.now() > deadline)
        throw new Error("wish analysis did not finish");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it("respects a deliberate external choice when the queue is healthy", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    adapter.startCalls.length = 0;

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "foreign-deliberate",
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("external");
    expect(adapter.startCalls.length).toBe(0);
    expect(store.getPlaybackSession(journey.id)!.status).toBe("external");
  });

  it("does not steal playback when registering a second device passively", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    expect(store.getPlaybackSession(journey.id)!.status).toBe("playing");
    adapter.startCalls.length = 0;

    // Browser reopens and passively registers its webplayer while the Tesla plays.
    const result = await service.registerSpotifyDevice(
      journey.id,
      "browser-webplayer",
      "ready",
      { syncOnly: true },
    );

    expect(adapter.startCalls.length).toBe(0); // no transfer/start
    expect(result.deviceId).toBe("tesla-web-device"); // current session returned
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "tesla-web-device",
    );

    // Explicit user choice still switches.
    await service.registerSpotifyDevice(
      journey.id,
      "browser-webplayer",
      "ready",
      {
        syncOnly: true,
        transfer: true,
      },
    );
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "browser-webplayer",
    );
    expect(adapter.startCalls.length).toBeGreaterThan(0);
  });

  it("does not reclaim twice within the cooldown window", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const session = store.getPlaybackSession(journey.id)!;
    store.savePlaybackSession({ ...session, queuedTrackIds: [] });

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "autoplay-1",
      queuedProviderTrackIds: [],
    };
    await service.reconcileSpotifyPlayback(journey.id);
    adapter.startCalls.length = 0;

    // Drain again immediately; second foreign track within cooldown → respect it.
    const again = store.getPlaybackSession(journey.id)!;
    store.savePlaybackSession({ ...again, queuedTrackIds: [] });
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "autoplay-2",
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("external");
    expect(adapter.startCalls.length).toBe(0);
  });

  it(
    "pre-warms the candidate pool after analysis when it falls below the floor",
    { timeout: 20_000 },
    async () => {
      // Floor high enough that the post-start pool is always below it; refill throttle off so
      // the pre-warm is not blocked by the just-finished initial analysis. In mock mode the
      // deterministic scout regenerates identical tracks (dedup → no row growth), so the
      // observable contract is the pool_prewarmed audit proving the full pipeline ran.
      const { service, store } = buildService({
        CANDIDATE_POOL_FLOOR: "50",
        SPOTIFY_REFILL_MIN_INTERVAL_SECONDS: "0",
      });
      const journey = await startSpotifyJourney(service);

      const deadline = Date.now() + 15_000;
      for (;;) {
        if (store.latestAuditEvent(journey.id, "recommendation.pool_prewarmed"))
          break;
        if (Date.now() > deadline) throw new Error("pool did not pre-warm");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },
  );

  it("skips pre-warming when disabled via a zero floor", async () => {
    const { service, store } = buildService({
      CANDIDATE_POOL_FLOOR: "0",
      SPOTIFY_REFILL_MIN_INTERVAL_SECONDS: "0",
    });
    const journey = await startSpotifyJourney(service);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(
      store.latestAuditEvent(journey.id, "recommendation.pool_prewarmed"),
    ).toBeUndefined();
  });
});

describe("connect-mode queue sync", () => {
  it("starts only the active track and feeds the queue through queue-adds in model order", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);

    const model = modelOf(store, journey.id);
    expect(model.length).toBeGreaterThanOrEqual(3);

    // Single ordering source: the playback context is the active track only — a multi-track
    // context cannot be kept in sync with later queue adds (Spotify plays manual queue items
    // before the context remainder), which is what made device order diverge on real drives.
    expect(adapter.startCalls.length).toBeGreaterThan(0);
    for (const call of adapter.startCalls) {
      expect(call.uris).toHaveLength(1);
    }
    expect(adapter.startCalls[0].uris[0]).toBe(
      `spotify:track:${model[0].providerTrackId}`,
    );
    // Every upcoming track reaches the device through the queue, in model order, exactly once.
    const queuedUris = adapter.queueCalls.map((call) => call.uri);
    expect(queuedUris).toEqual(
      model.slice(1).map((track) => `spotify:track:${track.providerTrackId}`),
    );
  });

  it("adds nothing to the device queue on a full-buffer re-analysis", async () => {
    const { service, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const queueCallsBefore = adapter.queueCalls.length;
    const startCallsBefore = adapter.startCalls.length;

    await service.analyzeJourney(journey.id, "manual");

    // Full buffer → the model gains nothing → Spotify must receive nothing.
    expect(adapter.queueCalls.length).toBe(queueCallsBefore);
    expect(adapter.startCalls.length).toBe(startCallsBefore);
  });

  it("never transfers playback on a refill of an already-playing session", async () => {
    const { service, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    // A live session that is already playing → a refill must only queue, never (re)assert the
    // device, or it would steal playback back from whatever Connect device the user moved to.
    adapter.transferCalls.length = 0;

    await service.analyzeJourney(journey.id, "manual");

    expect(adapter.transferCalls.length).toBe(0);
  });

  // Two full analysis passes (initial + wish rebuild) with real per-add pacing → allow 30s.
  it(
    "keeps every wish-rebuild queue add inside the visible model",
    { timeout: 30_000 },
    async () => {
      const { service, store, adapter } = buildService();
      const journey = await startSpotifyJourney(service);
      const before = adapter.queueCalls.length;

      await service.createMusicWish(journey.id, {
        text: "mehr Taylor Swift",
        source: "text",
      });

      const deadline = Date.now() + 20_000;
      while (service.isAnalysisPending(journey.id)) {
        if (Date.now() > deadline)
          throw new Error("wish analysis did not finish");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const model = modelOf(store, journey.id);
      const modelUris = new Set(
        model.map((track) => `spotify:track:${track.providerTrackId}`),
      );
      const newAdds = adapter.queueCalls.slice(before).map((call) => call.uri);
      expect(newAdds.length).toBeGreaterThan(0);
      for (const uri of newAdds) {
        expect(modelUris.has(uri)).toBe(true);
      }
    },
  );

  it(
    "opens the journey with a taste-anchor track",
    { timeout: 20_000 },
    async () => {
      const { service, store } = buildService();
      // The reconcile harness adapter has no getTopArtists, so seed the taste profile
      // directly — the opening anchor is drawn from representativeArtists.
      const tasteArtists = [
        "Bonobo",
        "Tame Impala",
        "Khruangbin",
        "Tycho",
        "The War on Drugs",
      ];
      store.saveCachedTasteProfile("local", {
        topGenres: ["downtempo", "indie"],
        representativeArtists: tasteArtists,
      });

      const journey = await startSpotifyJourney(service);
      const session = store.getPlaybackSession(journey.id)!;
      expect(session.activeTrack?.artist).toBeDefined();
      expect(tasteArtists).toContain(session.activeTrack!.artist);
    },
  );

  it(
    "a border crossing schedules local hits with a priority slot",
    { timeout: 20_000 },
    async () => {
      const { service, store } = buildService({
        SPOTIFY_REFILL_MIN_INTERVAL_SECONDS: "0",
      });
      const journey = await startSpotifyJourney(service);

      // Telemetrie-Historie: Deutschland → Italien (älterer Snapshot zuerst gespeichert).
      store.saveTelemetry(
        journey.id,
        {
          timestampIso: new Date(Date.now() - 60_000).toISOString(),
          countryCode: "DE",
          countryName: "Germany",
        } as any,
        "cruise",
      );
      store.saveTelemetry(
        journey.id,
        {
          timestampIso: new Date().toISOString(),
          countryCode: "IT",
          countryName: "Italy",
        } as any,
        "cruise",
      );

      await service.evaluateJourneyMoments(journey.id);
      // moment:border_crossing ist vibe-changing → Analyse lief; Moment-Kandidaten gespeichert.
      const deadline = Date.now() + 15_000;
      while (service.isAnalysisPending(journey.id)) {
        if (Date.now() > deadline)
          throw new Error("moment analysis did not finish");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const candidates = store.listResolvedTracks(journey.id);
      expect(candidates.length).toBeGreaterThan(0);
      const audit = store.latestAuditEvent(journey.id, "moment.triggered");
      expect(audit).toBeDefined();
    },
  );

  it(
    "a charge stop opens a new leg (legIndex increments)",
    { timeout: 20_000 },
    async () => {
      const { service, store } = buildService({
        SPOTIFY_REFILL_MIN_INTERVAL_SECONDS: "0",
      });
      const journey = await startSpotifyJourney(service);
      expect(store.getJourney(journey.id)!.legIndex ?? 0).toBe(0);

      // Telemetry: battery low for two readings, then a sustained jump after charging (oldest first).
      const battery = [18, 20, 80, 82];
      battery.forEach((batteryPercent, i) => {
        store.saveTelemetry(
          journey.id,
          {
            timestampIso: new Date(
              Date.now() - (battery.length - i) * 60_000,
            ).toISOString(),
            countryCode: "FR",
            countryName: "France",
            batteryPercent,
          } as any,
          "cruise",
        );
      });

      await service.evaluateJourneyMoments(journey.id);
      const deadline = Date.now() + 15_000;
      while (service.isAnalysisPending(journey.id)) {
        if (Date.now() > deadline)
          throw new Error("moment analysis did not finish");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(store.getJourney(journey.id)!.legIndex).toBe(1);
      expect(
        store.latestAuditEvent(journey.id, "moment.charge_resume_leg"),
      ).toBeDefined();
    },
  );

  it("derives weatherFeel for the journey context from on-board temperature", async () => {
    const { service, store } = buildService();
    const journey = await startSpotifyJourney(service);
    store.saveTelemetry(
      journey.id,
      { timestampIso: "2026-07-15T13:00:00", outsideTempC: 31 } as any,
      "cruise",
    );
    const context = contextFromJourney(
      store.getJourney(journey.id)!,
      store.latestTelemetry(journey.id),
    );
    expect(context.weatherFeel).toBeDefined();
    expect(context.weatherFeel).toContain("heat");
  });

  it("learns from a native skip detected via progress heuristic", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);

    // Track 0 läuft bei ~17% — Snapshot merken.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      progressMs: 30_000,
      durationMs: 180_000,
    };
    await service.reconcileSpotifyPlayback(journey.id);

    // Wechsel zu Track 1, während Track 0 erst bei 17% stand → Skip-Signal.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[1].providerTrackId,
      queuedProviderTrackIds: [],
      progressMs: 1_000,
      durationMs: 200_000,
    };
    await service.reconcileSpotifyPlayback(journey.id);

    const skipped = store
      .listResolvedTracks(journey.id)
      .find((t) => t.providerTrackId === model[0].providerTrackId)!;
    expect(
      service
        .skipFeedbackFor(journey.id)
        .artists.get(normalizeText(skipped.artist)),
    ).toBeGreaterThan(0);
    expect(
      store.latestAuditEvent(journey.id, "feedback.skip_learned"),
    ).toBeDefined();
  });

  it("a finished track (>=90% progress) is not counted as a skip", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      progressMs: 175_000,
      durationMs: 180_000,
    };
    await service.reconcileSpotifyPlayback(journey.id);
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[1].providerTrackId,
      queuedProviderTrackIds: [],
      progressMs: 1_000,
      durationMs: 200_000,
    };
    await service.reconcileSpotifyPlayback(journey.id);

    expect(service.skipFeedbackFor(journey.id).artists.size).toBe(0);
  });
});

describe("respects user takeover (podcast / foreign device)", () => {
  it("hands over to a podcast/episode instead of pushing music", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    adapter.startCalls.length = 0;

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "some-episode",
      currentlyPlayingType: "episode",
      activeDeviceId: "tesla-web-device",
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("external");
    expect(adapter.startCalls.length).toBe(0);
    expect(store.getPlaybackSession(journey.id)!.status).toBe("external");
  });

  it("follows (does NOT hand over) when our track moves to a different device", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);
    adapter.startCalls.length = 0;
    adapter.transferCalls.length = 0;

    // A journey track id, but playing on the user's phone (foreign Connect device). This is the
    // user moving our journey to another device — we follow it rather than treating it as a
    // takeover, and never steal playback back.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      currentlyPlayingType: "track",
      activeDeviceId: "phone-xyz",
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe("phone-xyz");
    expect(adapter.startCalls.length).toBe(0);
    expect(adapter.transferCalls.length).toBe(0);
  });

  it("auto-resumes when a journey track returns to the journey device", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "some-episode",
      currentlyPlayingType: "episode",
      activeDeviceId: "phone-xyz",
      queuedProviderTrackIds: [],
    };
    await service.reconcileSpotifyPlayback(journey.id);
    expect(store.getPlaybackSession(journey.id)!.status).toBe("external");

    const model = modelOf(store, journey.id);
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      currentlyPlayingType: "track",
      activeDeviceId: "tesla-web-device",
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);
    expect(outcome).toBe("playing");
    expect(store.getPlaybackSession(journey.id)!.status).toBe("playing");
  });

  it("kill-switch off → legacy behavior keeps the journey track on the foreign device", async () => {
    const { service, store, adapter } = buildService({
      PLAYBACK_RESPECT_USER_TAKEOVER: "false",
    });
    const journey = await startSpotifyJourney(service);
    const model = modelOf(store, journey.id);
    adapter.startCalls.length = 0;

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      currentlyPlayingType: "track",
      activeDeviceId: "phone-xyz", // foreign device, but a journey track
      queuedProviderTrackIds: [],
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);
    // With the guard disabled, the foreign device is ignored and the journey track counts as owned.
    expect(outcome).toBe("playing");
    expect(store.getPlaybackSession(journey.id)!.status).toBe("playing");
  });
});

describe("inactivity auto-stop", () => {
  function backdateActivity(
    db: ReturnType<typeof buildService>["db"],
    journeyId: string,
    minutesAgo: number,
  ) {
    const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.run("UPDATE journeys SET last_active_at = ? WHERE id = ?", [
      iso,
      journeyId,
    ]);
  }

  it("stops a journey with no activity past the threshold", async () => {
    const { service, store, db } = buildService({
      JOURNEY_INACTIVITY_STOP_MINUTES: "45",
    });
    const journey = await startSpotifyJourney(service);
    backdateActivity(db, journey.id, 60);

    await service.maybeRefreshActiveJourneys();

    expect(store.getJourney(journey.id)!.status).toBe("stopped");
    expect(store.listActiveJourneys()).toHaveLength(0);
  });

  it("keeps a journey with recent activity active", async () => {
    const { service, store, db } = buildService({
      JOURNEY_INACTIVITY_STOP_MINUTES: "45",
    });
    const journey = await startSpotifyJourney(service);
    backdateActivity(db, journey.id, 5);

    await service.maybeRefreshActiveJourneys();

    expect(store.getJourney(journey.id)!.status).toBe("active");
  });

  it("never auto-stops when the threshold is 0 (disabled)", async () => {
    const { service, store, db } = buildService({
      JOURNEY_INACTIVITY_STOP_MINUTES: "0",
    });
    const journey = await startSpotifyJourney(service);
    backdateActivity(db, journey.id, 10_000);

    await service.maybeRefreshActiveJourneys();

    expect(store.getJourney(journey.id)!.status).toBe("active");
  });

  it("telemetry ingest refreshes last activity", async () => {
    const { service, store, db } = buildService({
      JOURNEY_INACTIVITY_STOP_MINUTES: "45",
    });
    const journey = await startSpotifyJourney(service);
    backdateActivity(db, journey.id, 60);

    await service.ingestTelemetry({
      timestampIso: new Date().toISOString(),
      speedKph: 80,
    } as never);

    const refreshed = store.getJourney(journey.id)!;
    expect(
      Date.now() - new Date(refreshed.lastActiveAtIso!).getTime(),
    ).toBeLessThan(10_000);
  });
});

describe("device pin (explicit choice defended)", () => {
  /** Explicitly pick a device (pin:true), like the driver tapping it in the picker. */
  async function pickDevice(
    service: JourneyService,
    journeyId: string,
    deviceId: string,
  ) {
    await explicitlyPickDevice(service, journeyId, deviceId);
  }

  it("does not follow away from an explicitly pinned device to a transient one", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    await pickDevice(service, journey.id, "native-tesla-app");
    const model = modelOf(store, journey.id);
    store.clearAuditEvents(journey.id, "spotify.device_follow_suppressed");

    // A lingering web player momentarily becomes the active device, still holding our track.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "this-browser",
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    // The explicit pick is defended — NOT rebound to the browser.
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "native-tesla-app",
    );
    expect(store.getPlaybackSession(journey.id)!.deviceId).toBe(
      "native-tesla-app",
    );
    expect(
      store.latestAuditEvent(journey.id, "spotify.device_follow_suppressed"),
    ).toBeDefined();
  });

  it("keeps the explicit lock once the chosen device is active", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    await pickDevice(service, journey.id, "native-tesla-app");
    const model = modelOf(store, journey.id);

    // The chosen device becomes the active one.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "native-tesla-app",
    };
    await service.reconcileSpotifyPlayback(journey.id);

    // Later a foreground browser/player briefly reports the same journey track as active. The
    // explicit Tesla choice is sticky for the journey and must not be followed away.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "this-browser",
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "native-tesla-app",
    );
    expect(store.getPlaybackSession(journey.id)!.deviceId).toBe(
      "native-tesla-app",
    );
    expect(
      store.latestAuditEvent(journey.id, "spotify.device_follow_suppressed"),
    ).toBeDefined();
  });

  it("follows immediately when explicit device locking is disabled", async () => {
    const { service, store, adapter } = buildService({
      PLAYBACK_DEVICE_LOCK_ENABLED: "false",
    });
    const journey = await startSpotifyJourney(service);
    await pickDevice(service, journey.id, "native-tesla-app");
    const model = modelOf(store, journey.id);

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "this-browser",
    };
    await service.reconcileSpotifyPlayback(journey.id);

    // No pin set (feature disabled) → legacy passive follow rebinds to the active device.
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe("this-browser");
  });

  it("reclaims onto the pinned device, not the foreign active device", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    await pickDevice(service, journey.id, "native-tesla-app");

    // Drain the queue so a foreign track is read as autoplay takeover.
    const session = store.getPlaybackSession(journey.id)!;
    store.savePlaybackSession({
      ...session,
      queuedTrackIds: [],
      playedTrackIds: [
        ...(session.playedTrackIds ?? []),
        ...session.queuedTrackIds,
      ],
    });
    adapter.startCalls.length = 0;

    // Autoplay put a foreign track on air on a lingering browser device.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: "spotify-autoplay-foreign",
      queuedProviderTrackIds: [],
      activeDeviceId: "this-browser",
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    expect(adapter.startCalls.length).toBe(1);
    // Reclaim (re)starts our track on the pinned Tesla, never the foreign browser device.
    expect(adapter.startCalls[0].deviceId).toBe("native-tesla-app");

    const deadline = Date.now() + 20_000;
    while (service.isAnalysisPending(journey.id)) {
      if (Date.now() > deadline)
        throw new Error("reclaim analysis did not finish");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  it("auto-adopt (pin:false) cannot override an explicit lock", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    await pickDevice(service, journey.id, "native-tesla-app");
    adapter.startCalls.length = 0;

    const result = await service.registerSpotifyDevice(
      journey.id,
      "this-browser",
      "ready",
      {
        syncOnly: true,
        transfer: true,
        pin: false,
      },
    );

    expect(result.deviceId).toBe("native-tesla-app");
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "native-tesla-app",
    );
    expect(store.getPlaybackSession(journey.id)!.deviceId).toBe(
      "native-tesla-app",
    );
    expect(adapter.startCalls.length).toBe(0);
    expect(
      store.latestAuditEvent(journey.id, "spotify.device_register_suppressed"),
    ).toBeDefined();
  });

  it("passive registration (pin:false) does not lock — the follow stays free", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    // Backend primitive: a non-pinning registration (transfer but pin:false) must not lock the
    // journey, so the passive Connect-follow stays free to track wherever playback actually is.
    await service.registerSpotifyDevice(
      journey.id,
      "native-tesla-app",
      "ready",
      {
        syncOnly: true,
        transfer: true,
        pin: false,
      },
    );
    const model = modelOf(store, journey.id);

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "this-browser",
    };
    await service.reconcileSpotifyPlayback(journey.id);

    // No lock → the follow is free to track the active device.
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe("this-browser");
  });

  it("an auto-adopted establishment (pin:true) is defended against a later transient device", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    // The driver opened Spotify on the Tesla → the web client auto-adopts WITH pin:true, locking the
    // device exactly like an explicit picker tap (no in-browser player exists, so the active device
    // is always a real Connect device worth defending).
    await service.registerSpotifyDevice(
      journey.id,
      "native-tesla-app",
      "ready",
      {
        syncOnly: true,
        transfer: true,
        pin: true,
      },
    );
    const model = modelOf(store, journey.id);

    // A lingering open.spotify.com tab momentarily reports the same journey track as active.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "this-browser",
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    // The auto-adopted Tesla is defended — playback is NOT bounced back to the browser tab.
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "native-tesla-app",
    );
    expect(store.getPlaybackSession(journey.id)!.deviceId).toBe(
      "native-tesla-app",
    );
    expect(
      store.latestAuditEvent(journey.id, "spotify.device_follow_suppressed"),
    ).toBeDefined();
  });

  it("a journey started on an already-active device (lockDevice) defends it against a transient device", async () => {
    const { service, store, adapter } = buildService();
    // Regular flow: Spotify is already playing on the native Tesla app; the driver opens the Tesla
    // browser and starts the journey, which resolves that active device and asks to lock it.
    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "cinematic golden-hour drive",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "native-tesla-app",
      lockDevice: true,
    });
    await service.registerSpotifyDevice(
      journey.id,
      "native-tesla-app",
      "ready",
      {
        syncOnly: true,
      },
    );
    const model = modelOf(store, journey.id);

    // A lingering open.spotify.com tab momentarily reports the same journey track as active.
    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "this-browser",
    };
    const outcome = await service.reconcileSpotifyPlayback(journey.id);

    expect(outcome).toBe("playing");
    // The device chosen at start is defended — playback is NOT bounced to the browser tab.
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "native-tesla-app",
    );
    expect(store.getPlaybackSession(journey.id)!.deviceId).toBe(
      "native-tesla-app",
    );
    expect(
      store.latestAuditEvent(journey.id, "spotify.device_follow_suppressed"),
    ).toBeDefined();
  });

  it("a journey started without lockDevice keeps the free passive follow", async () => {
    const { service, store, adapter } = buildService();
    const journey = await service.startJourney({
      destination: "Dijon",
      userPrompt: "cinematic golden-hour drive",
      passengerMode: "solo",
      provider: "spotify",
      deviceId: "tesla-web-device",
    });
    await service.registerSpotifyDevice(
      journey.id,
      "tesla-web-device",
      "ready",
      {
        syncOnly: true,
      },
    );
    const model = modelOf(store, journey.id);

    adapter.playbackState = {
      isPlaying: true,
      activeProviderTrackId: model[0].providerTrackId,
      queuedProviderTrackIds: [],
      activeDeviceId: "native-tesla-app",
    };
    await service.reconcileSpotifyPlayback(journey.id);

    // No lock requested → the follow is free to track the device playback actually moved to.
    expect(store.getJourney(journey.id)!.spotifyDeviceId).toBe(
      "native-tesla-app",
    );
  });

  it("explicit skips target the locked Tesla device even with a stale caller device id", async () => {
    const { service, adapter } = buildService({
      SPOTIFY_QUEUE_ADD_DELAY_MS: "0",
    });
    const journey = await startSpotifyJourney(service);
    await pickDevice(service, journey.id, "native-tesla-app");
    adapter.startCalls.length = 0;
    adapter.queueCalls.length = 0;

    await service.skipSpotifyTrack(journey.id, "next", "this-browser");

    expect(adapter.startCalls.at(-1)?.deviceId).toBe("native-tesla-app");
    expect(adapter.queueCalls.length).toBeGreaterThan(0);
    expect(
      adapter.queueCalls.every((call) => call.deviceId === "native-tesla-app"),
    ).toBe(true);
  });
});

describe("vibe shift (Kids toggle) — felt immediately", () => {
  function makePlaying(store: Store, journeyId: string) {
    const session = store.getPlaybackSession(journeyId)!;
    const tracks = store
      .listResolvedTracks(journeyId)
      .filter((track) => track.provider === "spotify");
    store.savePlaybackSession({
      ...session,
      status: "playing",
      activeTrack: tracks[0],
      queuedTrackIds: tracks.slice(1, 4).map((track) => track.id),
    });
  }

  it("a Kids toggle regenerates and starts a fresh anchor at once (interrupts the current song)", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    makePlaying(store, journey.id);
    adapter.startCalls.length = 0;

    await service.setKidsMode(journey.id, true);

    expect(store.getJourney(journey.id)!.kidsMode).toBe(true);
    // The vibe shift forces shouldStart → playback (re)starts on the curated anchor right away,
    // rather than appending behind the already-queued tracks.
    expect(adapter.startCalls.length).toBeGreaterThan(0);
  });

  it("an automated refill on a playing session does NOT interrupt (no forced start)", async () => {
    const { service, store, adapter } = buildService();
    const journey = await startSpotifyJourney(service);
    makePlaying(store, journey.id);
    adapter.startCalls.length = 0;

    await service.analyzeJourney(journey.id, "low-buffer");

    // Non-vibe reasons keep the "only start if idle" behavior — the current song plays on.
    expect(adapter.startCalls.length).toBe(0);
  });
});
