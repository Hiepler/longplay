import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeText } from "@longplay/core";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig(sharedDbDir?: string) {
  const dir = sharedDbDir ?? mkdtempSync(join(tmpdir(), "ai-journey-dj-variety-"));
  if (!sharedDbDir) tmpDirs.push(dir);
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173",
  });
}

async function waitForAnalysis(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  journeyId: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = (
      await app.inject({ method: "GET", url: `/journeys/${journeyId}` })
    ).json();
    if (!detail.analysisPending) return detail;
    if (Date.now() > deadline) throw new Error("analysis did not finish in time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startJourney(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  destination: string,
) {
  const journey = (
    await app.inject({
      method: "POST",
      url: "/journeys",
      payload: {
        destination,
        userPrompt: "bright road trip",
        passengerMode: "family",
        provider: "spotify",
        deviceId: "mock-webplayer",
      },
    })
  ).json<{ id: string }>();
  const detail = (await app.inject({ method: "GET", url: `/journeys/${journey.id}` })).json();
  const queued: string[] = detail.playbackSession.queuedTrackIds.map((id: string) => {
    const t = detail.tracks.find((track: { id: string }) => track.id === id);
    return `${t.artist}::${t.title}`;
  });
  return { id: journey.id, queued };
}

describe("engine variety", () => {
  it("two journeys with the same mood produce different queues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-variety-shared-"));
    tmpDirs.push(dir);
    const { app } = await buildApp(testConfig(dir));

    const a = await startJourney(app, "Lago di Garda");
    const b = await startJourney(app, "Lago di Garda");

    // Two journeys must never deliver the identical sequence. Order-level variety
    // (seeded jitter, deterministic per journey) is the reliable end-to-end guarantee
    // here; in mock mode there is no Last.fm catalog, so set-level diversity (chart-window
    // rotation + cross-journey fatigue against a real catalog) is covered by the unit
    // tests for those layers, not by this tiny deterministic mock pool.
    expect(a.queued).not.toEqual(b.queued);

    await app.close();
  });

  it("records over-played artists in the cross-journey ban ledger", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-ban-"));
    tmpDirs.push(dir);
    const { app, store } = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        DATABASE_PATH: join(dir, "test.db"),
        APP_SECRET: "a-long-test-secret-value",
        TIDAL_MOCK: "true",
        SPOTIFY_MOCK: "true",
        XAI_MOCK: "true",
        CORS_ORIGIN: "http://localhost:5173",
        ARTIST_BAN_PLAYS: "1",
      }),
    );

    const a = await startJourney(app, "Lago di Garda");
    const artistsA = a.queued.map((k) => normalizeText(k.split("::")[0]));
    expect(artistsA.length).toBeGreaterThan(0);

    // Assert the ban MECHANISM, not emergent queue variety: the cross-journey ledger that
    // drives the hard artist ban must record journey A's surfaced artists, so the next
    // journey would exclude them. (The tiny mock catalog legitimately relaxes the ban —
    // "music before doctrine" — so asserting that B differs from A is non-deterministic.)
    const counts = store.artistPlayCounts(168 * 60 * 60 * 1000);
    for (const artist of artistsA) {
      expect(counts.get(artist) ?? 0).toBeGreaterThanOrEqual(1);
    }
    const banned = new Set(
      [...counts.entries()]
        .filter(([, count]) => count >= 1)
        .map(([artist]) => artist),
    );
    expect(artistsA.every((artist) => banned.has(artist))).toBe(true);

    await app.close();
  });

  it("guarantees at least the wish quota of artist tracks in the next queue", { timeout: 30_000 }, async () => {
    const { app } = await buildApp(testConfig());
    const journey = (
      await app.inject({
        method: "POST",
        url: "/journeys",
        payload: {
          destination: "Dijon",
          userPrompt: "drive",
          passengerMode: "solo",
          provider: "spotify",
          deviceId: "mock-webplayer",
        },
      })
    ).json<{ id: string }>();

    await app.inject({
      method: "POST",
      url: `/journeys/${journey.id}/music-wishes`,
      payload: { text: "mehr Taylor Swift", source: "text" },
    });

    const detail = await waitForAnalysis(app, journey.id);
    const queued = detail.playbackSession.queuedTrackIds.map((id: string) =>
      detail.tracks.find((track: { id: string }) => track.id === id),
    );
    const taylorCount = queued.filter(
      (track: { artist: string } | undefined) => track?.artist === "Taylor Swift",
    ).length;
    expect(taylorCount).toBeGreaterThanOrEqual(2);

    await app.close();
  });
});
