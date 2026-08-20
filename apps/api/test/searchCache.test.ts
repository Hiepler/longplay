import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedTrack } from "@longplay/core";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { Store } from "../src/db/store.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-cache-"));
  tmpDirs.push(dir);
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return new Store(db);
}

const track: ResolvedTrack = {
  provider: "spotify",
  providerTrackId: "id1",
  providerUri: "spotify:track:id1",
  artist: "M83",
  title: "Wait",
  matchConfidence: 0.94,
  matchReason: "artist and title match"
};

describe("spotify search cache (store)", () => {
  it("round-trips a cached resolved track", () => {
    const store = freshStore();
    expect(store.getCachedSpotifySearch("DE:isrc:x")).toBeUndefined();

    store.saveCachedSpotifySearch("DE:isrc:x", track);
    expect(store.getCachedSpotifySearch("DE:isrc:x")).toMatchObject({ providerTrackId: "id1", artist: "M83" });
  });

  it("distinguishes a cached no-match (null) from an uncached key (undefined)", () => {
    const store = freshStore();
    store.saveCachedSpotifySearch("DE:foo - bar", null);
    expect(store.getCachedSpotifySearch("DE:foo - bar")).toBeNull();
    expect(store.getCachedSpotifySearch("DE:never - searched")).toBeUndefined();
  });
});
