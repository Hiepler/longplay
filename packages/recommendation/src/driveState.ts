import type { DriveMode, DriveStateAssessment, NormalizedTelemetryEvent } from "@longplay/core";

/**
 * Deterministic, zero-token drive-state classifier for the Adaptive Drive Mode.
 *
 * Comfort feature — NOT a safety or driver-assistance system. It only biases music *selection*
 * toward calmer/more-engaging tracks for the situation; it never controls volume, DSP, or the car.
 *
 * Pure of I/O so it is fully unit-testable, mirroring the Musical Brief philosophy.
 */

// Thresholds (see spec). Tuned to be conservative and honest about what telemetry can tell us.
const TRAFFIC_DELAY_CALM_MIN = 8; // minutes of route delay → "heavy traffic"
const ENERGY_AT_ARRIVAL_LOW = 10; // % battery predicted at destination → range anxiety
const BATTERY_LOW = 15; // % battery (fallback when no route is set)
const COLD_C = 0; // outside °C → wintry proxy (weak, labeled honestly)
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 5;
const FOCUS_MIN_SPEED_KPH = 90;
const FOCUS_MIN_ETA_MIN = 45;
const PACE_STEADY_DELTA = 12; // |Δ km/h| within this → steady (mirrors the trend derivation)
const VOLUME_DROP_STEP = 1; // audioVolume units a user must drop to count as a calm cue
const VOLUME_AMPLIFY = 0.15;
const HARD_BRAKE_MPS2 = -3.5; // strong deceleration → sudden braking
const STOPGO_SPEED_KPH = 35; // brake cycles below this = stop-and-go
const STOPGO_MIN_BRAKE_EVENTS = 2; // brake presses within the recent window

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isNight(localTimeIso: string): boolean {
  const hour = new Date(localTimeIso).getHours();
  if (Number.isNaN(hour)) return false;
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/** Steady when the last two known speeds differ by less than the trend threshold. */
function paceIsSteady(recent: NormalizedTelemetryEvent[]): boolean {
  const speeds = recent.map((event) => event.speedKph).filter((s): s is number => typeof s === "number");
  if (speeds.length < 2) return false;
  const [prev, last] = speeds.slice(-2);
  return Math.abs(last - prev) <= PACE_STEADY_DELTA;
}

/** If the driver lowered the cabin volume between the last two readings, reinforce an active calm state. */
function applyVolumeAmplifier(intensity: number, recent: NormalizedTelemetryEvent[], signals: string[]): number {
  const volumes = recent.map((event) => event.audioVolume).filter((v): v is number => typeof v === "number");
  if (volumes.length >= 2) {
    const [prev, last] = volumes.slice(-2);
    if (prev - last >= VOLUME_DROP_STEP) {
      signals.push("volume lowered");
      return clamp01(intensity + VOLUME_AMPLIFY);
    }
  }
  return intensity;
}

const NEUTRAL: DriveStateAssessment = { mode: "neutral", reason: "", intensity: 0, signals: [] };

/**
 * Classifies the current instantaneous drive state from recent telemetry (oldest→newest) and the
 * driver's local time. Calm takes priority over focus. Returns NEUTRAL when nothing applies.
 */
export function assessDriveState(
  recent: NormalizedTelemetryEvent[],
  localTimeIso: string
): DriveStateAssessment {
  const latest = recent[recent.length - 1];
  if (!latest) return NEUTRAL;

  // R0a. Sudden braking / hazards (strong, real-time — streaming only).
  if (latest.hazardsActive === true || (typeof latest.longitudinalAccelMps2 === "number" && latest.longitudinalAccelMps2 <= HARD_BRAKE_MPS2)) {
    const signals = latest.hazardsActive ? ["hazard lights"] : ["hard braking"];
    return { mode: "calm", reason: "sudden braking", intensity: 0.8, signals };
  }

  // R0b. Stop-and-go: repeated brake presses at low speed (streaming only).
  const brakeEvents = recent.filter((e) => e.brakePedal === true).length;
  if (brakeEvents >= STOPGO_MIN_BRAKE_EVENTS && typeof latest.speedKph === "number" && latest.speedKph <= STOPGO_SPEED_KPH) {
    const signals = [`${brakeEvents} brake events in stop-and-go`];
    const intensity = applyVolumeAmplifier(0.55, recent, signals);
    return { mode: "calm", reason: "stop-and-go traffic", intensity, signals };
  }

  // 1. Heavy traffic — the most reliable urban-stress signal we have.
  if (typeof latest.trafficDelayMinutes === "number" && latest.trafficDelayMinutes >= TRAFFIC_DELAY_CALM_MIN) {
    const signals = [`${latest.trafficDelayMinutes} min traffic delay`];
    const intensity = applyVolumeAmplifier(clamp01(latest.trafficDelayMinutes / 30), recent, signals);
    return { mode: "calm", reason: "heavy traffic", intensity, signals };
  }

  // 2. Range anxiety — prefer predicted energy at arrival; fall back to raw battery when no route.
  const lowByArrival =
    typeof latest.energyPercentAtArrival === "number" && latest.energyPercentAtArrival <= ENERGY_AT_ARRIVAL_LOW;
  const lowByBattery =
    typeof latest.energyPercentAtArrival !== "number" &&
    typeof latest.batteryPercent === "number" &&
    latest.batteryPercent < BATTERY_LOW;
  if (lowByArrival) {
    const pct = latest.energyPercentAtArrival as number;
    const signals = [`~${Math.round(pct)}% battery at arrival`];
    const intensity = applyVolumeAmplifier(clamp01(0.4 + (ENERGY_AT_ARRIVAL_LOW - pct) * 0.05), recent, signals);
    return { mode: "calm", reason: "low range", intensity, signals };
  }
  if (lowByBattery) {
    const pct = latest.batteryPercent as number;
    const signals = [`battery ${Math.round(pct)}%`];
    const intensity = applyVolumeAmplifier(clamp01(0.4 + (BATTERY_LOW - pct) * 0.04), recent, signals);
    return { mode: "calm", reason: "low range", intensity, signals };
  }

  // 3. Wintry conditions — weak temperature proxy (no rain/wiper signal exists).
  if (typeof latest.outsideTempC === "number" && latest.outsideTempC <= COLD_C) {
    const signals = [`${Math.round(latest.outsideTempC)}°C outside`];
    const intensity = applyVolumeAmplifier(0.4, recent, signals);
    return { mode: "calm", reason: "wintry conditions", intensity, signals };
  }

  // 4. Long night drive (monotony) → keep the driver engaged.
  if (
    isNight(localTimeIso) &&
    typeof latest.speedKph === "number" &&
    latest.speedKph >= FOCUS_MIN_SPEED_KPH &&
    typeof latest.etaMinutes === "number" &&
    latest.etaMinutes >= FOCUS_MIN_ETA_MIN &&
    paceIsSteady(recent)
  ) {
    return { mode: "focus", reason: "long night drive", intensity: 0.5, signals: ["night highway"] };
  }

  return NEUTRAL;
}

/**
 * Hysteresis: only switch the engaged mode once the raw instantaneous mode has held for `hold`
 * consecutive polls. Prevents flapping on a single traffic light or brief speed dip. Pure.
 *
 * @param engaged the currently-engaged mode
 * @param recentRawModes raw instantaneous modes, oldest→newest
 */
export function stabilizeDriveMode(engaged: DriveMode, recentRawModes: DriveMode[], hold = 2): DriveMode {
  if (recentRawModes.length < hold) return engaged;
  const window = recentRawModes.slice(-hold);
  const allSame = window.every((mode) => mode === window[0]);
  if (allSame && window[0] !== engaged) return window[0];
  return engaged;
}
