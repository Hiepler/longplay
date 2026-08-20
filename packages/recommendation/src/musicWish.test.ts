import { describe, expect, it } from "vitest";

import type { MusicWish } from "@longplay/core";
import {
  applyMusicWishesToPolicy,
  candidatesFromMusicWishes,
  musicWishSummary,
  parseMusicWish,
  roleTagsForWish,
} from "./musicWish.js";
import { buildRecommendationPolicy } from "./index.js";

describe("parseMusicWish", () => {
  it("parses explicit immediate song wishes", () => {
    const wish = parseMusicWish("spiel jetzt Taylor Swift - Shake It Off");

    expect(wish.status).toBe("active");
    expect(wish.confidence).toBeGreaterThanOrEqual(0.8);
    expect(wish.intents).toEqual([
      { type: "song", artist: "Taylor Swift", title: "Shake It Off", immediate: true },
    ]);
    expect(musicWishSummary(wish.intents)).toBe("Play now Shake It Off");
  });

  it("parses non-immediate artist boosts", () => {
    const wish = parseMusicWish("mehr Taylor Swift");

    expect(wish.status).toBe("active");
    expect(wish.intents).toEqual([
      { type: "artist", artist: "Taylor Swift", strength: 0.9 },
    ]);
    expect(musicWishSummary(wish.intents)).toBe("More Taylor Swift");
  });

  it("treats a short bare artist name as a low-friction artist boost", () => {
    const wish = parseMusicWish("Nina Chuba");

    expect(wish.status).toBe("active");
    expect(wish.confidence).toBeGreaterThanOrEqual(0.75);
    expect(wish.intents).toEqual([
      { type: "artist", artist: "Nina Chuba", strength: 0.86 },
    ]);
    expect(musicWishSummary(wish.intents)).toBe("More Nina Chuba");
  });

  it("parses avoid wishes without interrupting playback", () => {
    const wish = parseMusicWish("nicht schon wieder Dua Lipa");

    expect(wish.status).toBe("active");
    expect(wish.intents).toEqual([
      { type: "avoid", artists: ["Dua Lipa"] },
    ]);
    expect(wish.intents.some((intent) => "immediate" in intent && intent.immediate)).toBe(false);
  });

  it("parses simple role wishes", () => {
    expect(parseMusicWish("was zum Mitsingen").intents).toEqual([
      { type: "role", role: "singalong", strength: 0.86 },
    ]);
    expect(parseMusicWish("mach alle wieder wach").intents).toEqual([
      { type: "role", role: "wake_up", strength: 0.86 },
    ]);
    expect(roleTagsForWish("singalong")).toEqual([
      "pop",
      "dance-pop",
      "feelgood",
      "karaoke",
    ]);
  });

  it("parses the English cockpit preset chips", () => {
    expect(parseMusicWish("Singalong").intents).toEqual([
      { type: "role", role: "singalong", strength: 0.86 },
    ]);
    expect(parseMusicWish("wake everyone up").intents).toEqual([
      { type: "role", role: "wake_up", strength: 0.86 },
    ]);
    expect(parseMusicWish("faster").intents).toEqual([
      { type: "tempo", direction: "faster", strength: 0.8 },
    ]);
    expect(parseMusicWish("More pop").intents).toEqual([
      { type: "mood", moodTags: ["pop"], strength: 0.82 },
    ]);
    expect(parseMusicWish("Less mellow").intents).toEqual([
      { type: "avoid", moodTags: ["mellow", "sleepy", "slow"] },
    ]);
    expect(parseMusicWish("Not so slow").intents).toEqual([
      { type: "avoid", moodTags: ["mellow", "sleepy", "slow"] },
    ]);
    expect(parseMusicWish("For the kids").intents).toEqual([
      { type: "role", role: "kids", strength: 0.86 },
    ]);
    expect(parseMusicWish("Play now feelgood").intents).toEqual([
      { type: "song", title: "feelgood", immediate: true },
    ]);
  });

  it("returns pending confirmation for ambiguous text", () => {
    const wish = parseMusicWish("irgendwie anders");

    expect(wish.status).toBe("pending_confirmation");
    expect(wish.confidence).toBeLessThan(0.65);
    expect(wish.intents).toEqual([]);
    expect(wish.summary).toBe("I'm not sure which music wish you mean.");
  });
});

describe("MusicWish shared type", () => {
  it("represents an active pinned wish with remaining tracks", () => {
    const wish: MusicWish = {
      id: "wish-1",
      journeyId: "journey-1",
      rawText: "mehr Taylor Swift",
      source: "text",
      intents: [{ type: "artist", artist: "Taylor Swift", strength: 0.9 }],
      status: "active",
      confidence: 0.82,
      summary: "More Taylor Swift",
      pinned: true,
      expiresAfterTracks: 5,
      remainingTracks: 5,
      createdAtIso: "2026-06-04T10:00:00.000Z",
      updatedAtIso: "2026-06-04T10:00:00.000Z",
    };

    expect(wish.intents[0]).toMatchObject({ type: "artist" });
    expect(wish.pinned).toBe(true);
  });
});

function activeWish(intents: MusicWish["intents"], overrides: Partial<MusicWish> = {}): MusicWish {
  return {
    id: "wish",
    journeyId: "journey",
    rawText: "wish",
    source: "text",
    intents,
    status: "active",
    confidence: 0.9,
    summary: "Wish",
    pinned: false,
    expiresAfterTracks: 5,
    remainingTracks: 5,
    createdAtIso: "2026-06-04T10:00:00.000Z",
    updatedAtIso: "2026-06-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("applyMusicWishesToPolicy", () => {
  it("adds artist boosts, avoids and role tags", () => {
    const policy = buildRecommendationPolicy({
      destination: "Lago di Garda",
      localTimeIso: "2026-06-04T10:00:00.000Z",
      speedBucket: "highway",
      phase: "cruise",
      userPrompt: "bright",
      passengerMode: "family",
    });

    const next = applyMusicWishesToPolicy(policy, [
      activeWish([{ type: "artist", artist: "Taylor Swift", strength: 0.9 }]),
      activeWish([{ type: "avoid", artists: ["Dua Lipa"], moodTags: ["mellow"] }]),
      activeWish([{ type: "role", role: "singalong", strength: 0.86 }]),
    ]);

    expect(next.artistBoosts).toEqual([{ artist: "Taylor Swift", strength: 0.9 }]);
    expect(next.avoidArtists).toContain("Dua Lipa");
    expect(next.avoidMoodTags).toContain("mellow");
    expect(next.moodTags).toEqual(expect.arrayContaining(["karaoke", "feelgood"]));
    expect(next.preferDistinctArtists).toBe(false);
  });

  it("creates direct candidates from song and artist wishes", () => {
    const candidates = candidatesFromMusicWishes([
      activeWish([{ type: "song", artist: "Taylor Swift", title: "Shake It Off", immediate: true }]),
      activeWish([{ type: "artist", artist: "Taylor Swift", strength: 0.9 }]),
    ]);

    expect(candidates).toEqual([
      expect.objectContaining({
        artist: "Taylor Swift",
        title: "Shake It Off",
        source: "music-wish",
        confidence: 0.96,
      }),
      expect.objectContaining({
        artist: "Taylor Swift",
        title: "Taylor Swift radio",
        source: "music-wish",
        confidence: 0.74,
      }),
    ]);
  });
});

describe("tempo intent", () => {
  it("parses faster/slower wishes", () => {
    expect(parseMusicWish("schneller").intents).toEqual([
      { type: "tempo", direction: "faster", strength: 0.8 },
    ]);
    expect(parseMusicWish("mehr tempo").intents).toEqual([
      { type: "tempo", direction: "faster", strength: 0.8 },
    ]);
    expect(parseMusicWish("langsamer").intents).toEqual([
      { type: "tempo", direction: "slower", strength: 0.8 },
    ]);
    // "ruhiger" bleibt die bestehende calm_down-Role:
    expect(parseMusicWish("ruhiger").intents).toEqual([
      { type: "role", role: "calm_down", strength: 0.86 },
    ]);
  });

  it("maps tempo onto policy mood tags", () => {
    const policy = buildRecommendationPolicy({
      destination: "X",
      localTimeIso: "2026-06-12T10:00:00.000Z",
      speedBucket: "highway",
      phase: "cruise",
      userPrompt: "",
      passengerMode: "solo",
    });
    const next = applyMusicWishesToPolicy(policy, [
      activeWish([{ type: "tempo", direction: "faster", strength: 0.8 }]),
    ]);
    expect(next.moodTags).toEqual(
      expect.arrayContaining(["uptempo", "high-energy"]),
    );
  });
});
