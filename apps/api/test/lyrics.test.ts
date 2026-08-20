import { describe, expect, it } from "vitest";

import {
  fetchLyrics,
  normalizeForLyrics,
  parseLrc,
} from "../src/lyrics/lrclib.js";

describe("parseLrc", () => {
  it("parses timestamps into time-sorted millisecond lines", () => {
    const lines = parseLrc("[00:12.50]Hello\n[00:15.00]World\n[00:09.00]Intro");
    expect(lines).toEqual([
      { timeMs: 9_000, text: "Intro" },
      { timeMs: 12_500, text: "Hello" },
      { timeMs: 15_000, text: "World" },
    ]);
  });

  it("skips metadata/blank lines without a timestamp", () => {
    const lines = parseLrc("[ar:Artist]\n[00:01.00]One\n\nnot a line");
    expect(lines).toEqual([{ timeMs: 1_000, text: "One" }]);
  });

  it("strips enhanced-LRC per-word timing tags from the text", () => {
    const lines = parseLrc("[00:12.00]<00:12.00>Hello <00:12.50>world");
    expect(lines).toEqual([{ timeMs: 12_000, text: "Hello world" }]);
  });
});

describe("normalizeForLyrics", () => {
  it("strips featured-artist clauses from artist and title", () => {
    expect(normalizeForLyrics("Calvin Harris feat. Dua Lipa", "One Kiss")).toEqual({
      artist: "Calvin Harris",
      title: "One Kiss",
    });
    expect(normalizeForLyrics("Drake", "God's Plan (feat. Future)")).toEqual({
      artist: "Drake",
      title: "God's Plan",
    });
    expect(normalizeForLyrics("Eminem ft. Rihanna", "Love the Way You Lie")).toEqual({
      artist: "Eminem",
      title: "Love the Way You Lie",
    });
  });

  it("strips version/remaster/live suffixes from the title", () => {
    expect(normalizeForLyrics("Queen", "Bohemian Rhapsody - Remastered 2011").title).toBe(
      "Bohemian Rhapsody",
    );
    expect(normalizeForLyrics("Oasis", "Wonderwall - Live at Wembley").title).toBe(
      "Wonderwall",
    );
    expect(normalizeForLyrics("Miley Cyrus", "Flowers (Single Version)").title).toBe(
      "Flowers",
    );
    expect(normalizeForLyrics("ABBA", "Dancing Queen - Radio Edit").title).toBe(
      "Dancing Queen",
    );
  });

  it("leaves clean titles and real band names untouched (no false positives)", () => {
    expect(normalizeForLyrics("The Killers", "Mr. Brightside")).toEqual({
      artist: "The Killers",
      title: "Mr. Brightside",
    });
    // Ampersand/comma band names must NOT be split.
    expect(normalizeForLyrics("Simon & Garfunkel", "The Boxer").artist).toBe(
      "Simon & Garfunkel",
    );
    expect(normalizeForLyrics("Earth, Wind & Fire", "September").artist).toBe(
      "Earth, Wind & Fire",
    );
    // A meaningful parenthetical without a version keyword stays.
    expect(normalizeForLyrics("Glass Animals", "Heat Waves").title).toBe(
      "Heat Waves",
    );
  });
});

describe("fetchLyrics", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  it("sends an LRCLIB-compliant User-Agent and normalized query", async () => {
    let captured: { url: string; ua: string | null } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = {
        url: String(input),
        ua: new Headers(init?.headers).get("User-Agent"),
      };
      return jsonResponse([{ syncedLyrics: "[00:00.00]Hi", duration: 100 }]);
    };
    await fetchLyrics({
      artist: "Calvin Harris feat. Dua Lipa",
      title: "One Kiss - Radio Edit",
      fetchImpl,
    });
    expect(captured?.ua).toMatch(/Longplay\/\S+ \(\+https?:\/\//);
    expect(captured?.url).toContain("artist_name=Calvin%20Harris");
    expect(captured?.url).toContain("track_name=One%20Kiss");
    expect(captured?.url).not.toContain("feat");
    expect(captured?.url).not.toContain("Radio");
  });

  it("returns parsed synced lyrics with reason ok", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse([
        { plainLyrics: "plain only" },
        { syncedLyrics: "[00:02.00]Drive\n[00:04.00]On", plainLyrics: "Drive\nOn" },
      ]);
    const result = await fetchLyrics({ artist: "A", title: "B", fetchImpl });
    expect(result.reason).toBe("ok");
    expect(result.lyrics?.synced).toEqual([
      { timeMs: 2_000, text: "Drive" },
      { timeMs: 4_000, text: "On" },
    ]);
    expect(result.lyrics?.plain).toBe("Drive\nOn");
  });

  it("falls back to plain lyrics when no synced version exists", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse([{ plainLyrics: "just text" }]);
    const result = await fetchLyrics({ artist: "A", title: "B", fetchImpl });
    expect(result.reason).toBe("ok");
    expect(result.lyrics).toEqual({ plain: "just text" });
  });

  it("reports no-match on an empty result and lrclib-error on a non-2xx", async () => {
    const empty = await fetchLyrics({
      artist: "A",
      title: "B",
      fetchImpl: async () => jsonResponse([]),
    });
    expect(empty.reason).toBe("no-match");
    expect(empty.lyrics).toBeUndefined();

    const errored = await fetchLyrics({
      artist: "A",
      title: "B",
      fetchImpl: async () => new Response("", { status: 403 }),
    });
    expect(errored.reason).toBe("lrclib-error");
  });

  it("reports lrclib-error (never throws) when the request fails", async () => {
    const result = await fetchLyrics({
      artist: "A",
      title: "B",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result.reason).toBe("lrclib-error");
    expect(result.lyrics).toBeUndefined();
  });

  it("prefers the synced version whose duration matches the playing track", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse([
        { syncedLyrics: "[00:00.00]Live", duration: 320 },
        { syncedLyrics: "[00:00.00]Studio", duration: 201 },
      ]);
    const result = await fetchLyrics({ artist: "A", title: "B", durationSec: 203, fetchImpl });
    expect(result.lyrics?.synced).toEqual([{ timeMs: 0, text: "Studio" }]);
  });

  it("falls back to the first synced entry when no duration is within tolerance", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse([
        { syncedLyrics: "[00:00.00]First", duration: 100 },
        { syncedLyrics: "[00:00.00]Second", duration: 400 },
      ]);
    const result = await fetchLyrics({ artist: "A", title: "B", durationSec: 250, fetchImpl });
    expect(result.lyrics?.synced).toEqual([{ timeMs: 0, text: "First" }]);
  });

  it("reports bad-input and never calls the network without artist+title", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return jsonResponse([]);
    };
    const result = await fetchLyrics({ artist: "", title: "B", fetchImpl });
    expect(result.reason).toBe("bad-input");
    expect(called).toBe(false);
  });
});
