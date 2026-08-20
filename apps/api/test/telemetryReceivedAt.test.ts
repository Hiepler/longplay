import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  JourneyRecord,
  NormalizedTelemetryEvent,
} from "@longplay/core";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { contextFromJourney, Store } from "../src/db/store.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-telemetry-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

function makeJourney(): JourneyRecord {
  return {
    id: "journey-1",
    provider: "spotify",
    destination: "Lago di Garda",
    userPrompt: "golden hour",
    passengerMode: "couple",
    phase: "departure",
    status: "active",
    tasteWeight: 0.4,
    createdAtIso: new Date().toISOString(),
  };
}

function event(
  overrides: Partial<NormalizedTelemetryEvent> = {},
): NormalizedTelemetryEvent {
  return {
    timestampIso: new Date().toISOString(),
    coarseRegion: "Northern Italy",
    destination: "Lago di Garda",
    etaMinutes: 60,
    speedKph: 110,
    outsideTempC: 22,
    autopilotState: "active",
    batteryPercent: 70,
    ...overrides,
  };
}

describe("telemetry received_at (store)", () => {
  it("returns undefined before any telemetry is ingested", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    expect(store.latestTelemetryReceivedAt("journey-1")).toBeUndefined();
  });

  it("stamps a server ingest time and returns the latest one", () => {
    const store = freshStore();
    store.createJourney(makeJourney());

    const before = Date.now();
    store.saveTelemetry("journey-1", event(), "cruise");
    const after = Date.now();

    const receivedAt = store.latestTelemetryReceivedAt("journey-1");
    expect(receivedAt).toBeDefined();
    const ms = Date.parse(receivedAt!);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it("reflects the most recent snapshot's ingest time", () => {
    const store = freshStore();
    store.createJourney(makeJourney());

    // Older vehicle timestamp first, newer second — latest-by-timestamp wins.
    store.saveTelemetry(
      "journey-1",
      event({ timestampIso: "2026-06-01T10:00:00.000Z" }),
      "cruise",
    );
    store.saveTelemetry(
      "journey-1",
      event({ timestampIso: "2026-06-01T11:00:00.000Z" }),
      "golden_hour",
    );

    const receivedAt = store.latestTelemetryReceivedAt("journey-1");
    // Both stamped at ingest time (now), so it must parse as a valid recent ISO string.
    expect(receivedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(receivedAt!))).toBe(false);
  });

  it("round-trips speed and temperature context for later journey analysis", () => {
    const store = freshStore();
    const journey = makeJourney();
    store.createJourney(journey);

    store.saveTelemetry(
      "journey-1",
      event({
        timestampIso: "2026-06-01T18:30:00.000Z",
        coarseRegion: "Bavaria, Germany",
        countryName: "Germany",
        countryCode: "DE",
        geoSource: "reverse-geocode",
        speedKph: 118,
        outsideTempC: 27,
        etaMinutes: 42,
      }),
      "golden_hour",
    );

    const telemetry = store.latestTelemetry("journey-1");
    expect(telemetry).toMatchObject({
      speedKph: 118,
      outsideTempC: 27,
      etaMinutes: 42,
      countryName: "Germany",
      countryCode: "DE",
    });

    const context = contextFromJourney(
      { ...journey, phase: "golden_hour" },
      telemetry,
    );
    expect(context.speedBucket).toBe("highway");
    expect(context.temperatureBucket).toBe("warm");
    expect(context.countryName).toBe("Germany");
  });

  it("round-trips real-time streaming drive signals", () => {
    const store = freshStore();
    store.createJourney(makeJourney());

    store.saveTelemetry(
      "journey-1",
      event({
        longitudinalAccelMps2: -4.2,
        brakePedal: false,
        hazardsActive: true,
      }),
      "cruise",
    );

    expect(store.latestTelemetry("journey-1")).toMatchObject({
      longitudinalAccelMps2: -4.2,
      brakePedal: false,
      hazardsActive: true,
    });
  });

  it("derives privacy-safe drive trends from recent telemetry snapshots", () => {
    const journey = makeJourney();
    const history = [
      event({
        timestampIso: "2026-06-01T18:00:00.000Z",
        speedKph: 42,
        etaMinutes: 55,
      }),
      event({
        timestampIso: "2026-06-01T18:03:00.000Z",
        speedKph: 68,
        etaMinutes: 48,
      }),
      event({
        timestampIso: "2026-06-01T18:06:00.000Z",
        speedKph: 103,
        etaMinutes: 40,
        autopilotState: "active",
      }),
    ];

    const context = contextFromJourney(journey, history[2], history);

    expect(context.paceTrend).toBe("accelerating");
    expect(context.etaTrend).toBe("approaching");
    expect(context.autopilotState).toBe("active");
  });

  it("contextFromJourney carries the telemetry source", () => {
    const journey = makeJourney();
    const ctx = contextFromJourney(journey, undefined, [], "streaming");
    expect(ctx.telemetrySource).toBe("streaming");
  });

  it("exposes the final destination and tracks the current nav target across legs", () => {
    const store = freshStore();
    store.createJourney(makeJourney()); // destination: "Lago di Garda"

    const ctx0 = contextFromJourney(store.getJourney("journey-1")!);
    expect(ctx0.finalDestination).toBe("Lago di Garda");

    // A charge stop: the car now navigates to a Supercharger.
    store.updateJourneyCurrentDestination("journey-1", "Supercharger Kassel");
    const updated = store.getJourney("journey-1")!;
    expect(updated.currentDestination).toBe("Supercharger Kassel");
    // The final destination stays the seeded one (not overwritten).
    expect(updated.destination).toBe("Lago di Garda");
    expect(contextFromJourney(updated).finalDestination).toBe("Lago di Garda");
  });

  it("round-trips the normalized charging state", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    store.saveTelemetry(
      "journey-1",
      event({ batteryPercent: 41, chargingState: "charging" }),
      "cruise",
    );
    expect(store.latestTelemetry("journey-1")).toMatchObject({
      chargingState: "charging",
    });
  });

  it("persists a leg start and derives leg-local elapsed minutes", () => {
    const store = freshStore();
    const journey = {
      ...makeJourney(),
      createdAtIso: new Date(Date.now() - 60 * 60_000).toISOString(),
    };
    store.createJourney(journey);

    // Leg 0: no leg start yet → leg-elapsed mirrors whole-journey elapsed (~60 min).
    const leg0 = contextFromJourney(store.getJourney("journey-1")!);
    expect(leg0.legElapsedMinutes).toBeGreaterThan(55);

    // A charge stop stamps a fresh leg start ~2 min ago.
    store.updateJourneyLegIndex(
      "journey-1",
      1,
      new Date(Date.now() - 2 * 60_000).toISOString(),
    );
    const leg1 = contextFromJourney(store.getJourney("journey-1")!);
    expect(leg1.legIndex).toBe(1);
    expect(leg1.legElapsedMinutes).toBeLessThan(5);
    // Whole-journey elapsed keeps counting from journey start.
    expect(leg1.elapsedMinutes).toBeGreaterThan(55);
  });
});
