import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord, TasteProfile } from "@longplay/core";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-taste-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

function makeJourney(overrides: Partial<JourneyRecord> = {}): JourneyRecord {
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
    ...overrides
  };
}

const profile: TasteProfile = {
  topGenres: ["electronica", "indie"],
  representativeArtists: ["Bonobo", "Tycho"]
};

describe("journey taste weight (store)", () => {
  it("persists and updates the per-journey taste weight", () => {
    const store = freshStore();
    store.createJourney(makeJourney({ tasteWeight: 0.4 }));
    expect(store.getJourney("journey-1")?.tasteWeight).toBeCloseTo(0.4);

    store.updateJourneyTasteWeight("journey-1", 0.75);
    expect(store.getJourney("journey-1")?.tasteWeight).toBeCloseTo(0.75);
  });
});

describe("taste profile cache (store)", () => {
  it("round-trips a cached taste profile and returns undefined when never cached", () => {
    const store = freshStore();
    expect(store.getCachedTasteProfile("local")).toBeUndefined();

    store.saveCachedTasteProfile("local", profile);
    expect(store.getCachedTasteProfile("local")).toEqual(profile);
  });
});
