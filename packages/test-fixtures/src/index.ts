import type { JourneyContext, SongCandidate } from "@longplay/core";
import { simulatedTelemetry } from "@longplay/telemetry";

export const fixtureJourneyContext: JourneyContext = {
  destination: "Lago di Garda",
  coarseRegion: "Northern Italy",
  localTimeIso: "2026-05-28T18:30:00.000Z",
  weatherFeel: "warm and clear",
  etaMinutes: 95,
  speedBucket: "highway",
  temperatureBucket: "warm",
  phase: "golden_hour",
  userPrompt: "cinematic but focused",
  passengerMode: "couple"
};

export const fixtureSongCandidates: SongCandidate[] = [
  {
    artist: "M83",
    title: "Wait",
    reason: "cinematic late-drive atmosphere",
    source: "grok",
    confidence: 0.8
  },
  {
    artist: "Tycho",
    title: "A Walk",
    reason: "focused cruise energy",
    source: "grok",
    confidence: 0.78
  }
];

export const fixtureTelemetry = simulatedTelemetry(3, fixtureJourneyContext.destination);
