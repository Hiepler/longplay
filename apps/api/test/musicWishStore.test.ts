import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JourneyRecord, MusicWish } from "@longplay/core";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-wishes-"));
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
    userPrompt: "bright road trip",
    passengerMode: "family",
    phase: "departure",
    status: "active",
    createdAtIso: new Date().toISOString(),
  };
}

function makeWish(overrides: Partial<MusicWish> = {}): MusicWish {
  return {
    id: "wish-1",
    journeyId: "journey-1",
    rawText: "mehr Taylor Swift",
    source: "text",
    intents: [{ type: "artist", artist: "Taylor Swift", strength: 0.9 }],
    status: "active",
    confidence: 0.82,
    summary: "Mehr Taylor Swift",
    pinned: false,
    expiresAfterTracks: 5,
    remainingTracks: 5,
    createdAtIso: "2026-06-04T10:00:00.000Z",
    updatedAtIso: "2026-06-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("music wish store", () => {
  it("creates and lists active wishes newest first", () => {
    const store = freshStore();
    store.createJourney(makeJourney());

    store.saveMusicWish(makeWish({ id: "wish-old", rawText: "mehr Pop", summary: "Mehr Pop", createdAtIso: "2026-06-04T09:00:00.000Z", updatedAtIso: "2026-06-04T09:00:00.000Z" }));
    store.saveMusicWish(makeWish({ id: "wish-new", rawText: "mehr Taylor Swift", summary: "Mehr Taylor Swift" }));

    const active = store.listActiveMusicWishes("journey-1");
    expect(active.map((wish) => wish.id)).toEqual(["wish-new", "wish-old"]);
    expect(active[0].intents).toEqual([{ type: "artist", artist: "Taylor Swift", strength: 0.9 }]);
  });

  it("pins, expires and undoes wishes", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    store.saveMusicWish(makeWish());

    store.updateMusicWish("journey-1", "wish-1", { pinned: true });
    expect(store.listActiveMusicWishes("journey-1")[0].pinned).toBe(true);

    store.updateMusicWish("journey-1", "wish-1", { status: "undone" });
    expect(store.listActiveMusicWishes("journey-1")).toEqual([]);
    expect(store.listRecentMusicWishes("journey-1")[0]).toMatchObject({ status: "undone" });
  });

  it("decays non-pinned wishes and expires them at zero", () => {
    const store = freshStore();
    store.createJourney(makeJourney());
    store.saveMusicWish(makeWish({ remainingTracks: 1 }));
    store.saveMusicWish(makeWish({ id: "pinned", pinned: true, remainingTracks: 1 }));

    store.decayActiveMusicWishes("journey-1", 1);

    expect(store.getMusicWish("journey-1", "wish-1")?.status).toBe("expired");
    expect(store.getMusicWish("journey-1", "pinned")?.status).toBe("active");
    expect(store.getMusicWish("journey-1", "pinned")?.remainingTracks).toBe(1);
  });
});
