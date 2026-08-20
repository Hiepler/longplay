import type { NormalizedTelemetryEvent } from "@longplay/core";
import { normalizeFleetVehicleData } from "@longplay/telemetry";

import type { AppConfig } from "../config/env.js";
import type { TeslaAuthService } from "../auth/teslaAuth.js";
import type { JourneyService } from "../journeys/journeyService.js";
import type { Store } from "../db/store.js";
import { makeGeocodeResolver, type GeocodeResult } from "./geocoder.js";
import type { StreamLiveness } from "./streamSource.js";
import { shouldPollRest } from "./streamSource.js";

export interface PollDeps {
  apiBaseUrl: string;
  accessToken: string;
  /** Resolves the target vehicle id (configured or discovered+cached) — avoids a per-tick list call. */
  resolveVehicleId: () => Promise<string | undefined>;
  hasActiveJourney: () => boolean;
  /** When provided and true, streaming is live → the REST tick stands down (no API call). */
  streamingIsFresh?: () => boolean;
  ingest: (event: NormalizedTelemetryEvent) => Promise<void>;
  geocode: (
    lat: number,
    lon: number,
  ) => Promise<string | GeocodeResult | undefined>;
  appSecret: string;
  fetchImpl: typeof fetch;
}

/** Inputs for a single on-demand `vehicle_data` read — no journey/streaming gates. */
export interface LiveReadDeps {
  apiBaseUrl: string;
  accessToken: string;
  resolveVehicleId: () => Promise<string | undefined>;
  geocode: (
    lat: number,
    lon: number,
  ) => Promise<string | GeocodeResult | undefined>;
  appSecret: string;
  fetchImpl: typeof fetch;
}

/**
 * Performs one on-demand `vehicle_data` read and returns the normalized, geocoded event — or
 * `undefined` when no vehicle is resolvable or the car is asleep/offline (Tesla 408). This is the
 * pure I/O core shared by the background poll tick and the on-demand reader; it applies no journey
 * or streaming gates so it can run before a journey even exists (e.g. to pre-fill the start screen).
 *
 * Calling `vehicle_data` does NOT wake a sleeping car — Tesla returns 408 for an asleep/offline
 * vehicle, which we treat as "no reading".
 */
export async function readLiveTeslaReading(
  deps: LiveReadDeps,
): Promise<NormalizedTelemetryEvent | undefined> {
  const id = await deps.resolveVehicleId();
  if (!id) return undefined; // no vehicle configured/discoverable

  const auth = { Authorization: `Bearer ${deps.accessToken}` };
  const base = deps.apiBaseUrl.replace(/\/$/, "");
  const endpoints = encodeURIComponent(
    "drive_state;charge_state;climate_state",
  );
  const dataResponse = await deps.fetchImpl(
    `${base}/api/1/vehicles/${id}/vehicle_data?endpoints=${endpoints}`,
    {
      headers: auth,
    },
  );
  if (!dataResponse.ok) return undefined; // 408 asleep/offline (does not wake the car)

  const payload = (await dataResponse.json()) as {
    response?: Record<string, unknown>;
  };
  const { coordinates, ...event } = normalizeFleetVehicleData(
    payload.response ?? {},
    deps.appSecret,
  );
  if (coordinates) {
    const geocoded = await deps.geocode(coordinates.lat, coordinates.lon);
    if (typeof geocoded === "string") {
      event.coarseRegion = geocoded;
    } else if (geocoded) {
      event.coarseRegion = geocoded.coarseRegion;
      event.countryName = geocoded.countryName;
      event.countryCode = geocoded.countryCode;
      event.geoSource = geocoded.geoSource;
    }
  }
  return event;
}

/**
 * A single poll tick. Cost-optimized: it does NOT list vehicles every tick. Instead it resolves the
 * vehicle id once (configured or discovered+cached) and calls `vehicle_data` directly.
 *
 * Calling `vehicle_data` does NOT wake a sleeping car — Tesla returns 408 for an asleep/offline
 * vehicle, which we treat as "skip". This halves billed requests on every online (driving) tick
 * versus the previous list-then-data approach. Returns silently when it should not read data.
 */
export async function pollTeslaOnce(deps: PollDeps): Promise<void> {
  if (!deps.hasActiveJourney()) return;
  if (deps.streamingIsFresh?.()) return; // streaming is live → no REST call needed

  const event = await readLiveTeslaReading({
    apiBaseUrl: deps.apiBaseUrl,
    accessToken: deps.accessToken,
    resolveVehicleId: deps.resolveVehicleId,
    geocode: deps.geocode,
    appSecret: deps.appSecret,
    fetchImpl: deps.fetchImpl,
  });
  if (!event) return;
  await deps.ingest(event);
}

/**
 * Builds a vehicle-id resolver that returns a configured id immediately, or discovers it via a
 * single `/api/1/vehicles` call and caches it for the lifetime of the poller. After the first
 * discovery no further list calls are made — the main cost saving alongside `pollTeslaOnce`.
 */
export function makeVehicleIdResolver(opts: {
  apiBaseUrl: string;
  configuredVehicleId?: string;
  getAccessToken: () => Promise<string>;
  fetchImpl: typeof fetch;
}): () => Promise<string | undefined> {
  let cached = opts.configuredVehicleId;
  return async () => {
    if (cached) return cached;
    const base = opts.apiBaseUrl.replace(/\/$/, "");
    const token = await opts.getAccessToken();
    const res = await opts.fetchImpl(`${base}/api/1/vehicles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const list = (await res.json()) as {
      response?: Array<{ id_s?: string; id?: number }>;
    };
    const vehicle = (list.response ?? [])[0];
    cached =
      vehicle?.id_s ?? (vehicle?.id != null ? String(vehicle.id) : undefined);
    return cached;
  };
}

export function startTeslaFleetPoller(
  config: AppConfig,
  store: Store,
  teslaAuth: TeslaAuthService,
  journeyService: JourneyService,
  liveness: StreamLiveness,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void },
  context?: TeslaReadContext,
): NodeJS.Timeout | undefined {
  if (!config.TESLA_FLEET_ENABLED) return undefined;
  // Reuse the shared read context when provided so the vehicle id is discovered ONCE per process
  // (and the geocode cache is shared) across the poller and the on-demand reader — otherwise each
  // would make its own billed `/api/1/vehicles` discovery call.
  const geocode = context?.geocode ?? makeGeocodeResolver({ baseUrl: config.GEOCODER_URL });
  // Resolver persists across ticks so the vehicle id is discovered at most once.
  const resolveVehicleId =
    context?.resolveVehicleId ??
    makeVehicleIdResolver({
      apiBaseUrl: config.TESLA_API_BASE_URL,
      configuredVehicleId: config.TESLA_VEHICLE_ID,
      getAccessToken: () => teslaAuth.getAccessToken(),
      fetchImpl: fetch,
    });

  const tick = async () => {
    try {
      if (store.listActiveJourneys().length === 0) return;
      const accessToken = await teslaAuth.getAccessToken();
      await pollTeslaOnce({
        apiBaseUrl: config.TESLA_API_BASE_URL,
        accessToken,
        resolveVehicleId,
        hasActiveJourney: () => store.listActiveJourneys().length > 0,
        streamingIsFresh: () =>
          !shouldPollRest(
            liveness.lastIso(),
            Date.now(),
            config.STREAM_FRESH_WINDOW_SECONDS * 1000,
          ),
        ingest: (event) => journeyService.ingestTelemetry(event),
        geocode,
        appSecret: config.APP_SECRET,
        fetchImpl: fetch,
      });
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "tesla.poll_error",
      );
    }
  };

  return setInterval(() => void tick(), config.TESLA_POLL_SECONDS * 1000);
}

/** Minimal auth surface the on-demand reader needs (kept narrow for testability). */
export interface LiveReaderAuth {
  isConnected(): boolean;
  getAccessToken(): Promise<string>;
}

/**
 * Shared vehicle-id resolver + geocoder, created once and handed to BOTH the poller and the
 * on-demand reader so the vehicle id is discovered at most once per process and the geocode cache is
 * reused. Building these per-consumer would double the billed `/api/1/vehicles` discovery call.
 */
export interface TeslaReadContext {
  resolveVehicleId: () => Promise<string | undefined>;
  geocode: (
    lat: number,
    lon: number,
  ) => Promise<string | GeocodeResult | undefined>;
}

export function createTeslaReadContext(opts: {
  apiBaseUrl: string;
  configuredVehicleId?: string;
  getAccessToken: () => Promise<string>;
  geocoderUrl?: string;
  fetchImpl?: typeof fetch;
}): TeslaReadContext {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    resolveVehicleId: makeVehicleIdResolver({
      apiBaseUrl: opts.apiBaseUrl,
      configuredVehicleId: opts.configuredVehicleId,
      getAccessToken: opts.getAccessToken,
      fetchImpl,
    }),
    geocode: makeGeocodeResolver({ baseUrl: opts.geocoderUrl }),
  };
}

/**
 * Minimum spacing between on-demand reads that actually touch the car. A `vehicle_data` read never
 * wakes a SLEEPING car (Tesla returns 408), but reads against an already-awake, parked car reset its
 * sleep timer — so unbounded reads could keep it awake and drain the battery at standstill. This
 * throttle caps how often the start screen / journey seed can reach the car, regardless of how often
 * the route is hit, the page re-renders, or a journey is started right after a pre-fill.
 */
export const LIVE_READ_MIN_INTERVAL_MS = 30_000;

/** On-demand live telemetry: a one-shot read, independent of the background poll cadence. */
export interface TeslaLiveReader {
  /** True when Fleet polling is enabled and the car is connected, so a read can be attempted. */
  available(): boolean;
  /** Fetch one fresh reading now, or `undefined` if unavailable / asleep / it times out. Never throws. */
  read(timeoutMs?: number): Promise<NormalizedTelemetryEvent | undefined>;
}

/**
 * Builds a reader that fetches the car's *current* state on demand — used to pre-fill the start
 * screen and to seed a journey's very first queue with live context, instead of waiting up to a full
 * `TESLA_POLL_SECONDS` for the background poller.
 *
 * Safety: reads only ever hit `GET vehicle_data` (and a cached `GET /api/1/vehicles` discovery) —
 * never `/wake_up` or any command — so a sleeping car stays asleep (408 → `undefined`). A
 * `minIntervalMs` throttle additionally bounds how often an *awake* car is touched, preventing
 * standstill drain. Degrades silently: missing vehicle, asleep car, timeout, or any error → `undefined`.
 */
export function createTeslaLiveReader(deps: {
  config: AppConfig;
  teslaAuth: LiveReaderAuth;
  /** Shared resolver/geocoder; built privately when omitted (e.g. in tests). */
  context?: TeslaReadContext;
  logger?: { warn: (obj: Record<string, unknown>, msg?: string) => void };
  fetchImpl?: typeof fetch;
  /** Read throttle window; defaults to LIVE_READ_MIN_INTERVAL_MS. */
  minIntervalMs?: number;
  /** Injected clock for deterministic throttle tests. */
  now?: () => number;
}): TeslaLiveReader {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? LIVE_READ_MIN_INTERVAL_MS;
  const context =
    deps.context ??
    createTeslaReadContext({
      apiBaseUrl: deps.config.TESLA_API_BASE_URL,
      configuredVehicleId: deps.config.TESLA_VEHICLE_ID,
      getAccessToken: () => deps.teslaAuth.getAccessToken(),
      geocoderUrl: deps.config.GEOCODER_URL,
      fetchImpl,
    });

  const available = () =>
    deps.config.TESLA_FLEET_ENABLED && deps.teslaAuth.isConnected();

  // Throttle cache: the most recent outcome (a reading OR a miss) re-served within the window so
  // back-to-back callers never translate into back-to-back `vehicle_data` calls against the car.
  let cache: { value: NormalizedTelemetryEvent | undefined; at: number } | undefined;

  return {
    available,
    async read(timeoutMs = 4000) {
      if (!available()) return undefined;
      if (cache && now() - cache.at < minIntervalMs) return cache.value;

      // One timer both aborts the in-flight data fetch AND wins the race, so a hung vehicle-id
      // discovery (which uses the context's un-aborted fetch) can never make read() outlive timeoutMs.
      const controller = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, timeoutMs);
      });
      // Never rejects: any failure (abort, 408, parse, token) degrades to `undefined`.
      const work = async (): Promise<NormalizedTelemetryEvent | undefined> => {
        try {
          const accessToken = await deps.teslaAuth.getAccessToken();
          return await readLiveTeslaReading({
            apiBaseUrl: deps.config.TESLA_API_BASE_URL,
            accessToken,
            resolveVehicleId: context.resolveVehicleId,
            geocode: context.geocode,
            appSecret: deps.config.APP_SECRET,
            fetchImpl: (input, init) =>
              fetchImpl(input, { ...init, signal: controller.signal }),
          });
        } catch (error) {
          deps.logger?.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "tesla.live_read_error",
          );
          return undefined;
        }
      };
      try {
        const value = await Promise.race([work(), timeout]);
        cache = { value, at: now() };
        return value;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    },
  };
}
