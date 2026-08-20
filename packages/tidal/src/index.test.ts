import { describe, expect, it } from "vitest";

import type { SongCandidate } from "@longplay/core";

import { MockTidalAdapter, TidalResolver, bestMatch, isMockTidalPlaylistId } from "./index.js";

describe("tidal resolver", () => {
  it("prefers exact artist and title matches", () => {
    const candidate: SongCandidate = {
      artist: "M83",
      title: "Wait",
      reason: "cinematic",
      source: "grok",
      confidence: 0.8
    };

    const match = bestMatch(candidate, [
      { id: "1", artist: "Other", title: "Wait" },
      { id: "2", artist: "M83", title: "Wait" }
    ]);

    expect(match?.track.id).toBe("2");
    expect(match?.confidence).toBeGreaterThan(0.9);
  });

  it("creates mock playlists without a TIDAL URL", async () => {
    const adapter = new MockTidalAdapter();
    const playlist = await adapter.createPlaylist({
      accessToken: "mock",
      name: "Test",
      description: "Test",
      countryCode: "DE",
      idempotencyKey: "test"
    });

    expect(playlist.id).toMatch(/^mock-/);
    expect(playlist.url).toBeUndefined();
    expect(isMockTidalPlaylistId(playlist.id)).toBe(true);
  });

  it("resolves mock candidates to TIDAL tracks", async () => {
    const resolver = new TidalResolver(new MockTidalAdapter(), {
      accessToken: "mock",
      countryCode: "DE"
    });

    const tracks = await resolver.resolveCandidates([
      {
        artist: "Tycho",
        title: "A Walk",
        reason: "focus",
        source: "grok",
        confidence: 0.8
      }
    ]);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.providerTrackId).toContain("mock-track");
  });
});
