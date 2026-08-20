import type { JourneyContext } from "@longplay/core";
import { normalizeText } from "@longplay/core";

import type { TimeBand, TripArc } from "./context-signals.js";

export type MoodKey =
  | "night_cruise"
  | "dawn_lift"
  | "open_road"
  | "golden_cinematic"
  | "bright_day"
  | "wind_down"
  | "focus_steady"
  | "family_singalong";

export interface MoodDefinition {
  key: MoodKey;
  energy: [number, number]; // expected energy band
  valence: number; // -1 dark … +1 bright
  characterWords: string[];
  genres: string[];
  lastfmTags: string[];
}

export interface ResolvedMood {
  primary: MoodKey;
  secondary?: MoodKey;
  blendWeight: number; // 0..1 strength of the secondary influence
}

export const MOODS: Record<MoodKey, MoodDefinition> = {
  night_cruise: {
    key: "night_cruise",
    energy: [0.45, 0.6],
    valence: 0,
    characterWords: ["smooth", "hypnotic", "steady", "propulsive", "nocturnal"],
    genres: ["electronic", "indie", "downtempo electronic"],
    lastfmTags: ["synthwave", "nu disco", "deep house", "indietronica"],
  },
  dawn_lift: {
    key: "dawn_lift",
    energy: [0.5, 0.65],
    valence: 0.4,
    characterWords: ["warm", "awakening", "hopeful", "building"],
    genres: ["indie", "folk/acoustic", "indie pop"],
    lastfmTags: ["morning", "indie folk", "ambient pop"],
  },
  open_road: {
    key: "open_road",
    energy: [0.6, 0.75],
    valence: 0.3,
    characterWords: ["momentum", "expansive", "driving"],
    genres: ["rock", "indie", "pop"],
    lastfmTags: ["road trip", "indie rock", "alt rock"],
  },
  golden_cinematic: {
    key: "golden_cinematic",
    energy: [0.45, 0.6],
    valence: 0.5,
    characterWords: ["warm", "cinematic", "emotional", "expansive"],
    genres: ["indie", "ambient/cinematic", "electronic"],
    lastfmTags: ["chillwave", "cinematic", "indie"],
  },
  bright_day: {
    key: "bright_day",
    energy: [0.6, 0.78],
    valence: 0.6,
    characterWords: ["sunlit", "upbeat", "feelgood"],
    genres: ["pop", "indie pop", "soul/funk"],
    lastfmTags: ["pop", "feelgood", "summer"],
  },
  wind_down: {
    key: "wind_down",
    energy: [0.3, 0.45],
    valence: 0.1,
    characterWords: ["calm", "mellow", "resolving"],
    genres: ["folk/acoustic", "ambient/cinematic", "soul"],
    lastfmTags: ["chillout", "acoustic", "ambient"],
  },
  focus_steady: {
    key: "focus_steady",
    energy: [0.45, 0.6],
    valence: 0.1,
    characterWords: ["steady", "low-distraction", "forward"],
    genres: ["electronic", "indie", "downtempo electronic"],
    lastfmTags: ["electropop", "indie pop", "downtempo"],
  },
  family_singalong: {
    key: "family_singalong",
    energy: [0.62, 0.78],
    valence: 0.6,
    characterWords: ["clean", "upbeat", "singalong", "good-mood"],
    genres: ["pop", "dance-pop", "disco/funk", "latin pop"],
    lastfmTags: ["dance-pop", "feelgood", "disco", "latin pop"],
  },
};

function baseMoodForBand(band: TimeBand): MoodKey {
  switch (band) {
    case "deep_night":
    case "night":
      return "night_cruise";
    case "dawn":
      return "dawn_lift";
    case "morning":
    case "midday":
      return "bright_day";
    case "afternoon":
      return "open_road";
    case "golden":
      return "golden_cinematic";
    default:
      return "open_road";
  }
}

/** Deterministic primary + secondary mood from context and derived signals. */
export function resolveMood(
  context: JourneyContext,
  signals: { band: TimeBand; arc: TripArc },
): ResolvedMood {
  // Family and Kids share the all-ages mood profile so moodKey/valence/energy band stay coherent
  // with the kids energy lift + Disney lens set (kids was previously left on the time-of-day mood).
  if (context.passengerMode === "family" || context.kidsMode) {
    return { primary: "family_singalong", blendWeight: 0.2 };
  }

  const driveMode = context.driveState?.mode;
  let primary = baseMoodForBand(signals.band);

  if (signals.arc.segment === "closing") {
    primary = driveMode === "focus" ? "open_road" : "wind_down";
  }

  let secondary: MoodKey | undefined;
  if (driveMode === "calm") secondary = "wind_down";
  else if (driveMode === "focus") secondary = "focus_steady";

  const prompt = normalizeText(context.userPrompt);
  if (
    prompt.includes("euphoric") ||
    prompt.includes("uplifting") ||
    prompt.includes("feel good")
  ) {
    secondary = "bright_day";
  } else if (
    prompt.includes("mellow") ||
    prompt.includes("relaxed") ||
    prompt.includes("easygoing")
  ) {
    secondary = "wind_down";
  } else if (prompt.includes("adventure") || prompt.includes("bold")) {
    secondary = "open_road";
  }

  if (secondary === primary) secondary = undefined;
  return { primary, secondary, blendWeight: secondary ? 0.3 : 0 };
}
