import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeText, songKey } from "@longplay/core";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-recent-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

describe("recent plays store", () => {
  it("records and lists recently surfaced tracks within a window", () => {
    const store = freshStore();
    const now = Date.parse("2026-06-04T10:00:00.000Z");

    store.recordRecentPlays(
      "journey-1",
      [
        { artist: "Taylor Swift", title: "Shake It Off" },
        { artist: "Dua Lipa", title: "Levitating" },
      ],
      new Date(now - 60 * 60 * 1000).toISOString(), // 1h ago
    );
    store.recordRecentPlays(
      "journey-1",
      [{ artist: "Old Artist", title: "Old Song" }],
      new Date(now - 100 * 60 * 60 * 1000).toISOString(), // 100h ago
    );

    const recent = store.listRecentlyPlayed(72 * 60 * 60 * 1000, now);
    const keys = recent.map((r) => r.songKey);
    expect(keys).toContain(songKey("Taylor Swift", "Shake It Off"));
    expect(keys).toContain(songKey("Dua Lipa", "Levitating"));
    expect(keys).not.toContain(songKey("Old Artist", "Old Song")); // outside window
    expect(recent.every((r) => r.ageMs >= 0)).toBe(true);
  });

  it("counts artist appearances inside the window for the ban ledger", () => {
    const store = freshStore();
    const now = Date.parse("2026-06-12T10:00:00.000Z");
    store.recordRecentPlays(
      "j1",
      [
        { artist: "Repeat Artist", title: "Song A" },
        { artist: "Repeat Artist", title: "Song B" },
        { artist: "Fresh Artist", title: "Song C" },
      ],
      new Date(now - 60 * 60 * 1000).toISOString(),
    );
    store.recordRecentPlays(
      "j2",
      [{ artist: "Repeat Artist", title: "Song D" }],
      new Date(now - 200 * 60 * 60 * 1000).toISOString(), // außerhalb 168h
    );

    const counts = store.artistPlayCounts(168 * 60 * 60 * 1000, now);
    expect(counts.get(normalizeText("Repeat Artist"))).toBe(2);
    expect(counts.get(normalizeText("Fresh Artist"))).toBe(1);
  });

  it("prunes rows older than the 30-day hard cap on record", () => {
    const store = freshStore();
    const now = Date.parse("2026-06-04T10:00:00.000Z");
    store.recordRecentPlays(
      "j",
      [{ artist: "A", title: "A" }],
      new Date(now - 1000 * 60 * 60 * 1000).toISOString(), // ~41 days ago
    );
    store.recordRecentPlays(
      "j",
      [{ artist: "B", title: "B" }],
      new Date(now).toISOString(),
    );
    const all = store.listRecentlyPlayed(365 * 24 * 60 * 60 * 1000, now);
    const artists = all.map((r) => r.artist);
    expect(artists).toContain("B");
    expect(artists).not.toContain("A"); // pruned by the 30-day cap
  });
});
