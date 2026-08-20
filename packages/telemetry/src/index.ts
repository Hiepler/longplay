import { createHash } from "node:crypto";

import type {
  ChargingState,
  JourneyPhase,
  NormalizedTelemetryEvent,
  SpeedBucket,
  TemperatureBucket,
} from "@longplay/core";

export function hashVehicleId(vehicleId: string, secret: string): string {
  return createHash("sha256")
    .update(`${secret}:${vehicleId}`)
    .digest("hex")
    .slice(0, 24);
}

export function speedBucket(speedKph?: number): SpeedBucket {
  if (typeof speedKph !== "number") return "unknown";
  if (speedKph < 3) return "parked";
  if (speedKph < 55) return "city";
  if (speedKph < 95) return "country";
  return "highway";
}

export function temperatureBucket(tempC?: number): TemperatureBucket {
  if (typeof tempC !== "number") return "unknown";
  if (tempC < 5) return "cold";
  if (tempC < 13) return "cool";
  if (tempC < 22) return "mild";
  if (tempC < 30) return "warm";
  return "hot";
}

export function derivePhase(
  event: NormalizedTelemetryEvent,
  previous?: JourneyPhase,
): JourneyPhase {
  if (typeof event.etaMinutes === "number" && event.etaMinutes <= 15)
    return "arrival";
  const hour = new Date(event.timestampIso).getHours();
  if (hour >= 17 && hour <= 20) return "golden_hour";
  if (event.autopilotState === "active") return "focus";
  if (previous === "departure" && event.etaMinutes && event.etaMinutes > 30)
    return "cruise";
  return previous ?? "departure";
}

export function normalizeTeslaPayload(
  payload: Record<string, unknown>,
  appSecret: string,
): NormalizedTelemetryEvent {
  const vehicleId = String(
    payload.vin ?? payload.vehicle_id ?? payload.VehicleId ?? "unknown",
  );
  // Tesla reports VehicleSpeed/drive_state.speed in MPH (per the Fleet field spec), not m/s.
  const speedMph = Number(payload.VehicleSpeed ?? payload.speed ?? Number.NaN);
  const speedKph = Number.isFinite(speedMph)
    ? Math.round(speedMph * 1.609)
    : undefined;
  const timestamp = String(
    payload.createdAt ?? payload.timestamp ?? new Date().toISOString(),
  );

  return {
    vehicleIdHash:
      vehicleId === "unknown" ? undefined : hashVehicleId(vehicleId, appSecret),
    timestampIso: timestamp,
    coarseRegion:
      typeof payload.coarseRegion === "string"
        ? payload.coarseRegion
        : undefined,
    countryName:
      typeof payload.countryName === "string" ? payload.countryName : undefined,
    countryCode:
      typeof payload.countryCode === "string" ? payload.countryCode : undefined,
    geoSource:
      typeof payload.geoSource === "string"
        ? (payload.geoSource as "reverse-geocode" | "manual" | "simulated")
        : undefined,
    destination:
      typeof payload.destination === "string" ? payload.destination : undefined,
    etaMinutes:
      typeof payload.etaMinutes === "number" ? payload.etaMinutes : undefined,
    speedKph,
    outsideTempC:
      typeof payload.OutsideTemp === "number" ? payload.OutsideTemp : undefined,
    autopilotState:
      payload.AutopilotState === "ACTIVE"
        ? "active"
        : payload.AutopilotState === "AVAILABLE"
          ? "available"
          : "unknown",
    batteryPercent: typeof payload.Soc === "number" ? payload.Soc : undefined,
  };
}

export interface FleetTelemetryResult extends NormalizedTelemetryEvent {
  /** Transient raw coordinates for server-side reverse-geocoding ONLY. Never stored or prompted. */
  coordinates?: { lat: number; lon: number };
}

function telemetryNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function telemetryBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

/**
 * Maps a raw vehicle charging-state string to our normalized enum. Handles both the REST
 * `charge_state.charging_state` form ("Charging", "Complete", …) and the streaming
 * "DetailedChargeState…"/"ChargeState…" forms via substring matching. Unknown/empty → undefined.
 */
function mapChargingState(value: unknown): ChargingState | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const s = value.toLowerCase();
  if (s.includes("charging") || s.includes("starting")) return "charging";
  if (s.includes("complete")) return "complete";
  if (s.includes("disconnect")) return "disconnected";
  if (s.includes("stop") || s.includes("nopower") || s.includes("no_power")) {
    return "stopped";
  }
  return "other";
}

/** Maps a Fleet API `vehicle_data` payload (drive/charge/climate state) into a normalized event. */
export function normalizeFleetVehicleData(
  payload: Record<string, any>,
  appSecret: string,
): FleetTelemetryResult {
  const drive = (payload?.drive_state ?? {}) as Record<string, any>;
  const charge = (payload?.charge_state ?? {}) as Record<string, any>;
  const climate = (payload?.climate_state ?? {}) as Record<string, any>;

  const speedMph = typeof drive.speed === "number" ? drive.speed : undefined;
  const speedKph =
    typeof speedMph === "number" ? Math.round(speedMph * 1.609) : undefined;

  const vin = typeof payload?.vin === "string" ? payload.vin : undefined;
  const ts =
    typeof drive.timestamp === "number"
      ? new Date(drive.timestamp).toISOString()
      : new Date().toISOString();

  const lat = typeof drive.latitude === "number" ? drive.latitude : undefined;
  const lon = typeof drive.longitude === "number" ? drive.longitude : undefined;
  const media = (payload?.media_info ?? {}) as Record<string, any>;

  return {
    vehicleIdHash: vin ? hashVehicleId(vin, appSecret) : undefined,
    timestampIso: ts,
    coarseRegion: undefined, // filled in by the poller via reverse-geocoding
    destination:
      typeof drive.active_route_destination === "string"
        ? drive.active_route_destination
        : undefined,
    etaMinutes:
      typeof drive.active_route_minutes_to_arrival === "number"
        ? Math.round(drive.active_route_minutes_to_arrival)
        : undefined,
    speedKph,
    outsideTempC:
      typeof climate.outside_temp === "number"
        ? climate.outside_temp
        : undefined,
    autopilotState: "unknown",
    batteryPercent:
      typeof charge.usable_battery_level === "number"
        ? charge.usable_battery_level
        : undefined,
    chargingState: mapChargingState(charge.charging_state),
    trafficDelayMinutes:
      typeof drive.active_route_traffic_minutes_delay === "number"
        ? Math.round(drive.active_route_traffic_minutes_delay)
        : undefined,
    energyPercentAtArrival:
      typeof drive.active_route_energy_at_arrival === "number"
        ? drive.active_route_energy_at_arrival
        : undefined,
    audioVolume:
      typeof media.audio_volume === "number" ? media.audio_volume : undefined,
    coordinates:
      typeof lat === "number" && typeof lon === "number"
        ? { lat, lon }
        : undefined,
  };
}

/**
 * Maps a Fleet *Telemetry* (streaming) payload into a normalized event. Field names differ from the
 * REST vehicle_data schema (e.g. VehicleSpeed in mph, Location object). Raw GPS is returned only as
 * transient `coordinates` for server-side geocoding — never stored or sent to the AI.
 */
export function normalizeFleetStream(
  payload: Record<string, any>,
  appSecret: string,
): FleetTelemetryResult {
  const vin = typeof payload?.vin === "string" ? payload.vin : undefined;
  const speedMph = telemetryNumber(payload?.VehicleSpeed);
  const speedKph =
    typeof speedMph === "number" ? Math.round(speedMph * 1.609) : undefined;
  const loc = (payload?.Location ?? {}) as Record<string, any>;
  const lat = telemetryNumber(loc.latitude);
  const lon = telemetryNumber(loc.longitude);
  const ts =
    typeof payload?.createdAt === "string"
      ? payload.createdAt
      : new Date().toISOString();
  const minutesToArrival = telemetryNumber(payload?.MinutesToArrival);
  const routeTrafficDelay = telemetryNumber(payload?.RouteTrafficMinutesDelay);
  const expectedEnergyAtArrival = telemetryNumber(
    payload?.ExpectedEnergyPercentAtTripArrival,
  );
  const longitudinalAcceleration = telemetryNumber(
    payload?.LongitudinalAcceleration,
  );

  return {
    vehicleIdHash: vin ? hashVehicleId(vin, appSecret) : undefined,
    timestampIso: ts,
    coarseRegion: undefined, // filled in by the consumer via reverse-geocoding
    destination:
      typeof payload?.DestinationName === "string"
        ? payload.DestinationName
        : undefined,
    etaMinutes:
      typeof minutesToArrival === "number"
        ? Math.round(minutesToArrival)
        : undefined,
    speedKph,
    outsideTempC: telemetryNumber(payload?.OutsideTemp),
    autopilotState: "unknown",
    batteryPercent: telemetryNumber(payload?.Soc),
    chargingState: mapChargingState(
      payload?.DetailedChargeState ?? payload?.ChargeState,
    ),
    trafficDelayMinutes:
      typeof routeTrafficDelay === "number"
        ? Math.round(routeTrafficDelay)
        : undefined,
    energyPercentAtArrival: expectedEnergyAtArrival,
    longitudinalAccelMps2: longitudinalAcceleration,
    brakePedal: telemetryBoolean(payload?.BrakePedal),
    hazardsActive: telemetryBoolean(payload?.LightsHazardsActive),
    coordinates:
      typeof lat === "number" && typeof lon === "number"
        ? { lat, lon }
        : undefined,
  };
}

export function simulatedTelemetry(
  step: number,
  destination = "Lago di Garda",
): NormalizedTelemetryEvent {
  const etaMinutes = Math.max(8, 140 - step * 7);
  return {
    timestampIso: new Date(Date.now() + step * 60_000).toISOString(),
    coarseRegion: step < 8 ? "Alps" : "Northern Italy",
    countryName: step < 8 ? "Austria" : "Italy",
    countryCode: step < 8 ? "AT" : "IT",
    geoSource: "simulated",
    destination,
    etaMinutes,
    speedKph: etaMinutes < 15 ? 48 : 112,
    outsideTempC: etaMinutes < 40 ? 24 : 18,
    autopilotState: etaMinutes < 20 ? "off" : "active",
    batteryPercent: Math.max(20, 82 - step),
  };
}
