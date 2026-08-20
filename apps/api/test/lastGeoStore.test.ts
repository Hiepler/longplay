import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord } from "@longplay/core";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { Store, contextFromJourney } from "../src/db/store.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-geo-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

function makeJourney(overrides: Partial<JourneyRecord> = {}): JourneyRecord {
  return {
    id: "journey-1",
    provider: "spotify",
    destination: "Montpellier",
    userPrompt: "feel-good",
    passengerMode: "couple",
    phase: "departure",
    status: "active",
    createdAtIso: new Date().toISOString(),
    ...overrides,
  };
}

describe("last-known geo fallback", () => {
  it("layers sources by confidence: destination seed < browser-gps < live GPS", () => {
    const store = freshStore();
    store.createJourney(makeJourney());

    // Destination seed fills the empty slot.
    store.setLastGeo("journey-1", {
      countryName: "France",
      countryCode: "FR",
      coarseRegion: "Occitanie, France",
      source: "destination",
    });
    expect(store.getJourney("journey-1")?.lastGeo?.source).toBe("destination");

    // Browser GPS (higher confidence) replaces the destination seed.
    store.setLastGeo("journey-1", {
      countryName: "France",
      countryCode: "FR",
      coarseRegion: "Montpellier, France",
      source: "browser-gps",
    });
    expect(store.getJourney("journey-1")?.lastGeo?.coarseRegion).toBe("Montpellier, France");
    expect(store.getJourney("journey-1")?.lastGeo?.source).toBe("browser-gps");

    // A real GPS fix always wins.
    store.setLastGeo("journey-1", {
      countryName: "Spain",
      countryCode: "ES",
      coarseRegion: "Catalonia, Spain",
      source: "reverse-geocode",
    });
    expect(store.getJourney("journey-1")?.lastGeo?.countryCode).toBe("ES");

    // A lower-confidence source does NOT overwrite a fresh higher-confidence fix.
    store.setLastGeo("journey-1", {
      countryName: "France",
      countryCode: "FR",
      source: "destination",
    });
    expect(store.getJourney("journey-1")?.lastGeo?.countryCode).toBe("ES");
  });

  it("a manual override sticks within the same country but yields when the driver moves", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    store.setLastGeo("journey-1", {
      countryName: "France",
      countryCode: "FR",
      coarseRegion: "Marseille, France",
      source: "manual",
    });

    // Same-country GPS fix must NOT override the manual correction (it may only refine, not replace).
    store.setLastGeo("journey-1", {
      countryName: "France",
      countryCode: "FR",
      coarseRegion: "Lyon, France",
      source: "reverse-geocode",
    });
    expect(store.getJourney("journey-1")?.lastGeo?.coarseRegion).toBe("Marseille, France");
    expect(store.getJourney("journey-1")?.lastGeo?.source).toBe("manual");

    // Crossing into a different country: the live fix wins (manual is stale, the driver moved).
    store.setLastGeo("journey-1", {
      countryName: "Spain",
      countryCode: "ES",
      coarseRegion: "Catalonia, Spain",
      source: "reverse-geocode",
    });
    expect(store.getJourney("journey-1")?.lastGeo?.countryCode).toBe("ES");
    expect(store.getJourney("journey-1")?.lastGeo?.source).toBe("reverse-geocode");
  });

  it("clearLastGeo resets the override back to auto", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    store.setLastGeo("journey-1", { countryName: "France", countryCode: "FR", source: "manual" });
    store.clearLastGeo("journey-1");
    expect(store.getJourney("journey-1")?.lastGeo).toBeUndefined();
  });

  it("a manual override wins over live telemetry in the context", () => {
    const journey = makeJourney({
      lastGeo: {
        countryName: "France",
        countryCode: "FR",
        coarseRegion: "Occitanie, France",
        source: "manual",
      },
    });
    const context = contextFromJourney(
      journey,
      {
        timestampIso: new Date().toISOString(),
        countryName: "Germany",
        countryCode: "DE",
        coarseRegion: "Bavaria, Germany",
        geoSource: "reverse-geocode",
      } as never,
      [],
    );
    expect(context.countryName).toBe("France");
    expect(context.geoSource).toBe("manual");
  });

  it("contextFromJourney falls back to last-known geo when no telemetry geo exists", () => {
    const journey = makeJourney({
      lastGeo: {
        countryName: "France",
        countryCode: "FR",
        coarseRegion: "Occitanie, France",
        source: "destination",
      },
    });
    const context = contextFromJourney(journey, undefined, []);
    expect(context.countryName).toBe("France");
    expect(context.countryCode).toBe("FR");
    expect(context.geoSource).toBe("destination");
  });

  it("live telemetry geo takes precedence over the last-known fallback", () => {
    const journey = makeJourney({
      lastGeo: { countryName: "France", countryCode: "FR", source: "destination" },
    });
    const context = contextFromJourney(
      journey,
      {
        timestampIso: new Date().toISOString(),
        countryName: "Italy",
        countryCode: "IT",
        coarseRegion: "Lombardy, Italy",
        geoSource: "reverse-geocode",
      } as never,
      [],
    );
    expect(context.countryName).toBe("Italy");
    expect(context.geoSource).toBe("reverse-geocode");
  });
});
