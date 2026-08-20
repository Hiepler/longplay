import type { NormalizedTelemetryEvent } from "@longplay/core";
import { describe, expect, it } from "vitest";

import { assessDriveState, stabilizeDriveMode } from "./driveState.js";

function ev(overrides: Partial<NormalizedTelemetryEvent> = {}): NormalizedTelemetryEvent {
  return { timestampIso: "2026-06-01T14:00:00.000Z", ...overrides };
}

// A daytime + moderate-speed baseline so no rule fires unless we set its trigger.
const DAY = "2026-06-01T14:00:00.000Z";
const NIGHT = "2026-06-01T23:30:00.000Z";

describe("assessDriveState", () => {
  it("returns neutral with no telemetry", () => {
    expect(assessDriveState([], DAY)).toEqual({ mode: "neutral", reason: "", intensity: 0, signals: [] });
  });

  it("flags heavy traffic as calm, scaling intensity with delay", () => {
    const light = assessDriveState([ev({ trafficDelayMinutes: 8, speedKph: 20 })], DAY);
    const heavy = assessDriveState([ev({ trafficDelayMinutes: 30, speedKph: 5 })], DAY);
    expect(light.mode).toBe("calm");
    expect(light.reason).toBe("heavy traffic");
    expect(heavy.intensity).toBeGreaterThan(light.intensity);
    expect(heavy.signals[0]).toContain("30 min");
  });

  it("does not flag traffic below the threshold", () => {
    expect(assessDriveState([ev({ trafficDelayMinutes: 5, speedKph: 40 })], DAY).mode).toBe("neutral");
  });

  it("flags low predicted energy at arrival as calm (range anxiety)", () => {
    const a = assessDriveState([ev({ energyPercentAtArrival: 8, speedKph: 100 })], DAY);
    expect(a.mode).toBe("calm");
    expect(a.reason).toBe("low range");
    expect(a.signals[0]).toContain("8%");
  });

  it("falls back to raw battery for range anxiety when no route is set", () => {
    const a = assessDriveState([ev({ batteryPercent: 12, speedKph: 100 })], DAY);
    expect(a.mode).toBe("calm");
    expect(a.reason).toBe("low range");
  });

  it("does not flag a healthy battery", () => {
    expect(assessDriveState([ev({ batteryPercent: 60, speedKph: 100 })], DAY).mode).toBe("neutral");
  });

  it("flags wintry conditions as calm via the temperature proxy", () => {
    expect(assessDriveState([ev({ outsideTempC: -3, speedKph: 50 })], DAY).reason).toBe("wintry conditions");
  });

  it("flags a long night highway drive as focus", () => {
    const recent = [ev({ speedKph: 118, etaMinutes: 70 }), ev({ speedKph: 120, etaMinutes: 66 })];
    const a = assessDriveState(recent, NIGHT);
    expect(a.mode).toBe("focus");
    expect(a.reason).toBe("long night drive");
  });

  it("does not flag focus for the same drive during the day", () => {
    const recent = [ev({ speedKph: 118, etaMinutes: 70 }), ev({ speedKph: 120, etaMinutes: 66 })];
    expect(assessDriveState(recent, DAY).mode).toBe("neutral");
  });

  it("does not flag focus if pace is not steady", () => {
    const recent = [ev({ speedKph: 60, etaMinutes: 70 }), ev({ speedKph: 120, etaMinutes: 66 })];
    expect(assessDriveState(recent, NIGHT).mode).toBe("neutral");
  });

  it("prioritizes calm over focus when both could apply", () => {
    // Night highway (focus) BUT also heavy traffic (calm) → calm wins.
    const recent = [ev({ speedKph: 95, etaMinutes: 70, trafficDelayMinutes: 12 })];
    expect(assessDriveState(recent, NIGHT).mode).toBe("calm");
  });

  it("amplifies an active calm state when the driver lowers the volume", () => {
    const steady = assessDriveState(
      [ev({ trafficDelayMinutes: 10, audioVolume: 6 }), ev({ trafficDelayMinutes: 10, audioVolume: 6 })],
      DAY
    );
    const lowered = assessDriveState(
      [ev({ trafficDelayMinutes: 10, audioVolume: 6 }), ev({ trafficDelayMinutes: 10, audioVolume: 4 })],
      DAY
    );
    expect(lowered.intensity).toBeGreaterThan(steady.intensity);
    expect(lowered.signals).toContain("volume lowered");
  });
});

describe("assessDriveState — real-time streaming signals", () => {
  const DAY = "2026-06-01T14:00:00.000Z";

  it("flags a hard brake / hazards as a strong calm cue", () => {
    const hazard = assessDriveState([ev({ speedKph: 50, hazardsActive: true })], DAY);
    expect(hazard.mode).toBe("calm");
    expect(hazard.reason).toBe("sudden braking");

    const hardBrake = assessDriveState([ev({ speedKph: 50, longitudinalAccelMps2: -4 })], DAY);
    expect(hardBrake.mode).toBe("calm");
  });

  it("flags repeated brake cycles at low speed as stop-and-go calm", () => {
    const recent = [
      ev({ speedKph: 20, brakePedal: true }),
      ev({ speedKph: 8, brakePedal: false }),
      ev({ speedKph: 18, brakePedal: true })
    ];
    expect(assessDriveState(recent, DAY).mode).toBe("calm");
  });

  it("does not trigger on a single brake tap at speed", () => {
    expect(assessDriveState([ev({ speedKph: 100, brakePedal: true })], DAY).mode).toBe("neutral");
  });
});

describe("stabilizeDriveMode (hysteresis)", () => {
  it("keeps the engaged mode until a new mode holds for `hold` polls", () => {
    expect(stabilizeDriveMode("neutral", ["calm"], 2)).toBe("neutral"); // 1 poll → not yet
    expect(stabilizeDriveMode("neutral", ["calm", "calm"], 2)).toBe("calm"); // 2 polls → engage
  });

  it("does not disengage until the trigger is absent for `hold` polls", () => {
    expect(stabilizeDriveMode("calm", ["calm", "neutral"], 2)).toBe("calm"); // gone 1 poll → still calm
    expect(stabilizeDriveMode("calm", ["neutral", "neutral"], 2)).toBe("neutral"); // gone 2 polls → off
  });

  it("ignores a single-poll flap", () => {
    expect(stabilizeDriveMode("neutral", ["neutral", "calm"], 2)).toBe("neutral");
  });

  it("returns the engaged mode when history is shorter than the hold window", () => {
    expect(stabilizeDriveMode("focus", ["neutral"], 2)).toBe("focus");
  });
});
