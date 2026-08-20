import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import {
  NoopOpenMusicClient,
  OpenMusicClient,
} from "@longplay/open-music";
import {
  LastfmChartClient,
  createSongScout,
} from "@longplay/recommendation";
import {
  MockSpotifyAdapter,
  OfficialSpotifyAdapter,
} from "@longplay/spotify";
import { MockTidalAdapter, OfficialTidalAdapter } from "@longplay/tidal";

import type { AppConfig } from "./config/env.js";
import { appBaseUrl } from "./http/appBaseUrl.js";
import { migrate, openDatabase } from "./db/database.js";
import { Store } from "./db/store.js";
import { SpotifyAuthService } from "./auth/spotifyAuth.js";
import { TeslaAuthService } from "./auth/teslaAuth.js";
import { TidalAuthService } from "./auth/tidalAuth.js";
import { JourneyService } from "./journeys/journeyService.js";
import { registerJourneyRoutes } from "./journeys/routes.js";
import { registerTelemetryRoutes } from "./telemetry/routes.js";
import { createTeslaLiveReader, createTeslaReadContext } from "./telemetry/teslaFleetPoller.js";
import { StreamLiveness } from "./telemetry/streamSource.js";

export function isAuthorizedAdminRequest(
  config: AppConfig,
  authorization: string | undefined,
): boolean {
  return Boolean(
    config.ADMIN_API_TOKEN &&
    authorization === `Bearer ${config.ADMIN_API_TOKEN}`,
  );
}

function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
): boolean {
  if (isAuthorizedAdminRequest(config, request.headers.authorization)) {
    return true;
  }
  reply.code(403).send({ error: "Forbidden" });
  return false;
}

export async function buildApp(config: AppConfig) {
  const db = openDatabase(config.DATABASE_PATH);
  migrate(db);
  const store = new Store(db);
  const tidalAuth = new TidalAuthService(config, store);
  const spotifyAuth = new SpotifyAuthService(config, store);
  const teslaAuth = new TeslaAuthService(config, store);
  const streamLiveness = new StreamLiveness();
  const tidalAdapter = config.TIDAL_MOCK
    ? new MockTidalAdapter()
    : new OfficialTidalAdapter({ baseUrl: config.TIDAL_API_BASE_URL });
  const spotifyAdapter = config.SPOTIFY_MOCK
    ? new MockSpotifyAdapter()
    : new OfficialSpotifyAdapter({ baseUrl: config.SPOTIFY_API_BASE_URL });
  const { scout: songScout, info: songScoutInfo } = createSongScout({
    provider: config.SONG_SCOUT,
    mock: config.XAI_MOCK,
    gemini: {
      apiKey: config.GEMINI_API_KEY,
      baseUrl: config.GEMINI_BASE_URL,
      model: config.GEMINI_MODEL,
      mock: config.XAI_MOCK,
      requestTimeoutMs: config.SONG_SCOUT_TIMEOUT_MS,
    },
    xai: {
      apiKey: config.XAI_API_KEY,
      baseUrl: config.XAI_BASE_URL,
      model: config.XAI_MODEL,
      mock: config.XAI_MOCK,
      requestTimeoutMs: config.SONG_SCOUT_TIMEOUT_MS,
    },
    multilens: {
      perLensCount: config.SONG_SCOUT_PER_LENS,
      maxOutputTokens: config.SONG_SCOUT_MAX_OUTPUT_TOKENS,
      includeDeepCuts: config.EXPLORER_LENS_ENABLED,
    },
  });
  const openMusic = config.XAI_MOCK
    ? new NoopOpenMusicClient()
    : new OpenMusicClient({
        musicBrainzBaseUrl: config.MUSICBRAINZ_BASE_URL,
        listenBrainzBaseUrl: config.LISTENBRAINZ_BASE_URL,
        userAgent:
          "Longplay/0.1.0 (https://github.com/ai-journey-dj/ai-journey-dj)",
      });
  const lastfmCharts = new LastfmChartClient({
    apiKey: config.LASTFM_API_KEY,
    baseUrl: config.LASTFM_BASE_URL,
    enabled: config.LASTFM_ENABLED,
    chartCacheHours: config.LASTFM_CHART_CACHE_HOURS,
    tagCacheHours: config.LASTFM_TAG_CACHE_HOURS,
    similarCacheHours: config.LASTFM_SIMILAR_CACHE_HOURS,
  });
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
    },
  });

  const journeyService = new JourneyService(
    config,
    store,
    tidalAuth,
    tidalAdapter,
    spotifyAuth,
    spotifyAdapter,
    songScout,
    openMusic,
    lastfmCharts,
    app.log,
  );

  // On-demand live telemetry: pre-fills the start screen and seeds a journey's first queue without
  // waiting for the background poll cadence. Shared by the journey service and the /telemetry/live route.
  // The read context (vehicle-id resolver + geocoder) is shared with the background poller so the
  // vehicle id is discovered at most once per process.
  const teslaReadContext = createTeslaReadContext({
    apiBaseUrl: config.TESLA_API_BASE_URL,
    configuredVehicleId: config.TESLA_VEHICLE_ID,
    getAccessToken: () => teslaAuth.getAccessToken(),
    geocoderUrl: config.GEOCODER_URL,
  });
  const teslaLiveReader = createTeslaLiveReader({
    config,
    teslaAuth,
    context: teslaReadContext,
    logger: app.log,
  });
  journeyService.setLiveTelemetryReader(teslaLiveReader);

  await app.register(cors, {
    origin: (origin, callback) => {
      const allowed = config.CORS_ORIGIN.split(",").map((item) => item.trim());
      if (
        !origin ||
        allowed.includes(origin) ||
        /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(
          origin,
        )
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS."), false);
    },
    credentials: true,
  });
  await app.register(sensible);

  app.get("/health", async () => {
    const spotifyConnected = spotifyAuth.isConnected();
    const spotifyPremium = spotifyConnected
      ? await spotifyAuth.isPremium()
      : false;
    return {
      ok: true,
      tidalConnected: tidalAuth.isConnected(),
      tidalMock: config.TIDAL_MOCK,
      spotifyConnected,
      spotifyMock: config.SPOTIFY_MOCK,
      spotifyPremium,
      teslaConnected: teslaAuth.isConnected(),
      teslaFleetEnabled: config.TESLA_FLEET_ENABLED,
      xaiMock: config.XAI_MOCK,
      songScout: songScoutInfo,
      lastfm: {
        enabled: config.LASTFM_ENABLED && Boolean(config.LASTFM_API_KEY),
        configured: Boolean(config.LASTFM_API_KEY),
      },
      telemetryEnabled: config.TESLA_TELEMETRY_ENABLED,
      journeyRefreshMinutes: config.JOURNEY_REFRESH_MINUTES,
    };
  });

  app.get("/auth/spotify/login", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    try {
      if (config.SPOTIFY_MOCK) {
        return reply.redirect(`${returnBase}/?spotify=mock`);
      }
      return reply.redirect(spotifyAuth.createLoginUrl());
    } catch (error) {
      const message = encodeURIComponent(
        error instanceof Error ? error.message : String(error),
      );
      return reply.redirect(`${returnBase}/?spotify=error&message=${message}`);
    }
  });

  app.get("/auth/spotify/callback", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      const message = encodeURIComponent(
        query.error_description ?? query.error,
      );
      return reply.redirect(`${returnBase}/?spotify=error&message=${message}`);
    }

    try {
      await spotifyAuth.completeCallback(query);
    } catch (error) {
      const message = encodeURIComponent(
        error instanceof Error ? error.message : String(error),
      );
      return reply.redirect(`${returnBase}/?spotify=error&message=${message}`);
    }

    return reply.type("text/html").send(`<!doctype html>
      <html>
        <head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${returnBase}/?spotify=connected"></head>
        <body><a href="${returnBase}/?spotify=connected">Return to Longplay</a></body>
      </html>`);
  });

  app.get("/auth/spotify/token", async () => spotifyAuth.getTokenStatus());

  app.post("/auth/spotify/disconnect", async () => {
    spotifyAuth.disconnect();
    return { ok: true };
  });

  app.get(
    "/.well-known/appspecific/com.tesla.3p.public-key.pem",
    async (_request, reply) => {
      if (!config.TESLA_PUBLIC_KEY_PEM) {
        return reply.code(404).send("Tesla public key not configured.");
      }
      return reply
        .type("application/x-pem-file")
        .send(config.TESLA_PUBLIC_KEY_PEM);
    },
  );

  app.get("/auth/tesla/login", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    try {
      return reply.redirect(teslaAuth.createLoginUrl());
    } catch (error) {
      const message = encodeURIComponent(
        error instanceof Error ? error.message : String(error),
      );
      return reply.redirect(`${returnBase}/?tesla=error&message=${message}`);
    }
  });

  app.get("/auth/tesla/callback", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      const message = encodeURIComponent(
        query.error_description ?? query.error,
      );
      return reply.redirect(`${returnBase}/?tesla=error&message=${message}`);
    }
    try {
      await teslaAuth.completeCallback(query);
    } catch (error) {
      const message = encodeURIComponent(
        error instanceof Error ? error.message : String(error),
      );
      return reply.redirect(`${returnBase}/?tesla=error&message=${message}`);
    }
    return reply.type("text/html").send(`<!doctype html>
      <html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${returnBase}/?tesla=connected"></head>
      <body><a href="${returnBase}/?tesla=connected">Return to Longplay</a></body></html>`);
  });

  app.post("/auth/tesla/disconnect", async () => {
    teslaAuth.disconnect();
    return { ok: true };
  });

  // Read-only verification: confirms the stored token works by listing vehicles.
  // Listing vehicles never wakes a sleeping car. Returns only display name + online state (no VIN).
  app.get("/auth/tesla/status", async (_request, reply) => {
    if (!teslaAuth.isConnected()) {
      return { connected: false, fleetEnabled: config.TESLA_FLEET_ENABLED };
    }
    try {
      const token = await teslaAuth.getAccessToken();
      const base = config.TESLA_API_BASE_URL.replace(/\/$/, "");
      const response = await fetch(`${base}/api/1/vehicles`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        return reply
          .code(502)
          .send({
            connected: true,
            tokenValid: false,
            status: response.status,
          });
      }
      const body = (await response.json()) as {
        response?: Array<{ display_name?: string; state?: string }>;
      };
      const vehicles = (body.response ?? []).map((v) => ({
        name: v.display_name ?? "Tesla",
        state: v.state ?? "unknown",
      }));
      return {
        connected: true,
        tokenValid: true,
        fleetEnabled: config.TESLA_FLEET_ENABLED,
        vehicles,
      };
    } catch (error) {
      return reply
        .code(502)
        .send({
          connected: true,
          tokenValid: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  app.post("/auth/tesla/register-partner", async (request, reply) => {
    if (!requireAdmin(request, reply, config)) return reply;
    try {
      const token = await teslaAuth.getPartnerToken();
      const domain = new URL(config.API_BASE_URL).host;
      const response = await fetch(
        `${config.TESLA_API_BASE_URL.replace(/\/$/, "")}/api/1/partner_accounts`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ domain }),
        },
      );
      const body = await response.text();
      return reply
        .code(response.ok ? 200 : 502)
        .send({ ok: response.ok, status: response.status, body });
    } catch (error) {
      return reply
        .code(500)
        .send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  app.post("/auth/tesla/register-telemetry", async (request, reply) => {
    if (!requireAdmin(request, reply, config)) return reply;
    if (!config.TESLA_PUBLIC_KEY_PEM || !config.TESLA_TELEMETRY_CA_PEM) {
      return reply
        .code(400)
        .send({ ok: false, error: "TESLA_TELEMETRY_CA_PEM not configured." });
    }
    try {
      const result = await teslaAuth.registerTelemetryConfig({
        caPem: config.TESLA_TELEMETRY_CA_PEM,
        hostname: config.TESLA_TELEMETRY_HOST,
        port: config.TESLA_TELEMETRY_PORT,
      });
      return reply.code(result.ok ? 200 : 502).send(result);
    } catch (error) {
      return reply
        .code(500)
        .send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  app.delete("/auth/tesla/register-telemetry", async (request, reply) => {
    if (!requireAdmin(request, reply, config)) return reply;
    try {
      const result = await teslaAuth.deleteTelemetryConfig();
      return reply.code(result.ok ? 200 : 502).send(result);
    } catch (error) {
      return reply
        .code(500)
        .send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  // Diagnostic: confirm the virtual key is paired (key_paired_vins) + firmware/telemetry version.
  app.post("/auth/tesla/fleet-status", async (request, reply) => {
    if (!requireAdmin(request, reply, config)) return reply;
    try {
      const result = await teslaAuth.getFleetStatus();
      return reply.code(result.ok ? 200 : 502).send(result);
    } catch (error) {
      return reply
        .code(500)
        .send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  app.get("/auth/tidal/login", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    try {
      if (config.TIDAL_MOCK) {
        return reply.redirect(`${returnBase}/?tidal=mock`);
      }
      return reply.redirect(tidalAuth.createLoginUrl());
    } catch (error) {
      const message = encodeURIComponent(
        error instanceof Error ? error.message : String(error),
      );
      return reply.redirect(`${returnBase}/?tidal=error&message=${message}`);
    }
  });

  app.get("/auth/tidal/callback", async (request, reply) => {
    const returnBase = appBaseUrl(request, config);
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (query.error) {
      const message = encodeURIComponent(
        query.error_description ?? query.error,
      );
      return reply.redirect(`${returnBase}/?tidal=error&message=${message}`);
    }

    try {
      await tidalAuth.completeCallback(query);
    } catch (error) {
      const message = encodeURIComponent(
        error instanceof Error ? error.message : String(error),
      );
      return reply.redirect(`${returnBase}/?tidal=error&message=${message}`);
    }

    return reply.type("text/html").send(`<!doctype html>
      <html>
        <head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${returnBase}/?tidal=connected"></head>
        <body><a href="${returnBase}/?tidal=connected">Return to Longplay</a></body>
      </html>`);
  });

  app.post("/auth/tidal/disconnect", async () => {
    tidalAuth.disconnect();
    return { ok: true };
  });

  await registerJourneyRoutes(
    app,
    journeyService,
    store,
    tidalAuth,
    spotifyAuth,
    config,
    streamLiveness,
  );
  await registerTelemetryRoutes(app, config, journeyService, teslaLiveReader);

  // In production (or when WEB_DIST_DIR is set), the API also serves the built web SPA so the whole
  // app lives on one origin (no CORS; OAuth/Spotify same-origin; one domain for Tesla's public key).
  const webDist =
    process.env.WEB_DIST_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  const serveWeb = process.env.WEB_DIST_DIR
    ? existsSync(webDist)
    : config.NODE_ENV === "production" && existsSync(webDist);
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    const apiPrefixes = [
      "/health",
      "/auth",
      "/journeys",
      "/history",
      "/internal",
      "/telemetry",
      "/spotify",
      "/.well-known",
    ];
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?")[0];
      const isApi = apiPrefixes.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      if (request.method === "GET" && !isApi) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return { app, store, journeyService, teslaAuth, streamLiveness, teslaReadContext };
}
