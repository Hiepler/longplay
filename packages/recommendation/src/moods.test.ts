import { describe, expect, it } from "vitest";
import type { JourneyContext } from "@longplay/core";

import { MOODS, resolveMood } from "./moods";
import type { TripArc } from "./context-signals.js";

function ctx(overrides: Partial<JourneyContext> = {}): JourneyContext {
  return {
    destination: "Lake",
    localTimeIso: "2026-06-04T02:00:00",
    speedBucket: "highway",
    phase: "cruise",
    userPrompt: "road trip",
    passengerMode: "solo",
    ...overrides,
  } as JourneyContext;
}

const arc = (segment: TripArc["segment"], longHaul = false): TripArc => ({
  progress: 0.5,
  segment,
  longHaul,
  effectiveTotalMin: 120,
});

describe("MOODS taxonomy", () => {
  it("every mood has a non-empty tag list and an ordered energy band", () => {
    for (const mood of Object.values(MOODS)) {
      expect(mood.lastfmTags.length).toBeGreaterThan(0);
      expect(mood.energy[0]).toBeLessThanOrEqual(mood.energy[1]);
    }
  });
});

describe("resolveMood", () => {
  it("night driving resolves to night_cruise", () => {
    const r = resolveMood(ctx(), { band: "night", arc: arc("body") });
    expect(r.primary).toBe("night_cruise");
  });

  it("dawn resolves to dawn_lift", () => {
    const r = resolveMood(ctx(), { band: "dawn", arc: arc("body") });
    expect(r.primary).toBe("dawn_lift");
  });

  it("golden hour resolves to golden_cinematic", () => {
    const r = resolveMood(ctx(), { band: "golden", arc: arc("body") });
    expect(r.primary).toBe("golden_cinematic");
  });

  it("family overrides the time band", () => {
    const r = resolveMood(ctx({ passengerMode: "family" }), {
      band: "night",
      arc: arc("body"),
    });
    expect(r.primary).toBe("family_singalong");
  });

  it("closing segment winds down (non-family, non-focus)", () => {
    const r = resolveMood(ctx(), { band: "midday", arc: arc("closing") });
    expect(r.primary).toBe("wind_down");
  });

  it("calm drive mode adds a wind_down secondary", () => {
    const r = resolveMood(
      ctx({ driveState: { mode: "calm", reason: "calm", intensity: 0.5, signals: [] } }),
      { band: "morning", arc: arc("body") },
    );
    expect(r.secondary).toBe("wind_down");
  });

  it("euphoric prompt blends bright_day as secondary", () => {
    const r = resolveMood(ctx({ userPrompt: "euphoric uplifting vibes" }), {
      band: "afternoon",
      arc: arc("body"),
    });
    expect(r.secondary).toBe("bright_day");
  });

  it("closing segment under focus drive mode lifts to open_road instead of winding down", () => {
    const r = resolveMood(
      ctx({ driveState: { mode: "focus", reason: "long drive", intensity: 0.5, signals: [] } }),
      { band: "midday", arc: arc("closing") },
    );
    expect(r.primary).toBe("open_road");
  });
});
