import mqtt from "mqtt";

import type { NormalizedTelemetryEvent } from "@longplay/core";
import { normalizeFleetStream } from "@longplay/telemetry";

import type { AppConfig } from "../config/env.js";
import type { JourneyService } from "../journeys/journeyService.js";
import { makeGeocodeResolver, type GeocodeResult } from "./geocoder.js";
import type { StreamLiveness } from "./streamSource.js";

export interface StreamMessageDeps {
  raw: Buffer | Uint8Array;
  topic?: string;
  topicBase?: string;
  state?: FleetMqttState;
  appSecret: string;
  geocode: (
    lat: number,
    lon: number,
  ) => Promise<string | GeocodeResult | undefined>;
  ingest: (event: NormalizedTelemetryEvent) => Promise<void>;
  live: StreamLiveness;
}

export class FleetMqttState {
  private readonly byVin = new Map<string, Record<string, unknown>>();

  mergeField(
    vin: string,
    field: string,
    value: unknown,
  ): Record<string, unknown> {
    const current = this.byVin.get(vin) ?? { vin };
    current.vin = vin;
    current[field] = value;
    current.createdAt = new Date().toISOString();
    this.byVin.set(vin, current);
    return { ...current };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function topicBase(topic: string): string {
  return topic.replace(/\/#$/, "").replace(/\/+$/, "");
}

function parseFleetMetricTopic(
  topic: string,
  base: string,
): { vin: string; field: string } | undefined {
  const normalizedTopic = topic.replace(/^\/+|\/+$/g, "");
  const normalizedBase = topicBase(base).replace(/^\/+|\/+$/g, "");
  if (!normalizedTopic.startsWith(`${normalizedBase}/`)) return undefined;

  const parts = normalizedTopic.slice(normalizedBase.length + 1).split("/");
  if (parts.length < 3 || parts[1] !== "v") return undefined;
  return { vin: parts[0], field: parts.slice(2).join("/") };
}

function messagePayload(
  deps: StreamMessageDeps,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(deps.raw).toString("utf8"));
  } catch {
    return undefined;
  }

  const base = deps.topicBase ? topicBase(deps.topicBase) : undefined;
  if (!deps.topic || !base || deps.topic.replace(/\/+$/, "") === base) {
    return isRecord(parsed) ? parsed : undefined;
  }

  const metric = parseFleetMetricTopic(deps.topic, base);
  if (!metric) return undefined;

  const state = deps.state ?? new FleetMqttState();
  return state.mergeField(metric.vin, metric.field, parsed);
}

/** Pure-ish handler for one streaming message. Best-effort: never throws on bad input. */
export async function handleStreamMessage(
  deps: StreamMessageDeps,
): Promise<void> {
  const payload = messagePayload(deps);
  if (!payload) return; // ignore malformed/non-vehicle messages

  const { coordinates, ...event } = normalizeFleetStream(
    payload,
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
  deps.live.mark(event.timestampIso);
  await deps.ingest(event);
}

export interface MqttConsumerHandle {
  stop: () => Promise<void>;
}

/** Subscribes to the fleet-telemetry MQTT topic and feeds the shared ingest pipeline. */
export function startMqttTelemetryConsumer(
  config: AppConfig,
  journeyService: JourneyService,
  live: StreamLiveness,
  logger: { warn: (obj: Record<string, unknown>, msg?: string) => void },
): MqttConsumerHandle | undefined {
  if (!config.TESLA_TELEMETRY_ENABLED) return undefined;
  const geocode = makeGeocodeResolver({ baseUrl: config.GEOCODER_URL });
  const base = topicBase(config.MQTT_TOPIC);
  const state = new FleetMqttState();
  const client = mqtt.connect(config.MQTT_URL, { reconnectPeriod: 5000 });

  client.on("connect", () => client.subscribe([base, `${base}/#`]));
  client.on("error", (err) => logger.warn({ err: err.message }, "mqtt.error"));
  client.on("message", (topic, raw) => {
    void handleStreamMessage({
      raw,
      topic,
      topicBase: base,
      state,
      appSecret: config.APP_SECRET,
      geocode,
      ingest: (event) => journeyService.ingestTelemetry(event),
      live,
    }).catch((error) =>
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "mqtt.ingest_error",
      ),
    );
  });

  return { stop: async () => void (await client.endAsync()) };
}
