import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { NormalizedTelemetryEvent } from "@longplay/core";
import {
  normalizeTeslaPayload,
  speedBucket,
  temperatureBucket,
} from "@longplay/telemetry";

import type { AppConfig } from "../config/env.js";
import type { JourneyService } from "../journeys/journeyService.js";
import type { TeslaLiveReader } from "./teslaFleetPoller.js";

const normalizedTelemetrySchema = z.object({
  timestampIso: z.string(),
  coarseRegion: z.string().optional(),
  countryName: z.string().optional(),
  countryCode: z.string().optional(),
  geoSource: z.enum(["reverse-geocode", "manual", "simulated"]).optional(),
  destination: z.string().optional(),
  etaMinutes: z.number().optional(),
  speedKph: z.number().optional(),
  outsideTempC: z.number().optional(),
  autopilotState: z.enum(["off", "available", "active", "unknown"]).optional(),
  batteryPercent: z.number().optional(),
});

export async function registerTelemetryRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: JourneyService,
  liveReader?: TeslaLiveReader,
): Promise<void> {
  // On-demand live snapshot for the start screen: triggers a fresh `vehicle_data` read *now* instead
  // of waiting for the next poll, so the destination/ETA/region can pre-fill the journey form. Returns
  // a privacy-safe, bucketed reading (no raw GPS, no VIN); degrades to `available: false` when the
  // car is asleep/offline, Tesla isn't connected, or the read times out.
  app.get("/telemetry/live", async () => {
    if (!liveReader?.available()) {
      return { available: false, reading: null };
    }
    const event = await liveReader.read();
    if (!event) {
      return { available: true, reading: null };
    }
    return {
      available: true,
      reading: {
        timestampIso: event.timestampIso,
        destination: event.destination,
        etaMinutes: event.etaMinutes,
        coarseRegion: event.coarseRegion,
        countryName: event.countryName,
        countryCode: event.countryCode,
        geoSource: event.geoSource,
        speedBucket: speedBucket(event.speedKph),
        temperatureBucket: temperatureBucket(event.outsideTempC),
        autopilotState: event.autopilotState,
        batteryPercent: event.batteryPercent,
      },
    };
  });

  app.post("/internal/telemetry", async (request, reply) => {
    const token = request.headers["x-simulator-token"];
    if (config.SIMULATOR_TOKEN && token !== config.SIMULATOR_TOKEN) {
      return reply.code(401).send({ error: "Invalid simulator token." });
    }

    const event = normalizedTelemetrySchema.parse(
      request.body,
    ) as NormalizedTelemetryEvent;
    await service.ingestTelemetry(event);
    return { ok: true };
  });

  app.post("/internal/tesla/raw", async (request, reply) => {
    const token = request.headers["x-simulator-token"];
    if (config.SIMULATOR_TOKEN && token !== config.SIMULATOR_TOKEN) {
      return reply.code(401).send({ error: "Invalid simulator token." });
    }

    const event = normalizeTeslaPayload(
      request.body as Record<string, unknown>,
      config.APP_SECRET,
    );
    await service.ingestTelemetry(event);
    return { ok: true };
  });
}
