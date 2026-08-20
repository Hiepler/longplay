import type {
  DriveMode,
  DriveStateAssessment,
  JourneyContext,
  ResolvedTrack,
  SongCandidate,
  SongCandidateRole,
  SongCandidateScores,
  TasteProfile,
} from "@longplay/core";
import { clampConfidence, normalizeText, songKey } from "@longplay/core";
import { seededJitter } from "./variety.js";
import { looksLikeSpokenWord } from "./spokenWord.js";
import { releaseAgeDays } from "./releaseRadar.js";
import type { LastfmChartTrack } from "./lastfm.js";
import type {
  TimeBand,
  TripSegment,
  TripArchetype,
} from "./context-signals.js";
import {
  timeOfDayBand,
  tripArc,
  alertnessFloor,
  ALERTNESS_FLOOR_BASE,
  ALERTNESS_FLOOR_SLOPE,
  archetypeStrategy,
  dayContextFrom,
  tripArchetype,
} from "./context-signals.js";
import type { MoodKey } from "./moods.js";
import { MOODS, resolveMood } from "./moods.js";

export { assessDriveState, stabilizeDriveMode } from "./driveState.js";
export { LastfmChartClient, type LastfmChartTrack } from "./lastfm.js";
export {
  timeOfDayBand,
  tripArc,
  effectiveTripMinutes,
  alertnessFloor,
  ALERTNESS_FLOOR_BASE,
  ALERTNESS_FLOOR_SLOPE,
  archetypeStrategy,
  dayContextFrom,
  tripArchetype,
  weatherFeel,
} from "./context-signals.js";
export type {
  TimeBand,
  TripSegment,
  TripArc,
  PaceTrend,
  TripArchetype,
  DayKind,
  DayContext,
  ArchetypeStrategy,
} from "./context-signals.js";
export { MOODS, resolveMood } from "./moods.js";
export type { MoodKey, MoodDefinition, ResolvedMood } from "./moods.js";

const FALLBACK_CANDIDATES: SongCandidate[] = [
  {
    artist: "Khruangbin",
    title: "A Calf Born in Winter",
    reason: "warm instrumental motion that stays calm but awake",
    source: "fallback",
    confidence: 0.72,
  },
  {
    artist: "The War on Drugs",
    title: "Red Eyes",
    reason: "open-road momentum with melodic lift",
    source: "fallback",
    confidence: 0.78,
  },
  {
    artist: "M83",
    title: "Wait",
    reason: "cinematic late-drive atmosphere",
    source: "fallback",
    confidence: 0.7,
  },
  {
    artist: "Tycho",
    title: "A Walk",
    reason: "focused cruise energy without harsh edges",
    source: "fallback",
    confidence: 0.74,
  },
  {
    artist: "Roosevelt",
    title: "Moving On",
    reason: "bright forward motion for a long drive",
    source: "fallback",
    confidence: 0.73,
  },
  {
    artist: "Bonobo",
    title: "Kerala",
    reason: "textured rhythm for a steady highway section",
    source: "fallback",
    confidence: 0.71,
  },
  {
    artist: "Beach House",
    title: "Space Song",
    reason: "dreamy arrival texture without becoming too sleepy",
    source: "fallback",
    confidence: 0.69,
  },
  {
    artist: "Jungle",
    title: "Casio",
    reason: "light rhythmic lift for a confident cruise",
    source: "fallback",
    confidence: 0.74,
  },
  {
    artist: "Caribou",
    title: "Can't Do Without You",
    reason: "emotional momentum for an open road segment",
    source: "fallback",
    confidence: 0.73,
  },
  {
    artist: "Air",
    title: "La femme d'argent",
    reason: "smooth spacious drive texture",
    source: "fallback",
    confidence: 0.71,
  },
  {
    artist: "Rufus Du Sol",
    title: "Innerbloom",
    reason: "long-form build for scenic distance",
    source: "fallback",
    confidence: 0.76,
  },
  {
    artist: "Parcels",
    title: "Tieduprightnow",
    reason: "sunlit groove that stays relaxed",
    source: "fallback",
    confidence: 0.72,
  },
  {
    artist: "Massive Attack",
    title: "Teardrop",
    reason: "night-drive focus with familiar gravity",
    source: "fallback",
    confidence: 0.7,
  },
  {
    artist: "The xx",
    title: "Intro",
    reason: "minimal reset between bigger tracks",
    source: "fallback",
    confidence: 0.68,
  },
  {
    artist: "Jamie xx",
    title: "Loud Places",
    reason: "late-journey emotional lift",
    source: "fallback",
    confidence: 0.73,
  },
  {
    artist: "Odesza",
    title: "A Moment Apart",
    reason: "cinematic arrival energy",
    source: "fallback",
    confidence: 0.75,
  },
  {
    artist: "Foals",
    title: "Spanish Sahara",
    reason: "slow-building landscape feeling",
    source: "fallback",
    confidence: 0.69,
  },
  {
    artist: "Phoenix",
    title: "Lisztomania",
    reason: "bright familiar energy for fatigue prevention",
    source: "fallback",
    confidence: 0.7,
  },
  {
    artist: "Tame Impala",
    title: "Let It Happen",
    reason: "rolling pulse for a long highway stretch",
    source: "fallback",
    confidence: 0.74,
  },
];

const FAMILY_FALLBACK_CANDIDATES: SongCandidate[] = [
  {
    artist: "Pharrell Williams",
    title: "Happy",
    genre: "pop",
    moodTags: ["pop", "feelgood"],
    explicit: false,
    popularity: 82,
    releaseDate: "2013-11-21",
    reason: "clean feel-good pop for family good mood",
    source: "fallback",
    confidence: 0.82,
  },
  {
    artist: "Justin Timberlake",
    title: "Can't Stop the Feeling!",
    genre: "dance-pop",
    moodTags: ["pop", "dance-pop", "feelgood"],
    explicit: false,
    popularity: 84,
    releaseDate: "2016-05-06",
    reason: "bright clean singalong energy for a family drive",
    source: "fallback",
    confidence: 0.84,
  },
  {
    artist: "Dua Lipa",
    title: "Levitating",
    genre: "dance-pop",
    moodTags: ["pop", "dance-pop", "disco"],
    explicit: false,
    popularity: 86,
    releaseDate: "2020-03-27",
    reason: "current-feeling pop groove with broad appeal",
    source: "fallback",
    confidence: 0.82,
  },
  {
    artist: "Harry Styles",
    title: "As It Was",
    genre: "pop",
    moodTags: ["pop", "feelgood"],
    explicit: false,
    popularity: 88,
    releaseDate: "2022-04-01",
    reason: "recognizable current pop lift without harsh energy",
    source: "fallback",
    confidence: 0.82,
  },
  {
    artist: "Miley Cyrus",
    title: "Flowers",
    genre: "pop",
    moodTags: ["pop", "feelgood"],
    explicit: false,
    popularity: 86,
    releaseDate: "2023-01-12",
    reason: "recent upbeat pop anchor for broad acceptance",
    source: "fallback",
    confidence: 0.81,
  },
  {
    artist: "Mark Ronson",
    title: "Uptown Funk",
    genre: "funk pop",
    moodTags: ["pop", "disco", "feelgood"],
    explicit: false,
    popularity: 85,
    releaseDate: "2014-11-10",
    reason: "clean high-recognition groove for group energy",
    source: "fallback",
    confidence: 0.8,
  },
  // Beloved animated-film singalongs the whole car knows — distinct artists so they all survive
  // diversity, clean, and timeless (recencyBias for family no longer penalizes them).
  {
    artist: "Idina Menzel",
    title: "Let It Go",
    genre: "soundtrack",
    moodTags: ["disney", "singalong", "feelgood"],
    explicit: false,
    popularity: 80,
    releaseDate: "2013-11-25",
    reason: "iconic clean Disney singalong loved by kids and adults",
    source: "fallback",
    confidence: 0.84,
  },
  {
    artist: "Auli'i Cravalho",
    title: "How Far I'll Go",
    genre: "soundtrack",
    moodTags: ["disney", "singalong", "feelgood"],
    explicit: false,
    popularity: 76,
    releaseDate: "2016-11-18",
    reason: "uplifting clean animated-film singalong for the whole family",
    source: "fallback",
    confidence: 0.83,
  },
  {
    artist: "Phil Collins",
    title: "You'll Be in My Heart",
    genre: "soundtrack",
    moodTags: ["disney", "singalong", "warm"],
    explicit: false,
    popularity: 74,
    releaseDate: "1999-04-05",
    reason: "warm timeless animated-film classic adults and kids both know",
    source: "fallback",
    confidence: 0.82,
  },
];

const FORBIDDEN_PROMPT_KEYS = [
  "tidal",
  "spotify",
  "apple music",
  "playlist id",
  "library",
  "vin",
  "gps",
  "latitude",
  "longitude",
  "raw location",
];

export interface SongScout {
  generateCandidates(
    context: JourneyContext,
    targetCount: number,
    policy?: RecommendationPolicy,
  ): Promise<SongCandidate[]>;
}

export interface XaiSongScoutOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mock: boolean;
  /** Abort the LLM request after this many ms so a hung provider never blocks a journey. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SCOUT_TIMEOUT_MS = 30_000;

const DEPRECATED_XAI_MODELS: Record<string, string> = {
  "grok-4": "grok-4.3",
  "grok-3": "grok-4.3",
  "grok-4-0709": "grok-4.3",
  "grok-4-fast-reasoning": "grok-4.3",
  "grok-4-fast-non-reasoning": "grok-4.20-non-reasoning",
  "grok-4-1-fast-reasoning": "grok-4.3",
  "grok-4-1-fast-non-reasoning": "grok-4.20-non-reasoning",
};

export function resolveXaiModel(model: string): string {
  return DEPRECATED_XAI_MODELS[model] ?? model;
}

export function extractXaiResponseText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const response = payload as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (
    typeof response.output_text === "string" &&
    response.output_text.length > 0
  ) {
    return response.output_text;
  }

  for (const item of response.output ?? []) {
    if (item.type !== "message" || !item.content) {
      continue;
    }
    for (const part of item.content) {
      if (part.type === "output_text" && part.text) {
        return part.text;
      }
    }
  }

  return response.choices?.[0]?.message?.content;
}

export function buildJourneyPrompt(
  context: JourneyContext,
  targetCount: number,
): string {
  const safeContext = {
    destination: context.destination,
    coarseRegion: context.coarseRegion,
    countryName: context.countryName,
    countryCode: context.countryCode,
    localTimeIso: context.localTimeIso,
    weatherFeel: context.weatherFeel,
    etaMinutes: context.etaMinutes,
    speedBucket: context.speedBucket,
    temperatureBucket: context.temperatureBucket,
    phase: context.phase,
    userPrompt: context.userPrompt,
    passengerMode: context.passengerMode,
  };

  return [
    "You are Longplay, an expert road-trip music director.",
    "Curate real, released songs (artist/title) that feel hand-picked for THIS drive — as if each track",
    "were chosen the moment the car's mood, pace, and surroundings shifted.",
    "Use web search to verify releases and to include genuinely current charting or viral tracks alongside",
    "timeless classics; vary artists, eras, and energy and avoid obvious repetition.",
    "ONLY actual music. Never return audio dramas, Hörspiele, audiobooks, Hörbücher, readings, podcasts,",
    "guided meditations, ASMR, or children's story episodes (e.g. no 'Folge/Kapitel/Teil N' episode tracks).",
    "Map abstract drive signals (never invent raw GPS, VINs, or streaming-library data):",
    "- speedBucket: parked = slow/ambient, city = mid-tempo groove, highway = forward momentum",
    "- phase: departure = lift, cruise = steady flow, golden_hour = cinematic warmth, arrival = wind-down, focus = minimal",
    "- weatherFeel / temperatureBucket: color the mood (warm sun, cool air, rain, etc.)",
    "- etaMinutes: shorter ETA → slightly more alert energy; long haul → allow longer builds",
    "- passengerMode: adjust social energy (solo vs couple vs family)",
    "- family passengerMode: prioritize clean, upbeat, current pop/dance-pop and broadly known good-mood songs",
    "Each reason must cite at least two context fields (e.g. phase + region, or speed + weather) so picks feel tailored.",
    `Return exactly ${targetCount} JSON items with artist, title, reason, confidence, and optional album/year/isrc.`,
    "Avoid sleepy, aggressive, novelty, or unsafe driving energy unless explicitly requested.",
    `Journey context: ${JSON.stringify(safeContext)}`,
  ].join("\n");
}

export function assertPromptIsPrivacySafe(prompt: string): void {
  const normalized = prompt.toLowerCase();
  const forbidden = FORBIDDEN_PROMPT_KEYS.filter((key) => {
    const pattern =
      key.length <= 3
        ? new RegExp(`\\b${key}\\b`, "i")
        : new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    return pattern.test(normalized);
  });
  if (forbidden.length > 0) {
    throw new Error(
      `Prompt contains forbidden data hints: ${forbidden.join(", ")}`,
    );
  }
}

export function assertJourneyContextIsPrivacySafe(
  context: JourneyContext,
): void {
  assertPromptIsPrivacySafe(context.userPrompt);
  assertPromptIsPrivacySafe(context.destination);
  if (context.coarseRegion) {
    assertPromptIsPrivacySafe(context.coarseRegion);
  }
  if (context.weatherFeel) {
    assertPromptIsPrivacySafe(context.weatherFeel);
  }
}

export class XaiSongScout implements SongScout {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: XaiSongScoutOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_SCOUT_TIMEOUT_MS;
  }

  async generateCandidates(
    context: JourneyContext,
    targetCount: number,
  ): Promise<SongCandidate[]> {
    if (this.options.mock || !this.options.apiKey) {
      return fallbackCandidates(context, targetCount);
    }

    assertJourneyContextIsPrivacySafe(context);
    const prompt = buildJourneyPrompt(context, targetCount);
    const model = resolveXaiModel(this.options.model);

    const response = await this.fetchImpl(
      `${this.options.baseUrl.replace(/\/$/, "")}/responses`,
      {
        method: "POST",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          reasoning_effort: "none",
          input: [
            {
              role: "system",
              content:
                "Return only JSON. Never include streaming-service data, raw GPS, VINs, or user-library references.",
            },
            { role: "user", content: prompt },
          ],
          tools: [{ type: "web_search" }],
        }),
      },
    );

    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(
        `xAI request failed with ${response.status}: ${responseBody}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseBody);
    } catch {
      throw new Error("xAI response was not valid JSON.");
    }

    const content = extractXaiResponseText(payload);
    if (!content) {
      throw new Error("xAI response did not include candidate JSON.");
    }

    return resolveCandidatesFromModelText(
      content,
      context,
      targetCount,
      "grok",
    );
  }
}

export interface GeminiSongScoutOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mock: boolean;
  /** Abort the LLM request after this many ms so a hung provider never blocks a journey. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const GEMINI_SYSTEM_INSTRUCTION = [
  "You are Longplay. Use Google Search grounding to find real, released songs that match the",
  "abstract journey context (destination, region, time, weather feel, pace bucket, phase, ETA, passengers).",
  "Blend classics with current charting or viral tracks. Each reason must reference at least two context",
  "signals so the set feels written for this exact drive.",
  "ONLY actual music — never audio dramas, Hörspiele, audiobooks, Hörbücher, readings, podcasts, guided",
  "meditations, ASMR, or children's story episodes (no 'Folge/Kapitel/Teil N' episode tracks).",
  "Respond with ONLY valid JSON, no markdown, no schema placeholders. Example:",
  '{"songs":[{"artist":"Khruangbin","title":"Time","reason":"highway cruise through warm evening","confidence":0.82}]}',
  "Never include streaming-service data, raw GPS coordinates, VINs, or user-library references.",
].join(" ");

export type SongScoutProvider = "multilens" | "gemini" | "xai";

export interface SongScoutInfo {
  provider: SongScoutProvider;
  model: string;
  webSearch: boolean;
  mock: boolean;
  lenses?: number;
}

export function createSongScout(input: {
  provider: SongScoutProvider;
  mock: boolean;
  gemini: GeminiSongScoutOptions;
  xai: XaiSongScoutOptions;
  multilens?: {
    perLensCount?: number;
    maxOutputTokens?: number;
    lenses?: SongLens[];
    includeDeepCuts?: boolean;
  };
}): { scout: SongScout; info: SongScoutInfo } {
  const geminiUsable = input.mock || Boolean(input.gemini.apiKey);

  // Default/preferred path: telemetry-driven multi-lens engine (needs the Gemini path usable).
  if (input.provider === "multilens" && geminiUsable) {
    const lenses = input.multilens?.lenses;
    return {
      scout: new MultiLensSongScout({
        apiKey: input.gemini.apiKey,
        baseUrl: input.gemini.baseUrl,
        model: input.gemini.model,
        mock: input.mock,
        requestTimeoutMs: input.gemini.requestTimeoutMs,
        fetchImpl: input.gemini.fetchImpl,
        lenses,
        perLensCount: input.multilens?.perLensCount,
        maxOutputTokens: input.multilens?.maxOutputTokens,
        includeDeepCuts: input.multilens?.includeDeepCuts,
      }),
      info: {
        provider: "multilens",
        model: input.gemini.model,
        webSearch: !input.mock && Boolean(input.gemini.apiKey),
        mock: input.mock,
        lenses: lenses?.length ?? 5,
      },
    };
  }

  if (input.provider !== "xai" && geminiUsable) {
    return {
      scout: new GeminiSongScout(input.gemini),
      info: {
        provider: "gemini",
        model: input.gemini.model,
        webSearch: !input.mock && Boolean(input.gemini.apiKey),
        mock: input.mock,
      },
    };
  }

  return {
    scout: new XaiSongScout(input.xai),
    info: {
      provider: "xai",
      model: resolveXaiModel(input.xai.model),
      webSearch: !input.mock && Boolean(input.xai.apiKey),
      mock: input.mock,
    },
  };
}

/** Concatenates the text parts of a native Gemini `generateContent` response. */
export function extractGeminiText(payload: unknown): string | undefined {
  const parts = (
    payload as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }
  )?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const text = parts
    .map((part) => part?.text ?? "")
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** Walks from the first `{` or `[` and returns the balanced JSON slice. */
export function extractBalancedJson(text: string): string | undefined {
  const startObject = text.indexOf("{");
  const startArray = text.indexOf("[");
  let start = -1;
  if (startObject === -1) {
    start = startArray;
  } else if (startArray === -1) {
    start = startObject;
  } else {
    start = Math.min(startObject, startArray);
  }
  if (start === -1) {
    return undefined;
  }

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

/** Extracts a JSON object/array from model text that may be wrapped in markdown fences or prose. */
export function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  return extractBalancedJson(body) ?? extractBalancedJson(text);
}

/** Applies light repairs before `JSON.parse` on model-generated JSON. */
export function repairJsonString(input: string): string {
  return input
    .replace(/^\uFEFF/, "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3');
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(
      `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    ) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

/** Pulls song objects out of prose when the surrounding JSON is invalid. */
export function salvageCandidatesFromText(
  text: string,
): Partial<SongCandidate>[] {
  const salvaged: Partial<SongCandidate>[] = [];
  const objectPattern =
    /\{[^{}]*?"artist"\s*:\s*"((?:\\.|[^"\\])*)"[^{}]*?"title"\s*:\s*"((?:\\.|[^"\\])*)"[^{}]*?\}/gi;

  for (const match of text.matchAll(objectPattern)) {
    const block = match[0];
    const artist = decodeJsonString(match[1]);
    const title = decodeJsonString(match[2]);
    const reasonMatch = block.match(/"reason"\s*:\s*"((?:\\.|[^"\\])*)"/i);
    const confidenceMatch = block.match(/"confidence"\s*:\s*([\d.]+)/i);
    const albumMatch = block.match(/"album"\s*:\s*"((?:\\.|[^"\\])*)"/i);
    const yearMatch = block.match(/"year"\s*:\s*(\d{4})/i);

    salvaged.push({
      artist,
      title,
      reason: reasonMatch ? decodeJsonString(reasonMatch[1]) : undefined,
      confidence: confidenceMatch ? Number(confidenceMatch[1]) : undefined,
      album: albumMatch ? decodeJsonString(albumMatch[1]) : undefined,
      year: yearMatch ? Number(yearMatch[1]) : undefined,
    });
  }

  return salvaged;
}

function candidateItemsFromParsed(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const record = parsed as { songs?: unknown; candidates?: unknown };
  if (Array.isArray(record.songs)) {
    return record.songs;
  }
  if (Array.isArray(record.candidates)) {
    return record.candidates;
  }
  return [];
}

function mapCandidateItems(
  items: unknown[],
  targetCount: number,
  source: SongCandidate["source"],
): SongCandidate[] {
  return items
    .map((item) => item as Partial<SongCandidate>)
    .filter(
      (item) =>
        typeof item.artist === "string" && typeof item.title === "string",
    )
    .slice(0, targetCount)
    .map((item) => ({
      artist: item.artist?.trim() ?? "",
      title: item.title?.trim() ?? "",
      album: typeof item.album === "string" ? item.album : undefined,
      year: typeof item.year === "number" ? item.year : undefined,
      isrc: typeof item.isrc === "string" ? item.isrc : undefined,
      genre: typeof item.genre === "string" ? item.genre : undefined,
      energy:
        typeof item.energy === "number" && Number.isFinite(item.energy)
          ? clamp01(item.energy)
          : undefined,
      valence:
        typeof item.valence === "number" && Number.isFinite(item.valence)
          ? Math.max(-1, Math.min(1, item.valence))
          : undefined,
      lens: typeof item.lens === "string" ? item.lens : undefined,
      role: parseCandidateRole(item.role),
      scores: parseCandidateScores(item.scores),
      popularity:
        typeof item.popularity === "number" ? item.popularity : undefined,
      explicit: typeof item.explicit === "boolean" ? item.explicit : undefined,
      releaseDate:
        typeof item.releaseDate === "string" ? item.releaseDate : undefined,
      chartRank:
        typeof item.chartRank === "number" ? item.chartRank : undefined,
      chartPlaycount:
        typeof item.chartPlaycount === "number"
          ? item.chartPlaycount
          : undefined,
      chartCountry:
        typeof item.chartCountry === "string" ? item.chartCountry : undefined,
      chartSource:
        typeof item.chartSource === "string" ? item.chartSource : undefined,
      moodTags: Array.isArray(item.moodTags)
        ? item.moodTags.filter((tag): tag is string => typeof tag === "string")
        : undefined,
      reason:
        typeof item.reason === "string"
          ? item.reason
          : "fits the current drive context",
      source,
      confidence: clampConfidence(
        typeof item.confidence === "number" ? item.confidence : 0.65,
      ),
    }));
}

const SET_ROLES: SongCandidateRole[] = [
  "anchor",
  "momentum",
  "bridge",
  "surprise",
  "resolution",
];

function parseCandidateRole(value: unknown): SongCandidateRole | undefined {
  return typeof value === "string" &&
    SET_ROLES.includes(value as SongCandidateRole)
    ? (value as SongCandidateRole)
    : undefined;
}

function parseCandidateScores(value: unknown): SongCandidateScores | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<Record<keyof SongCandidateScores, unknown>>;
  const score = (key: keyof SongCandidateScores, fallback = 0): number =>
    clampConfidence(typeof record[key] === "number" ? record[key] : fallback);
  return {
    contextFit: score("contextFit"),
    telemetryFit: score("telemetryFit"),
    tasteFit: score("tasteFit"),
    diversityGain: score("diversityGain"),
    novelty: score("novelty"),
    fatiguePenalty: score("fatiguePenalty"),
    total: score("total"),
  };
}

/**
 * Parses model JSON with repair, balanced extraction, and regex salvage.
 * Returns `undefined` when no usable songs were found.
 */
/** Collects every top-level `{...}` slice in model text (works when the outer array JSON is broken). */
export function collectBalancedObjectSlices(text: string): string[] {
  const slices: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start === -1) {
      break;
    }
    const slice = extractBalancedJson(text.slice(start));
    if (!slice) {
      searchFrom = start + 1;
      continue;
    }
    slices.push(slice);
    searchFrom = start + slice.length;
  }
  return slices;
}

export function tryParseCandidateJson(
  content: string,
  targetCount: number,
  source: SongCandidate["source"] = "grok",
): SongCandidate[] | undefined {
  const slices = new Set<string>();
  for (const slice of [
    content,
    extractJsonObject(content),
    extractBalancedJson(content),
  ]) {
    if (slice) {
      slices.add(slice);
    }
  }
  for (const slice of collectBalancedObjectSlices(content)) {
    slices.add(slice);
  }

  const merged: SongCandidate[] = [];
  for (const slice of slices) {
    for (const candidate of [slice, repairJsonString(slice)]) {
      try {
        const mapped = mapCandidateItems(
          candidateItemsFromParsed(JSON.parse(candidate)),
          targetCount,
          source,
        );
        for (const song of mapped) {
          if (
            !merged.some(
              (item) =>
                item.artist === song.artist && item.title === song.title,
            )
          ) {
            merged.push(song);
          }
          if (merged.length >= targetCount) {
            return merged.slice(0, targetCount);
          }
        }
      } catch {
        // Try the next slice/repair variant.
      }
    }
    const sliceSalvaged = mapCandidateItems(
      salvageCandidatesFromText(slice),
      targetCount,
      source,
    );
    for (const song of sliceSalvaged) {
      if (
        !merged.some(
          (item) => item.artist === song.artist && item.title === song.title,
        )
      ) {
        merged.push(song);
      }
      if (merged.length >= targetCount) {
        return merged.slice(0, targetCount);
      }
    }
  }

  if (merged.length > 0) {
    return merged.slice(0, targetCount);
  }

  const salvaged = mapCandidateItems(
    salvageCandidatesFromText(content),
    targetCount,
    source,
  );
  return salvaged.length > 0 ? salvaged : undefined;
}

const GEMINI_STRUCTURED_SCHEMA = {
  type: "object",
  properties: {
    songs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          artist: { type: "string" },
          title: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number" },
          album: { type: "string" },
          year: { type: "integer" },
        },
        required: ["artist", "title", "reason", "confidence"],
      },
    },
  },
  required: ["songs"],
} as const;

/**
 * Song scout backed by Gemini Flash via Google's native Generative Language API
 * (`<baseUrl>/models/<model>:generateContent`) with Google Search grounding enabled. Grounding
 * keeps the set anchored to real, current songs while Flash keeps latency low.
 */
export class GeminiSongScout implements SongScout {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: GeminiSongScoutOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_SCOUT_TIMEOUT_MS;
  }

  async generateCandidates(
    context: JourneyContext,
    targetCount: number,
  ): Promise<SongCandidate[]> {
    if (this.options.mock || !this.options.apiKey) {
      return fallbackCandidates(context, targetCount);
    }

    try {
      assertJourneyContextIsPrivacySafe(context);
      const prompt = buildJourneyPrompt(context, targetCount);
      const url = `${this.options.baseUrl.replace(/\/$/, "")}/models/${this.options.model}:generateContent`;

      const groundedText = await this.requestGeminiText(url, {
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.75, maxOutputTokens: 4096 },
      });
      const grounded = tryParseCandidateJson(
        groundedText,
        targetCount,
        "gemini",
      );
      if (grounded && grounded.length > 0) {
        return buildJourneySet(
          grounded,
          buildMusicalBrief(context),
          targetCount,
        );
      }

      const structuredText = await this.requestGeminiText(url, {
        systemInstruction: {
          parts: [
            {
              text: [
                "You are Longplay. Return only JSON matching the schema.",
                "Pick real, released songs that fit the journey context.",
                "Never include streaming-service data, raw GPS, VINs, or user-library references.",
              ].join(" "),
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          responseSchema: GEMINI_STRUCTURED_SCHEMA,
        },
      });
      const structured = tryParseCandidateJson(
        structuredText,
        targetCount,
        "gemini",
      );
      if (structured && structured.length > 0) {
        return buildJourneySet(
          structured,
          buildMusicalBrief(context),
          targetCount,
        );
      }

      return fallbackCandidates(context, targetCount);
    } catch {
      return fallbackCandidates(context, targetCount);
    }
  }

  private async requestGeminiText(
    url: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.options.apiKey!,
      },
      body: JSON.stringify(body),
    });

    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(
        `Gemini request failed with ${response.status}: ${responseBody}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseBody);
    } catch {
      throw new Error("Gemini response was not valid JSON.");
    }

    const text = extractGeminiText(payload);
    if (!text) {
      throw new Error("Gemini response did not include text.");
    }
    return text;
  }
}

// ============================================================================
// Multi-lens engine: telemetry brief -> parallel lenses -> diversity balancing
// ============================================================================

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export interface MusicalBrief {
  /** 0 = calm, 1 = high-energy. Drives the per-lens prompts. */
  targetEnergy: number;
  /** Desired energy for the next five-track set, active track excluded. */
  energyCurve: number[];
  intensity: string;
  focusLevel: number;
  socialEnergy: string;
  eras: string;
  genres: string[];
  regionHint?: string;
  moodWords: string[];
  driveSignals: string[];
  destination: string;
  countryName?: string;
  userPrompt: string;
  passengerMode: string;
  /** "Kids am Steuer": allow Disney/film/animated singalongs that family mode otherwise avoids. */
  kidsMode?: boolean;
  /** Roles of active music wishes (e.g. "singalong") — steer lens selection, not just ranking. */
  wishRoles?: string[];
  /** Adaptive Drive Mode applied to this brief (comfort feature; selection bias only). */
  driveMode: DriveMode;
  /** Human-readable cause when driveMode is not neutral (for prompts/diagnostics). */
  driveReason?: string;
  /** Familiarity↔discovery balance, 0 = discovery … 1 = lean into known taste. */
  tasteWeight: number;
  /** Listener's favorite genres (from their Spotify top artists). */
  favoredGenres: string[];
  /** A few representative artists that exemplify the listener's taste. */
  representativeArtists: string[];
  /** -1 dark … +1 bright. Steers lens prompts and candidate-pool valence. */
  valence: number;
  /** Time-of-day band used to derive this brief. */
  timeBand: TimeBand;
  /** Trip-arc segment used to shape the energy curve. */
  tripSegment: TripSegment;
  /** Coarse trip archetype (errand/commute/day_trip/long_haul) shaping the macro strategy. */
  tripArchetype: TripArchetype;
  /** Day-of-week + daypart, e.g. "monday_morning" — for prompt phrasing. */
  dayContext: string;
  /** Journey leg (0 = first leg; >0 after charge stops) so each leg can open its own arc. */
  legIndex?: number;
  /** Currently-playing track, so the next picks can flow naturally from it. */
  nowPlaying?: { artist: string; title: string };
  /** Resolved primary mood key. */
  moodKey: MoodKey;
  /** 0..1 fatigue-aware floor that was applied to target energy (0 = none). */
  fatigueRisk: number;
  /** Live weather descriptor passed through to the prompt for context. */
  weatherFeel?: string;
  /** Rotating exploration angle for per-journey freshness. */
  explorationAngle?: string;
  /** Recently-played artists to avoid (cross-journey fatigue, surfaced to the LLM). */
  avoidRecentArtists?: string[];
  /** Mood tags the listener keeps skipping this session — surfaced so the scout steers away. */
  skippedMoodTags?: string[];
  /** Drive-story act directive for the LLM (narrative arc). */
  storyDirective?: string;
  /** Moment directive for the LLM (arrival/sunset/etc). */
  momentDirective?: string;
  /** Local-music language for the journey country (e.g. "French"), when the country is mapped. */
  localLanguage?: string;
  /** Demonym for homegrown-artist phrasing (e.g. "French", "Italian"), paired with localLanguage. */
  localDemonym?: string;
  /** Confirmed real current releases (artist – title) for the "current" lens grounding line. */
  currentReleases?: string[];
}

/**
 * Country (ISO-3166 alpha-2) → primary local-music language + demonym, for the "local touch" geo bias.
 * Covers the common European road-trip corridor plus a few majors; unmapped countries fall back to a
 * region-text directive so the grounded LLM can still infer the local language from the place name.
 */
const COUNTRY_LOCAL_FLAVOR: Record<
  string,
  { language: string; demonym: string }
> = {
  FR: { language: "French", demonym: "French" },
  DE: { language: "German", demonym: "German" },
  AT: { language: "German", demonym: "Austrian" },
  CH: { language: "German, French or Italian", demonym: "Swiss" },
  IT: { language: "Italian", demonym: "Italian" },
  ES: { language: "Spanish", demonym: "Spanish" },
  PT: { language: "Portuguese", demonym: "Portuguese" },
  NL: { language: "Dutch", demonym: "Dutch" },
  BE: { language: "Dutch or French", demonym: "Belgian" },
  PL: { language: "Polish", demonym: "Polish" },
  CZ: { language: "Czech", demonym: "Czech" },
  SE: { language: "Swedish", demonym: "Swedish" },
  NO: { language: "Norwegian", demonym: "Norwegian" },
  DK: { language: "Danish", demonym: "Danish" },
  FI: { language: "Finnish", demonym: "Finnish" },
  GR: { language: "Greek", demonym: "Greek" },
  HR: { language: "Croatian", demonym: "Croatian" },
  HU: { language: "Hungarian", demonym: "Hungarian" },
  RO: { language: "Romanian", demonym: "Romanian" },
  TR: { language: "Turkish", demonym: "Turkish" },
  BR: { language: "Portuguese", demonym: "Brazilian" },
  MX: { language: "Spanish", demonym: "Mexican" },
  JP: { language: "Japanese", demonym: "Japanese" },
  KR: { language: "Korean", demonym: "Korean" },
};

/** Resolves the local-music flavor for a country code (case-insensitive). Undefined when unmapped. */
export function localMusicFlavor(
  countryCode?: string,
): { language: string; demonym: string } | undefined {
  if (!countryCode) return undefined;
  return COUNTRY_LOCAL_FLAVOR[countryCode.trim().toUpperCase()];
}

/**
 * Aggregates a listener's Spotify top artists into a compact, prompt-safe taste signal:
 * most-frequent genres first, plus a handful of representative artist names. Pure + cheap;
 * the result is cached upstream so the Spotify API is touched at most ~once/day.
 */
export function deriveTasteProfile(
  artists: Array<{ name: string; genres?: string[] }>,
  options: { maxGenres?: number; maxArtists?: number } = {},
): TasteProfile {
  const maxGenres = options.maxGenres ?? 6;
  const maxArtists = options.maxArtists ?? 5;

  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const artist of artists) {
    for (const rawGenre of artist.genres ?? []) {
      const genre = rawGenre.trim().toLowerCase();
      if (!genre) continue;
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
      if (!firstSeen.has(genre)) {
        firstSeen.set(genre, order++);
      }
    }
  }

  const topGenres = [...counts.entries()]
    // Higher frequency first; ties keep the order they were first encountered.
    .sort(
      (a, b) =>
        b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0),
    )
    .slice(0, maxGenres)
    .map(([genre]) => genre);

  const representativeArtists = artists
    .map((artist) => artist.name.trim())
    .filter(Boolean)
    .slice(0, maxArtists);

  return { topGenres, representativeArtists };
}

export interface RecommendationPolicy {
  cleanRequired: boolean;
  targetPopularity: number;
  recencyBias: number;
  moodTags: string[];
  avoidArtists: string[];
  avoidSongKeys: string[];
  preferDistinctArtists: boolean;
  familyMode: boolean;
  /**
   * Familiarity↔discovery dial, 0=all hits … 1=all deep cuts. Derived from the trip archetype
   * (errands lean on the known; long hauls open up to discovery) and consumed at ranking time to
   * balance how strongly popularity is rewarded against surfacing lesser-known cuts.
   */
  targetDiscoveryRatio?: number;
  artistBoosts?: Array<{ artist: string; strength: number }>;
  avoidMoodTags?: string[];
  allowArtistRepeats?: boolean;
}

function uniqueNormalizedTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** Trip archetype from raw context — the same derivation buildMusicalBrief uses, exposed for policy. */
export function tripArchetypeForContext(
  context: JourneyContext,
): TripArchetype {
  const hour = context.localTimeIso
    ? new Date(context.localTimeIso).getHours()
    : 12;
  const band = timeOfDayBand(hour);
  const arc = tripArc(
    context.elapsedMinutes ?? 0,
    context.plannedDurationMinutes,
    context.etaMinutes,
  );
  const dayCtx = dayContextFrom(context.localTimeIso, band);
  return tripArchetype(arc.effectiveTotalMin, band, dayCtx.dayKind);
}

/** Hits↔deep-cut dial by archetype: short hops stay familiar, long hauls open up to discovery. */
const DISCOVERY_RATIO_BY_ARCHETYPE: Record<TripArchetype, number> = {
  errand: 0.15,
  commute: 0.3,
  day_trip: 0.45,
  long_haul: 0.6,
};

export function moodTagsForContext(context: JourneyContext): string[] {
  const band = timeOfDayBand(
    context.localTimeIso ? new Date(context.localTimeIso).getHours() : 12,
  );
  const arc = tripArc(
    context.elapsedMinutes ?? 0,
    context.plannedDurationMinutes,
    context.etaMinutes,
  );
  const mood = resolveMood(context, { band, arc });
  const tags = [...MOODS[mood.primary].lastfmTags];
  if (mood.secondary) tags.push(...MOODS[mood.secondary].lastfmTags);
  return uniqueNormalizedTags(tags).slice(0, 6);
}

export function buildRecommendationPolicy(
  context: JourneyContext,
  overrides: Partial<RecommendationPolicy> = {},
): RecommendationPolicy {
  const prompt = normalizeText(context.userPrompt);
  const kidsMode = context.kidsMode === true;
  // Kids mode inherits family's all-ages guardrails (clean, broadly-known, distinct artists).
  const familyMode = context.passengerMode === "family" || kidsMode;
  const nostalgic =
    prompt.includes("nostalgic") || prompt.includes("throwback");
  const highAcceptance =
    familyMode ||
    context.passengerMode === "friends" ||
    prompt.includes("euphoric") ||
    prompt.includes("uplifting");
  // Curation dial: shape the hits↔deep-cut balance by trip gestalt, then pull it toward the
  // familiar for families/kids (a known catalog the whole car accepts) and nudge it toward
  // discovery for explicitly exploratory prompts.
  const archetype = tripArchetypeForContext(context);
  let targetDiscoveryRatio = DISCOVERY_RATIO_BY_ARCHETYPE[archetype];
  if (familyMode) targetDiscoveryRatio = Math.min(targetDiscoveryRatio, 0.2);
  // A couple shares the drive: a touch more room for discovery than a solo baseline.
  else if (context.passengerMode === "couple") {
    targetDiscoveryRatio = Math.min(1, targetDiscoveryRatio + 0.05);
  }
  if (prompt.includes("discover") || prompt.includes("surprise")) {
    targetDiscoveryRatio = Math.min(1, targetDiscoveryRatio + 0.2);
  }
  return {
    cleanRequired: familyMode,
    targetPopularity: familyMode ? 72 : highAcceptance ? 66 : 58,
    // Kids singalongs are often catalog (Disney classics), so don't over-bias toward fresh releases.
    // Family was 0.78 (fresh-only), which penalized beloved kid classics (Lion King, Frozen, Encanto).
    // 0.5 keeps current pop in reach for the adults while letting timeless singalongs surface.
    recencyBias: kidsMode ? 0.4 : familyMode ? 0.5 : nostalgic ? 0.18 : 0.42,
    moodTags: moodTagsForContext(context),
    avoidArtists: [],
    avoidSongKeys: [],
    preferDistinctArtists: familyMode || context.passengerMode === "friends",
    familyMode,
    targetDiscoveryRatio,
    ...overrides,
  };
}

export function releaseRecencyScore(
  releaseDate: string | undefined,
  now = new Date(),
  dateScoring = false,
): number {
  if (!releaseDate) return 0.35;
  if (!dateScoring) {
    const year = Number(releaseDate.slice(0, 4));
    if (!Number.isFinite(year) || year < 1900) return 0.35;
    const age = Math.max(0, now.getFullYear() - year);
    if (age <= 1) return 1;
    if (age <= 3) return 0.82;
    if (age <= 7) return 0.58;
    if (age <= 15) return 0.35;
    return 0.18;
  }
  const rawAge = releaseAgeDays(releaseDate, now);
  if (rawAge === null) return 0.35;
  const ageDays = Math.max(0, rawAge);
  if (ageDays <= 30) return 1;
  if (ageDays <= 90) return 0.85;
  if (ageDays <= 365) return 0.6;
  if (ageDays <= 365 * 3) return 0.35;
  return 0.18;
}

function chartSignalScore(
  track: Pick<ResolvedTrack, "chartRank" | "chartPlaycount">,
): number {
  const rankScore =
    typeof track.chartRank === "number" && track.chartRank > 0
      ? 1 - Math.min(track.chartRank - 1, 99) / 100
      : 0;
  const playcountScore =
    typeof track.chartPlaycount === "number" && track.chartPlaycount > 0
      ? Math.min(1, Math.log10(track.chartPlaycount + 1) / 7)
      : 0;
  return Math.max(rankScore, playcountScore);
}

function moodFitScore(
  track: Pick<ResolvedTrack, "moodTags" | "matchReason">,
  policy: RecommendationPolicy,
): number {
  const trackTags = new Set(
    (track.moodTags ?? []).map((tag) => normalizeText(tag)),
  );
  if (policy.moodTags.some((tag) => trackTags.has(normalizeText(tag))))
    return 1;
  const reason = normalizeText(track.matchReason ?? "");
  return policy.moodTags.some((tag) => reason.includes(normalizeText(tag)))
    ? 0.72
    : 0.45;
}

export function rankResolvedTracksForPolicy<T extends ResolvedTrack>(
  tracks: T[],
  policy: RecommendationPolicy,
  options: {
    consumedArtists?: Iterable<string>;
    now?: Date;
    /** Variety seed; when set, near-equal tracks are reordered deterministically. */
    seed?: number;
    jitterStrength?: number;
    /** Normalized-artist → penalty for recently surfaced artists (cross-journey). */
    recentArtistPenalty?: Map<string, number>;
    /** songKey → penalty for recently surfaced songs (cross-journey). */
    recentSongPenalty?: Map<string, number>;
    /** Normalized artists exempt from fatigue (active wish / pinned). */
    fatigueExemptArtists?: Iterable<string>;
    /** Hart gebannte (normalisierte) Artisten — Vielfalts-Doktrin; Exempts gewinnen. */
    bannedArtists?: ReadonlySet<string>;
    /** Weicher Mood-Tag-Malus (Session-Lernsignal aus Skips). */
    softMoodPenalty?: Map<string, number>;
    /** Hard-Filter: Hörspiele/Hörbücher/Spoken-Word ausschließen (ein Musik-DJ spielt keine Hörspiele). */
    excludeSpokenWord?: boolean;
    /** Day-based recency curve + stronger recency weight (Engine-Frische). */
    recencyDateScoring?: boolean;
  } = {},
): T[] {
  const consumedArtists = new Set(
    [...(options.consumedArtists ?? [])].map((artist) => normalizeText(artist)),
  );
  const avoidedArtists = new Set(
    policy.avoidArtists.map((artist) => normalizeText(artist)),
  );
  const avoidedSongs = new Set(policy.avoidSongKeys);
  const avoidedMoodTags = new Set(
    (policy.avoidMoodTags ?? []).map((tag) => normalizeText(tag)),
  );
  const artistBoosts = new Map<string, number>();
  for (const boost of policy.artistBoosts ?? []) {
    const key = normalizeText(boost.artist);
    const clamped = Math.max(0, Math.min(1, boost.strength));
    artistBoosts.set(key, Math.max(artistBoosts.get(key) ?? 0, clamped));
  }
  const recentArtistPenalty =
    options.recentArtistPenalty ?? new Map<string, number>();
  const recentSongPenalty =
    options.recentSongPenalty ?? new Map<string, number>();
  const fatigueExempt = new Set(
    [...(options.fatigueExemptArtists ?? [])].map((artist) =>
      normalizeText(artist),
    ),
  );
  const bannedArtists = options.bannedArtists ?? new Set<string>();
  const jitterStrength =
    options.seed !== undefined ? (options.jitterStrength ?? 0.06) : 0;
  return [...tracks]
    .filter((track) => track.providerUri && track.isPlayable !== false)
    .filter((track) => !(policy.cleanRequired && track.explicit === true))
    .filter((track) => !avoidedSongs.has(songKey(track.artist, track.title)))
    .filter((track) => {
      const artist = normalizeText(track.artist);
      return !bannedArtists.has(artist) || fatigueExempt.has(artist);
    })
    .filter(
      (track) =>
        !options.excludeSpokenWord ||
        !looksLikeSpokenWord(track.artist, track.title),
    )
    .map((track, index) => {
      const popularity =
        typeof track.popularity === "number"
          ? Math.max(0, Math.min(100, track.popularity))
          : 45;
      const popularityScore = Math.min(
        1,
        popularity / Math.max(1, policy.targetPopularity),
      );
      // Familiarity↔discovery dial: split the popularity budget between rewarding hits and
      // rewarding lesser-known cuts, per the policy's discovery ratio (0=all hits, 1=all deep cuts).
      const discovery = clamp01(policy.targetDiscoveryRatio ?? 0);
      const obscurity = 1 - popularity / 100;
      const familiarityComponent =
        popularityScore * (1 - discovery) + obscurity * discovery;
      const artist = normalizeText(track.artist);
      const boost = artistBoosts.get(artist) ?? 0;
      const moodPenalty = (track.moodTags ?? []).some((tag) =>
        avoidedMoodTags.has(normalizeText(tag)),
      )
        ? 0.35
        : 0;
      const trackSongKey = songKey(track.artist, track.title);
      const recentPenalty = fatigueExempt.has(artist)
        ? 0
        : (recentSongPenalty.get(trackSongKey) ?? 0) +
          (recentArtistPenalty.get(artist) ?? 0);
      const moodSoft = Math.max(
        0,
        ...(track.moodTags ?? []).map(
          (tag) => options.softMoodPenalty?.get(normalizeText(tag)) ?? 0,
        ),
        0,
      );
      const jitter =
        jitterStrength > 0
          ? seededJitter(options.seed as number, trackSongKey) * jitterStrength
          : 0;
      const fatiguePenalty =
        (consumedArtists.has(artist) && !policy.allowArtistRepeats ? 0.32 : 0) +
        (avoidedArtists.has(artist) ? 0.45 : 0) +
        moodPenalty;
      const score =
        track.matchConfidence * 0.24 +
        familiarityComponent * 0.22 +
        chartSignalScore(track) * 0.22 +
        releaseRecencyScore(
          track.releaseDate,
          options.now,
          options.recencyDateScoring,
        ) *
          policy.recencyBias *
          (options.recencyDateScoring ? 0.2 : 0.14) +
        moodFitScore(track, policy) * 0.08 +
        (policy.cleanRequired && track.explicit === false ? 0.08 : 0) +
        boost * 0.42 +
        jitter -
        fatiguePenalty -
        recentPenalty -
        moodSoft -
        index * 0.0001;
      return { track, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ track }) => track);
}

export function lastfmTracksToCandidates(
  tracks: LastfmChartTrack[],
  context: JourneyContext,
  moodTags: string[],
): SongCandidate[] {
  const seen = new Set<string>();
  const out: SongCandidate[] = [];
  for (const track of tracks) {
    const key = songKey(track.artist, track.title);
    if (seen.has(key)) continue;
    seen.add(key);
    // German charts/tags are flooded with Hörspiele — never let spoken-word into a music queue.
    if (looksLikeSpokenWord(track.artist, track.title)) continue;
    out.push({
      artist: track.artist,
      title: track.title,
      reason: track.country
        ? `Last.fm ${track.country} chart fit for ${context.phase}`
        : `Last.fm ${track.tag ?? "mood"} tag fit for ${context.phase}`,
      source: "lastfm",
      confidence: track.source === "lastfm-geo" ? 0.86 : 0.78,
      lens: track.source,
      chartRank: track.rank,
      chartPlaycount: track.playcount,
      chartCountry: track.country,
      chartSource: track.source,
      moodTags: track.tag
        ? uniqueNormalizedTags([...moodTags, track.tag])
        : moodTags,
    });
  }
  return out;
}

const SPEED_ENERGY: Record<string, number> = {
  parked: 0.3,
  city: 0.45,
  country: 0.6,
  highway: 0.8,
  unknown: 0.55,
};

const PHASE_PROFILE: Record<
  string,
  { delta: number; intensity: string; mood: string[] }
> = {
  departure: {
    delta: 0.05,
    intensity: "building",
    mood: ["anticipation", "fresh start"],
  },
  cruise: { delta: 0, intensity: "steady", mood: ["momentum", "open road"] },
  golden_hour: {
    delta: -0.05,
    intensity: "cinematic",
    mood: ["warm", "emotional", "expansive"],
  },
  focus: {
    delta: -0.05,
    intensity: "focused",
    mood: ["steady", "low-distraction"],
  },
  arrival: {
    delta: -0.15,
    intensity: "resolving",
    mood: ["uplift", "arrival"],
  },
  rest: { delta: -0.25, intensity: "winding-down", mood: ["calm", "mellow"] },
};

const BAND_ENERGY_BIAS: Record<TimeBand, number> = {
  deep_night: -0.1,
  dawn: -0.02,
  morning: 0.05,
  midday: 0.04,
  afternoon: 0.02,
  golden: -0.04,
  night: -0.08,
};

function deriveGenres(targetEnergy: number): string[] {
  const broad = [
    "indie",
    "electronic",
    "rock",
    "soul/funk",
    "pop",
    "hip-hop",
    "folk/acoustic",
    "ambient/cinematic",
  ];
  if (targetEnergy >= 0.7) {
    return ["electronic", "rock", "hip-hop", "pop", "indie", "funk"];
  }
  if (targetEnergy <= 0.4) {
    return [
      "ambient/cinematic",
      "folk/acoustic",
      "soul",
      "indie",
      "downtempo electronic",
      "classic",
    ];
  }
  return broad;
}

/** Deterministic mapping from live telemetry to musical targets — the dynamic core, zero tokens. */
export function buildMusicalBrief(
  context: JourneyContext,
  assessment: DriveStateAssessment | undefined = context.driveState,
): MusicalBrief {
  const baseEnergy = SPEED_ENERGY[context.speedBucket ?? "unknown"] ?? 0.55;
  const profile =
    PHASE_PROFILE[context.phase ?? "departure"] ?? PHASE_PROFILE.departure;
  const hour = context.localTimeIso
    ? new Date(context.localTimeIso).getHours()
    : 12;
  const band = timeOfDayBand(hour);
  const globalArc = tripArc(
    context.elapsedMinutes ?? 0,
    context.plannedDurationMinutes,
    context.etaMinutes,
  );
  // After a charge stop (legIndex > 0) the energy curve reopens per leg: recompute the arc from
  // leg-local elapsed time (no per-leg planned duration; remaining ETA is the rest of this leg) so a
  // fresh leg starts in "opening" instead of riding the global "deep/closing" tail. The whole-trip
  // shape (archetype, long-haul exploration) still comes from the global arc.
  const arc =
    typeof context.legIndex === "number" &&
    context.legIndex > 0 &&
    typeof context.legElapsedMinutes === "number"
      ? tripArc(context.legElapsedMinutes, undefined, context.etaMinutes)
      : globalArc;
  // Gestalt of the whole drive: a 20-min weekend errand vs a weekday commute vs a long haul.
  const dayCtx = dayContextFrom(context.localTimeIso, band);
  const archetype = tripArchetype(
    globalArc.effectiveTotalMin,
    band,
    dayCtx.dayKind,
  );
  const strategy = archetypeStrategy(archetype);
  const mood = resolveMood(context, { band, arc });
  const primaryMood = MOODS[mood.primary];
  const secondaryMood = mood.secondary ? MOODS[mood.secondary] : undefined;

  const trendDelta =
    context.paceTrend === "accelerating"
      ? 0.05
      : context.paceTrend === "slowing"
        ? -0.06
        : 0;
  const focusDelta =
    context.autopilotState === "active" || context.phase === "focus"
      ? -0.04
      : 0;
  const etaDelta =
    typeof context.etaMinutes === "number" && context.etaMinutes <= 15
      ? -0.12
      : typeof context.etaMinutes === "number" && context.etaMinutes > 90
        ? 0.04
        : 0;

  // Pull the band-biased energy toward the resolved mood's energy band.
  const moodMid = (primaryMood.energy[0] + primaryMood.energy[1]) / 2;
  let targetEnergy = clamp01(
    (baseEnergy +
      profile.delta +
      trendDelta +
      focusDelta +
      etaDelta +
      BAND_ENERGY_BIAS[band]) *
      0.6 +
      moodMid * 0.4,
  );

  // Blend valence from the mood(s) — linear interpolation in [-1, 1] space.
  const valence = Math.max(
    -1,
    Math.min(
      1,
      primaryMood.valence +
        (secondaryMood
          ? (secondaryMood.valence - primaryMood.valence) * mood.blendWeight
          : 0),
    ),
  );

  const moodWords = [
    ...primaryMood.characterWords,
    ...(secondaryMood ? secondaryMood.characterWords.slice(0, 2) : []),
    ...profile.mood,
  ];
  if (
    context.temperatureBucket === "warm" ||
    context.temperatureBucket === "hot"
  )
    moodWords.push("sunlit");
  if (context.temperatureBucket === "cold") moodWords.push("moody");
  if (context.paceTrend === "accelerating") moodWords.push("lifting");
  if (context.paceTrend === "slowing") moodWords.push("easing");
  if (context.autopilotState === "active") moodWords.push("low-distraction");

  // Adaptive Drive Mode override (comfort feature — biases selection only, never controls the car).
  // Calm takes energy down and leans familiar/instrumental; focus lifts energy to fight monotony.
  let intensityLabel = profile.intensity;
  // Archetype familiarity bias first (errand/commute lean familiar); calm/family overrides below
  // still win on top of it.
  let tasteWeight = clamp01(
    (context.tasteWeight ?? 0) + strategy.tasteWeightBias,
  );
  const driveMode: DriveMode = assessment?.mode ?? "neutral";
  if (assessment?.mode === "calm") {
    targetEnergy = clamp01(targetEnergy - 0.2 * assessment.intensity);
    intensityLabel = "warm";
    tasteWeight = clamp01(tasteWeight + 0.15);
    moodWords.push("calm", "warm", "instrumental-leaning");
  } else if (assessment?.mode === "focus") {
    targetEnergy = clamp01(targetEnergy + 0.12);
    moodWords.push("alert", "engaging", "forward");
  }

  if (context.passengerMode === "family") {
    targetEnergy = clamp01(Math.max(0.62, Math.min(0.78, targetEnergy + 0.08)));
    intensityLabel = "bright";
    tasteWeight = clamp01(Math.min(tasteWeight, 0.45));
    moodWords.push("clean", "upbeat", "singalong", "good-mood", "current-pop");
  } else if (context.passengerMode === "friends") {
    // A car full of adults: crowd-pleasing and singalong-friendly, a touch more upbeat. Lean toward
    // broadly-known so everyone recognizes enough, but looser than family (still room for taste).
    targetEnergy = clamp01(targetEnergy + 0.05);
    tasteWeight = clamp01(Math.min(tasteWeight, 0.6));
    moodWords.push("upbeat", "singalong", "crowd-pleasing");
  } else if (context.passengerMode === "couple") {
    // Two people: warmer and more intimate, a touch calmer, with room for shared discovery (no
    // taste cap) — the opposite social texture from a friends carful.
    targetEnergy = clamp01(targetEnergy - 0.04);
    moodWords.push("warm", "intimate");
  }

  // "Kids am Steuer": lean into Disney/film/animated singalongs kids adore (still clean), independent
  // of passengerMode — a parent can flip it on a solo-with-kids drive too.
  if (context.kidsMode) {
    targetEnergy = clamp01(Math.max(0.6, Math.min(0.8, targetEnergy + 0.06)));
    intensityLabel = "bright";
    tasteWeight = clamp01(Math.min(tasteWeight, 0.35));
    moodWords.push("disney", "movie", "animated", "kids", "singalong", "fun");
  }

  // Fatigue-aware floor — applied last so it wins on the energy lower bound,
  // even after Adaptive Drive Mode "calm" lowered the character.
  const energyFloor = alertnessFloor(
    band,
    context.elapsedMinutes ?? 0,
    context.paceTrend,
    context.speedBucket,
  );
  const fatigueRisk =
    energyFloor > 0
      ? clamp01((energyFloor - ALERTNESS_FLOOR_BASE) / ALERTNESS_FLOOR_SLOPE)
      : 0;
  targetEnergy = Math.max(targetEnergy, energyFloor);
  if (energyFloor > 0) moodWords.push("alert", "wakeful");

  // Telemetry fusion: a single energy stellschraube. Heavy traffic dampens energy
  // (unless a wake-up bias is active); the vibe/story energyBias shifts it directly.
  const trafficDamp =
    typeof context.trafficDelayMinutes === "number" &&
    context.trafficDelayMinutes >= 10 &&
    (context.energyBias ?? 0) < 0.1
      ? 0.1
      : 0;
  const fusedBias = Math.max(
    -0.3,
    Math.min(0.3, (context.energyBias ?? 0) - trafficDamp),
  );
  targetEnergy = Math.max(0.1, Math.min(1, targetEnergy + fusedBias));

  const focusLevel = clamp01(
    (context.phase === "focus" ? 0.75 : 0.35) +
      (context.autopilotState === "active" ? 0.15 : 0),
  );
  const socialEnergy =
    context.passengerMode === "family"
      ? "friendly"
      : context.passengerMode === "couple"
        ? "intimate"
        : context.passengerMode === "friends"
          ? "social"
          : "solo";
  // Each curve point is clamped to [energyFloor, 1] so the alertness floor
  // propagates across the whole five-track set, not just the target.
  const curvePoint = (delta: number): number =>
    Math.min(1, Math.max(energyFloor, targetEnergy + delta));
  const energyCurve = strategy.compressOpening
    ? // Errand short-circuit: a short hop has no time for a slow build — stay near target the
      // whole way and get straight to beloved songs.
      [
        curvePoint(0),
        curvePoint(0.02),
        curvePoint(0),
        curvePoint(0.02),
        curvePoint(0),
      ]
    : arc.segment === "closing"
      ? [
          curvePoint(0),
          curvePoint(0.05),
          curvePoint(0),
          curvePoint(-0.08),
          curvePoint(-0.16),
        ]
      : arc.segment === "opening"
        ? [
            curvePoint(-0.08),
            curvePoint(0),
            curvePoint(0.06),
            curvePoint(0),
            curvePoint(0.02),
          ]
        : arc.segment === "deep"
          ? [
              curvePoint(0),
              curvePoint(0.02),
              curvePoint(0),
              curvePoint(0.03),
              curvePoint(-0.02),
            ]
          : [
              curvePoint(0),
              curvePoint(0.04),
              curvePoint(-0.02),
              curvePoint(0.08),
              curvePoint(-0.06),
            ];
  const driveSignals = [
    context.phase,
    context.speedBucket,
    context.temperatureBucket,
    context.paceTrend,
    context.etaTrend,
    context.autopilotState,
    band === "deep_night" || band === "night" ? "night" : undefined,
    socialEnergy,
    typeof context.trafficDelayMinutes === "number" &&
    context.trafficDelayMinutes >= 10
      ? "heavy_traffic"
      : undefined,
    context.accelStyle,
    context.quietCabin ? "quiet_cabin" : undefined,
  ].filter((value): value is string => Boolean(value));
  const genres =
    context.passengerMode === "family"
      ? [
          "pop",
          "dance-pop",
          // "soundtrack" lets Disney/animated-film singalongs out of the pure-pop cage for the kids.
          "soundtrack",
          "disco/funk",
          "latin pop",
          "indie pop",
        ]
      : uniqueNormalizedTags([
          ...primaryMood.genres,
          ...(secondaryMood ? secondaryMood.genres : []),
          ...deriveGenres(targetEnergy),
        ]).slice(0, 6);

  return {
    targetEnergy,
    energyCurve,
    intensity: intensityLabel,
    focusLevel,
    socialEnergy,
    eras: "1970s through current releases",
    genres,
    regionHint: context.coarseRegion || context.destination,
    moodWords: [...new Set(moodWords)],
    driveSignals,
    destination: context.destination,
    countryName: context.countryName,
    localLanguage: localMusicFlavor(context.countryCode)?.language,
    localDemonym: localMusicFlavor(context.countryCode)?.demonym,
    userPrompt: context.userPrompt,
    passengerMode: context.passengerMode,
    kidsMode: context.kidsMode === true,
    // Roles of active/soft-applied wishes (e.g. "singalong") so lens selection can pivot generation.
    wishRoles: (context.activeMusicWishes ?? [])
      .filter(
        (wish) => wish.status === "active" || wish.status === "soft_applied",
      )
      .flatMap((wish) => wish.intents)
      .flatMap((intent) => (intent.type === "role" ? [intent.role] : [])),
    driveMode,
    driveReason:
      assessment?.mode && assessment.mode !== "neutral"
        ? assessment.reason
        : undefined,
    tasteWeight,
    favoredGenres: context.tasteProfile?.topGenres ?? [],
    representativeArtists: context.tasteProfile?.representativeArtists ?? [],
    valence,
    timeBand: band,
    tripSegment: arc.segment,
    tripArchetype: archetype,
    dayContext: dayCtx.daypartKey,
    legIndex: context.legIndex,
    nowPlaying: context.nowPlaying,
    moodKey: mood.primary,
    fatigueRisk,
    weatherFeel: context.weatherFeel,
    explorationAngle: context.varietyAngle,
    avoidRecentArtists: context.recentlyPlayedArtists ?? [],
    skippedMoodTags: context.skippedMoodTags ?? [],
    storyDirective: context.storyDirective,
    momentDirective: context.momentDirective,
    currentReleases: context.currentReleases,
  };
}

export interface SongLens {
  key: string;
  /** When true the lens uses Google Search grounding (current data); false = model knowledge. */
  grounded: boolean;
  instruction: string;
}

export const DEFAULT_LENSES: SongLens[] = [
  {
    key: "current",
    grounded: true,
    instruction:
      "Focus on current, recently released or charting tracks (roughly the last 24 months).",
  },
  {
    key: "classics",
    grounded: false,
    instruction:
      "Focus on timeless, iconic tracks spanning several past decades — beloved, well-known cuts.",
  },
  {
    key: "crossgenre",
    grounded: false,
    instruction:
      "Deliberately span diverse genres with surprising-but-fitting picks the listener may not expect.",
  },
  {
    key: "regional",
    grounded: true,
    instruction:
      "Geo soundtrack lens: use web search to find music with a REAL connection to the journey's region, route and destination — artists born or based there, songs naming these places or landscapes, local scenes. The drive should sound like the geography it passes through. ONLY real music — never audio dramas, Hörspiele, audiobooks or spoken-word.",
  },
];

const CINEMATIC_LENSES: Record<string, SongLens> = {
  cinematic_warmth: {
    key: "cinematic_warmth",
    grounded: false,
    instruction:
      "Find emotionally warm, cinematic songs that make the drive feel filmed without becoming sleepy.",
  },
  steady_momentum: {
    key: "steady_momentum",
    grounded: false,
    instruction:
      "Find songs with forward motion and clean rhythmic confidence for the current road pace.",
  },
  regional_texture: {
    key: "regional_texture",
    grounded: true,
    instruction:
      "Geo soundtrack lens: use web search to find music with a REAL connection to the journey's region, route and destination — artists born or based there, songs naming these places or landscapes, local scenes. The drive should sound like the geography it passes through. ONLY real music — never audio dramas, Hörspiele, audiobooks or spoken-word.",
  },
  local_language_hits: {
    key: "local_language_hits",
    grounded: true,
    instruction:
      "Local-language lens: use web search to find currently-loved, well-produced songs sung in the journey country's OWN language by homegrown artists from there — the kind locals actually play right now, across genres. Make the car feel like it belongs in this place. ONLY real music — never audio dramas, Hörspiele, audiobooks, spoken-word, anthems or tourist clichés.",
  },
  timeless_anchor: {
    key: "timeless_anchor",
    grounded: false,
    instruction:
      "Find one or two durable, familiar anchors from past decades that stabilize the set.",
  },
  leftfield_bridge: {
    key: "leftfield_bridge",
    grounded: false,
    instruction:
      "Find surprising cross-genre bridges that still connect smoothly to the drive mood.",
  },
  low_distraction: {
    key: "low_distraction",
    grounded: false,
    instruction:
      "Find focused, low-distraction tracks with steady pulse and minimal lyrical clutter.",
  },
  resolving_arrival: {
    key: "resolving_arrival",
    grounded: false,
    instruction:
      "Find graceful resolution tracks for approaching the destination without draining energy.",
  },
  current_pop_hits: {
    key: "current_pop_hits",
    grounded: true,
    instruction:
      "Find current, clean, widely known pop or dance-pop songs with broad all-ages appeal.",
  },
  good_mood: {
    key: "good_mood",
    grounded: false,
    instruction:
      "Find upbeat, sunny, feel-good songs that are easy to enjoy in a car with family.",
  },
  singalong_classics: {
    key: "singalong_classics",
    grounded: false,
    instruction:
      "Find familiar clean singalong pop classics that children and adults can both recognize.",
  },
  kids_hits: {
    key: "kids_hits",
    grounded: true,
    instruction:
      "Kids mode: find clean, joyful, widely-loved singalong hits from Disney / Pixar / animated films and modern family movie soundtracks that BOTH children and adults enjoy in the car. Real, well-produced songs only — no lo-fi nursery rhymes, no 'Folge/Kapitel/Teil N' audio-drama episodes, nothing babyish or annoying to adults.",
  },
  taste_anchor: {
    key: "taste_anchor",
    grounded: false,
    instruction:
      "Find one familiar anchor that lightly reflects listener taste without becoming niche.",
  },
  deep_cuts: {
    key: "deep_cuts",
    grounded: true,
    instruction:
      "Explorer lens: NO global superstars or evergreen chart staples. Surface B-sides, album deep cuts, regional music scenes and fresh releases that genuinely fit the mood. Every artist must be distinct, lesser-known, and NOT on the avoid list. ONLY real music — never audio dramas, Hörspiele, audiobooks or spoken-word episodes.",
  },
};

export function selectJourneyLenses(
  brief: MusicalBrief,
  options: { includeDeepCuts?: boolean } = {},
): SongLens[] {
  const picked: SongLens[] = [];
  const add = (key: keyof typeof CINEMATIC_LENSES): void => {
    const lens = CINEMATIC_LENSES[key];
    if (!picked.some((item) => item.key === lens.key)) picked.push(lens);
  };

  // "Kids am Steuer" leads with the Disney/film singalong lens, then the all-ages good-mood set.
  if (brief.kidsMode) {
    add("kids_hits");
    add("singalong_classics");
    add("good_mood");
    add("current_pop_hits");
    add("taste_anchor");
    return picked.slice(0, 5);
  }

  if (brief.passengerMode === "family") {
    add("current_pop_hits");
    add("good_mood");
    // A family car has kids: seed the Disney/animated singalong lens high (web-grounded) so beloved
    // kid hits reliably surface, while current pop + good mood still keep adult appeal.
    add("kids_hits");
    if (brief.regionHint || brief.countryName) add("local_language_hits");
    add("singalong_classics");
    if (brief.regionHint || brief.countryName) add("regional_texture");
    add("taste_anchor");
    return picked.slice(0, 5);
  }

  // Errand: a short hop wants beloved, familiar songs fast — no slow regional discovery or
  // deliberate leftfield surprises. Lead with the situational primer, then anchor in known taste.
  // Fewer lenses also means fewer parallel calls, so short-trip refills stay snappy.
  if (brief.tripArchetype === "errand") {
    if (brief.driveMode === "calm") add("cinematic_warmth");
    else add("steady_momentum");
    add("current_pop_hits");
    add("timeless_anchor");
    add("taste_anchor");
    return picked.slice(0, 5);
  }

  // Adaptive Drive Mode primes the first lens toward the situation.
  if (brief.driveMode === "calm") add("cinematic_warmth");
  else if (brief.driveMode === "focus") add("steady_momentum");

  // Active music-wish roles steer generation toward the wished vibe (not just ranking). Seeded high
  // so the matching lens survives the five-lens cap, e.g. "Mitsingen" → real singalong candidates.
  const wishRoles = new Set(brief.wishRoles ?? []);
  if (wishRoles.has("singalong")) {
    add("singalong_classics");
    add("good_mood");
  }
  if (wishRoles.has("kids")) {
    add("kids_hits");
    add("singalong_classics");
  }
  if (wishRoles.has("wake_up")) add("current_pop_hits");
  if (wishRoles.has("calm_down")) add("cinematic_warmth");

  // Social texture of the cabin (non-family/kids): a friends carful leans on crowd-pleasing good-mood
  // picks, a couple on warm/intimate ones. Seeded high so it survives the five-lens cap, but after any
  // Adaptive Drive Mode primer so safety/comfort still leads.
  if (brief.passengerMode === "friends") add("good_mood");
  else if (brief.passengerMode === "couple") add("cinematic_warmth");

  if (brief.focusLevel >= 0.7 || brief.moodWords.includes("low-distraction")) {
    add("low_distraction");
  } else if (
    brief.intensity === "cinematic" ||
    brief.moodWords.some((word) =>
      ["warm", "emotional", "sunlit", "expansive"].includes(word),
    )
  ) {
    add("cinematic_warmth");
  } else if (brief.intensity === "resolving" || brief.targetEnergy < 0.45) {
    add("resolving_arrival");
  } else {
    add("steady_momentum");
  }

  // Local touch: when we know where the drive is, guarantee a noticeable share of local-language /
  // homegrown picks by seeding the local lens high (so it survives the 5-lens cap) plus geo texture.
  if (brief.regionHint || brief.countryName) add("local_language_hits");

  if (brief.targetEnergy >= 0.5) add("steady_momentum");
  if (brief.regionHint) add("regional_texture");
  // Long hauls have room to wander: promote the discovery lens above the familiar anchor so it
  // reliably survives the five-lens cap instead of being crowded out.
  if (brief.tripArchetype === "long_haul" && brief.driveMode !== "calm") {
    add("leftfield_bridge");
  }
  add("timeless_anchor");
  // Calm drops the deliberate "surprise" lens — calmer situations want familiar, not leftfield.
  if (brief.driveMode !== "calm") add("leftfield_bridge");
  if (picked.length < 5) add("cinematic_warmth");
  if (picked.length < 5) add("resolving_arrival");

  const base = picked.slice(0, 5);
  if (options.includeDeepCuts) base.push(CINEMATIC_LENSES.deep_cuts);
  return base;
}

/**
 * Taste steering: the "crossgenre" lens is the discovery counterweight and stays neutral so the
 * set never collapses into an echo chamber. The other lenses lean toward the listener's favorite
 * genres in proportion to tasteWeight (a single number changes only prompt text — zero extra tokens).
 */
function tasteSteeringLine(lens: SongLens, brief: MusicalBrief): string {
  if (lens.key === "crossgenre") return "";
  if (brief.tasteWeight <= 0 || brief.favoredGenres.length === 0) return "";
  const familiarPct = Math.round(brief.tasteWeight * 100);
  const artistHint = brief.representativeArtists.length
    ? `, e.g. artists like ${brief.representativeArtists.join(", ")}`
    : "";
  return [
    `Listener taste: aim for roughly ${familiarPct}% of picks to lean toward their favorite genres`,
    `(${brief.favoredGenres.join(", ")}${artistHint});`,
    `keep the remaining ${100 - familiarPct}% as fresh discovery beyond their usual taste.`,
  ].join(" ");
}

/**
 * Plain-text Adaptive Drive Mode line injected into every lens prompt so Gemini *refines* the song
 * picks for the situation. Empty when neutral. Detection stays deterministic; this adds no LLM calls.
 */
export function driveModePromptLine(brief: MusicalBrief): string {
  if (brief.driveMode === "calm") {
    return `Driving context: ${brief.driveReason ?? "higher-attention situation"}. Favor calmer, familiar, instrumental-leaning tracks that reduce busyness; avoid frantic or dense, cluttered arrangements.`;
  }
  if (brief.driveMode === "focus") {
    return `Driving context: ${brief.driveReason ?? "long monotonous stretch"}. Favor engaging, forward-moving tracks that keep attention up; avoid sleepy or purely ambient picks.`;
  }
  return "";
}

/** One-line macro-strategy hint per trip archetype for the LLM. */
function archetypePromptHint(archetype: TripArchetype): string {
  switch (archetype) {
    case "errand":
      return "Short hop — go straight to beloved, familiar songs; no slow build.";
    case "commute":
      return "Routine drive — comfortable, momentum-keeping picks that wear well.";
    case "day_trip":
      return "A proper outing — shape a satisfying arc with a little discovery.";
    case "long_haul":
      return "Long journey — room to wander into deeper cuts and discovery.";
  }
}

export function buildLensPrompt(
  lens: SongLens,
  brief: MusicalBrief,
  count: number,
): string {
  // Concentrate the "local touch" in the geo lenses so the overall set stays international while a
  // noticeable share feels local. Names the language when the country is mapped, else lets the
  // grounded LLM infer the local language from the place.
  const isGeoLens =
    lens.key === "local_language_hits" || lens.key === "regional_texture";
  const localPlace = brief.countryName ?? brief.regionHint;
  const localTouchLine =
    isGeoLens && localPlace
      ? brief.localLanguage
        ? `Local touch: prioritize current, well-loved songs sung in ${brief.localLanguage} by homegrown ${brief.localDemonym} artists popular in ${localPlace} right now — make the set feel local without abandoning the listener's taste or sliding into tourist clichés.`
        : `Local touch: prioritize current, well-loved songs in the LOCAL LANGUAGE of ${localPlace} by homegrown artists from there — make the set feel local without tourist clichés.`
      : "";
  return [
    `You are Longplay curating the "${lens.key}" portion of a road-trip set.`,
    lens.instruction,
    `Target energy: ${brief.targetEnergy.toFixed(2)} (0=calm, 1=high). Five-track energy curve: ${brief.energyCurve.map((value) => value.toFixed(2)).join(" -> ")}.`,
    `Intensity: ${brief.intensity}. Focus level: ${brief.focusLevel.toFixed(2)}. Social energy: ${brief.socialEnergy}. Mood: ${brief.moodWords.join(", ")}.`,
    `Valence: ${brief.valence.toFixed(2)} (-1 dark … +1 bright). Mood profile: ${brief.moodKey} (${brief.timeBand}, ${brief.tripSegment}).`,
    `Trip shape: ${brief.tripArchetype} on a ${brief.dayContext.replace(/_/g, " ")}. ${archetypePromptHint(brief.tripArchetype)}`,
    typeof brief.legIndex === "number" && brief.legIndex > 0
      ? `This is leg ${brief.legIndex + 1} of the journey (after a charge stop) — open a fresh chapter with its own arc.`
      : "",
    brief.nowPlaying
      ? `Now playing: "${brief.nowPlaying.title}" by ${brief.nowPlaying.artist}. Make the next picks flow naturally from it — keep era/genre/energy continuity and avoid jarring transitions, but do NOT repeat this artist or song.`
      : "",
    `Drive signals: ${brief.driveSignals.join(", ")}.`,
    driveModePromptLine(brief),
    `Span eras (${brief.eras}) and vary genres broadly (e.g. ${brief.genres.join(", ")}).`,
    brief.regionHint ? `Region/destination context: ${brief.regionHint}.` : "",
    brief.countryName
      ? `Current country chart context: ${brief.countryName}.`
      : "",
    localTouchLine,
    brief.weatherFeel ? `Weather right now: ${brief.weatherFeel}.` : "",
    brief.explorationAngle
      ? `Freshness directive: ${brief.explorationAngle}.`
      : "",
    brief.storyDirective ? `Drive story: ${brief.storyDirective}` : "",
    brief.momentDirective ? `Moment: ${brief.momentDirective}` : "",
    brief.avoidRecentArtists && brief.avoidRecentArtists.length > 0
      ? `Avoid these recently played artists: ${brief.avoidRecentArtists.slice(0, 12).join(", ")}.`
      : "",
    brief.skippedMoodTags && brief.skippedMoodTags.length > 0
      ? `The listener has been skipping these moods/vibes this session — steer away from them: ${brief.skippedMoodTags.slice(0, 6).join(", ")}.`
      : "",
    tasteSteeringLine(lens, brief),
    `Listener mode: ${brief.passengerMode}. Direction: "${brief.userPrompt}".`,
    brief.kidsMode
      ? "Kids mode: clean, joyful, all-ages picks the WHOLE car enjoys — Disney/Pixar/animated-film and modern family-movie singalongs are explicitly welcome. Still NO explicit lyrics; avoid babyish nursery rhymes, audio-drama/Hörspiel episodes, and anything grating for adults."
      : brief.passengerMode === "family"
        ? "Family mode: prefer clean/radio-friendly current pop, dance-pop, upbeat singalong tracks; avoid explicit, aggressive, gloomy, sleepy, or novelty children-song picks."
        : "",
    lens.key === "current" && brief.currentReleases?.length
      ? `These tracks are confirmed real and current — prefer this stylistic neighborhood and never invent release dates: ${brief.currentReleases.slice(0, 12).join("; ")}.`
      : "",
    `For each song also give "energy" (0=calm … 1=high) and "valence" (-1=dark … +1=bright) — your honest read of how the recording actually feels. These sequence the set into a smooth arc, so be discerning rather than defaulting to the middle.`,
    `Return ONLY JSON {"songs":[{"artist","title","year","genre","reason","role","energy","valence"}]} with exactly ${count} real, released songs.`,
    `If you include role, use one of: ${SET_ROLES.join(", ")}.`,
    "Vary artists; no duplicates. Keep 'reason' to one short clause tying the pick to the drive.",
    "Never include streaming-service data, raw GPS coordinates, VINs, or user-library references.",
  ]
    .filter(Boolean)
    .join("\n");
}

function decadeOf(year?: number): string {
  return typeof year === "number" && year > 1900
    ? `${Math.floor(year / 10) * 10}s`
    : "unknown";
}

const GENRE_ENERGY_HINTS: Array<[RegExp, number]> = [
  [/\b(ambient|cinematic|downtempo|classical|folk|acoustic)\b/i, 0.3],
  [/\b(soul|jazz|r&b|funk)\b/i, 0.5],
  [/\b(indie|pop|disco|new wave)\b/i, 0.6],
  [/\b(electronic|house|techno|rock|hip-hop|hip hop)\b/i, 0.78],
];

/** Infer energy (0…1) from free text — genre/lens/reason — when no explicit estimate exists. */
function inferEnergyFromText(text: string): number {
  const match = GENRE_ENERGY_HINTS.find(([pattern]) => pattern.test(text));
  return match?.[1] ?? 0.55;
}

/**
 * Recording energy 0…1. Prefer the LLM's per-track estimate (a real read of the song) and fall
 * back to genre/lens/reason keywords only when it's missing.
 */
function inferredCandidateEnergy(candidate: SongCandidate): number {
  if (
    typeof candidate.energy === "number" &&
    Number.isFinite(candidate.energy)
  ) {
    return clamp01(candidate.energy);
  }
  return inferEnergyFromText(
    [candidate.genre, candidate.lens, candidate.reason]
      .filter(Boolean)
      .join(" "),
  );
}

/** Valence normalized to 0…1 (0=dark, 1=bright) for transition-distance math; 0.5 when unknown. */
function candidateValence01(candidate: SongCandidate): number {
  return typeof candidate.valence === "number" &&
    Number.isFinite(candidate.valence)
    ? clamp01((candidate.valence + 1) / 2)
    : 0.5;
}

/**
 * Order items into a listening arc: each position is pulled toward its target on the energy
 * curve while large energy/valence jumps between neighbours are penalized, so the set plays as a
 * shaped journey instead of a score-sorted list. Greedy and deterministic (O(n²); n is tiny).
 *
 * `keepFirst` pins the opener (a chosen anchor or priority slot); `baseIndex` offsets the curve
 * lookup so an appended tail continues an already-queued arc instead of restarting it.
 */
export function orderByEnergyArc<T>(
  items: T[],
  curve: number[],
  energyOf: (item: T) => number,
  valenceOf: (item: T) => number,
  options: { keepFirst?: boolean; baseIndex?: number } = {},
): T[] {
  if (items.length <= 2 || curve.length === 0) return [...items];
  const remaining = [...items];
  const ordered: T[] = [];
  const base = options.baseIndex ?? 0;
  if (options.keepFirst) {
    ordered.push(remaining.shift() as T);
  }
  while (remaining.length > 0) {
    const target =
      curve[(base + ordered.length) % curve.length] ?? curve[curve.length - 1];
    const prev = ordered[ordered.length - 1];
    const hasPrev = prev !== undefined;
    const prevEnergy = hasPrev ? energyOf(prev) : target;
    const prevValence = hasPrev ? valenceOf(prev) : 0.5;
    let bestIndex = 0;
    let bestCost = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const energy = energyOf(remaining[index]);
      const valence = valenceOf(remaining[index]);
      const curveCost = Math.abs(energy - target);
      const smoothCost = hasPrev
        ? Math.abs(energy - prevEnergy) + 0.5 * Math.abs(valence - prevValence)
        : 0;
      const cost = curveCost * 0.6 + smoothCost * 0.4;
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = index;
      }
    }
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  return ordered;
}

/**
 * Recording energy (0…1) for a resolved track — uses the estimate carried from the candidate,
 * else infers from the match reason and mood tags so pooled tracks still place sensibly.
 */
export function resolvedTrackEnergy(
  track: Pick<ResolvedTrack, "energy" | "matchReason" | "moodTags">,
): number {
  if (typeof track.energy === "number" && Number.isFinite(track.energy)) {
    return clamp01(track.energy);
  }
  return inferEnergyFromText(
    `${track.matchReason ?? ""} ${(track.moodTags ?? []).join(" ")}`,
  );
}

/** Valence normalized to 0…1 for a resolved track; 0.5 when unknown. */
export function resolvedTrackValence01(
  track: Pick<ResolvedTrack, "valence">,
): number {
  return typeof track.valence === "number" && Number.isFinite(track.valence)
    ? clamp01((track.valence + 1) / 2)
    : 0.5;
}

/** The intended five-point energy arc for a drive context — exposed for downstream sequencing. */
export function energyCurveForContext(context: JourneyContext): number[] {
  return buildMusicalBrief(context).energyCurve;
}

function genreKey(candidate: SongCandidate): string {
  return normalizeText(candidate.genre ?? "unknown");
}

interface ScoreWeights {
  confidence: number;
  contextFit: number;
  telemetryFit: number;
  tasteFit: number;
  diversityGain: number;
  novelty: number;
  fatiguePenalty: number;
}

const BASE_SCORE_WEIGHTS: ScoreWeights = {
  confidence: 0.22,
  contextFit: 0.22,
  telemetryFit: 0.22,
  tasteFit: 0.1,
  diversityGain: 0.16,
  novelty: 0.08,
  fatiguePenalty: 0.18,
};

/**
 * Curation is not one-size-fits-all: a calm, high-attention drive wants familiar and unsurprising
 * picks, a focus stretch wants energy continuity, an errand wants beloved known songs, and a long
 * haul has room to wander. Shift the scoring emphasis accordingly instead of using fixed weights.
 */
function scoringWeights(brief: MusicalBrief): ScoreWeights {
  const w = { ...BASE_SCORE_WEIGHTS };
  if (brief.driveMode === "calm") {
    // Higher-attention situation: lean on fit/taste, dial down surprise.
    w.contextFit += 0.04;
    w.tasteFit += 0.04;
    w.diversityGain -= 0.04;
    w.novelty -= 0.04;
  } else if (brief.driveMode === "focus") {
    // Long monotonous stretch: prize energy continuity, ease off novelty churn.
    w.telemetryFit += 0.05;
    w.novelty -= 0.03;
    w.diversityGain -= 0.02;
  }
  if (brief.tripArchetype === "errand") {
    // Short hop: beloved and known, fast — not the moment for discovery.
    w.tasteFit += 0.05;
    w.confidence += 0.03;
    w.novelty -= 0.05;
    w.diversityGain -= 0.03;
  } else if (brief.tripArchetype === "long_haul") {
    // Room to roam: reward freshness and spread over playing it safe.
    w.novelty += 0.05;
    w.diversityGain += 0.05;
    w.confidence -= 0.04;
  }
  if (brief.passengerMode === "family" || brief.kidsMode) {
    // Whole-car appeal: minimize leftfield novelty, lean on broad fit.
    w.novelty -= 0.05;
    w.contextFit += 0.04;
  } else if (brief.passengerMode === "friends") {
    // Group of adults: nudge toward broadly-fitting crowd-pleasers.
    w.contextFit += 0.02;
  } else if (brief.passengerMode === "couple") {
    // Two people: lean on shared taste with a gentle dose of variety.
    w.tasteFit += 0.03;
    w.diversityGain += 0.02;
  }
  for (const key of Object.keys(w) as Array<keyof ScoreWeights>) {
    w[key] = Math.max(0, w[key]);
  }
  return w;
}

function candidateNovelty(
  candidate: SongCandidate,
  role: SongCandidateRole,
): number {
  const year = candidate.year ?? 0;
  const currentBoost = year >= new Date().getFullYear() - 2 ? 0.18 : 0;
  const oldAnchorBoost =
    role === "anchor" && year > 1900 && year < 2000 ? 0.1 : 0;
  const surpriseBoost =
    role === "surprise" || candidate.lens === "leftfield_bridge" ? 0.18 : 0;
  return clamp01(0.45 + currentBoost + oldAnchorBoost + surpriseBoost);
}

function scoreForRole(
  candidate: SongCandidate,
  brief: MusicalBrief,
  role: SongCandidateRole,
  index: number,
  usedArtists: Map<string, number>,
  usedGenres: Map<string, number>,
  usedDecades: Map<string, number>,
): SongCandidateScores {
  const genre = genreKey(candidate);
  const artist = normalizeText(candidate.artist);
  const decade = decadeOf(candidate.year);
  const roleEnergy =
    brief.energyCurve[index % brief.energyCurve.length] ?? brief.targetEnergy;
  const energyFit =
    1 - Math.abs(inferredCandidateEnergy(candidate) - roleEnergy);
  const contextFit = brief.genres.some(
    (item) =>
      genre.includes(normalizeText(item)) ||
      normalizeText(item).includes(genre),
  )
    ? 0.88
    : brief.moodWords.some((word) =>
          normalizeText(candidate.reason).includes(normalizeText(word)),
        )
      ? 0.72
      : 0.58;
  const tasteFit =
    brief.favoredGenres.length === 0
      ? 0.5
      : brief.favoredGenres.some((item) => genre.includes(normalizeText(item)))
        ? 0.85
        : 0.42;
  const diversityGain = clamp01(
    0.42 +
      (usedArtists.has(artist) ? -0.45 : 0.25) +
      (usedGenres.has(genre) ? -0.25 : 0.2) +
      (usedDecades.has(decade) ? -0.08 : 0.08),
  );
  const novelty = candidateNovelty(candidate, role);
  const fatiguePenalty = clamp01(
    (usedArtists.get(artist) ?? 0) * 0.55 +
      (usedGenres.get(genre) ?? 0) * 0.18 +
      (usedDecades.get(decade) ?? 0) * 0.05,
  );
  const telemetryFit = clamp01(
    energyFit +
      (brief.focusLevel >= 0.7 && inferredCandidateEnergy(candidate) <= 0.65
        ? 0.08
        : 0),
  );
  const w = scoringWeights(brief);
  const total = clamp01(
    candidate.confidence * w.confidence +
      contextFit * w.contextFit +
      telemetryFit * w.telemetryFit +
      tasteFit * w.tasteFit +
      diversityGain * w.diversityGain +
      novelty * w.novelty -
      fatiguePenalty * w.fatiguePenalty,
  );
  return {
    contextFit,
    telemetryFit,
    tasteFit,
    diversityGain,
    novelty,
    fatiguePenalty,
    total,
  };
}

export function buildJourneySet(
  candidates: SongCandidate[],
  brief: MusicalBrief,
  count: number,
): SongCandidate[] {
  const seenSongs = new Set<string>();
  const pool: SongCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.isrc
      ? `isrc:${candidate.isrc}`
      : songKey(candidate.artist, candidate.title);
    if (seenSongs.has(key)) continue;
    seenSongs.add(key);
    pool.push(candidate);
  }

  const selected: SongCandidate[] = [];
  const usedArtists = new Map<string, number>();
  const usedGenres = new Map<string, number>();
  const usedDecades = new Map<string, number>();

  while (selected.length < count && pool.length > 0) {
    const role = SET_ROLES[selected.length % SET_ROLES.length];
    const enforceArtistDiversity = selected.length < Math.min(count, 5);
    const enforceGenreDiversity = selected.length < Math.min(count, 5);
    let bestIndex = -1;
    let bestScores: SongCandidateScores | undefined;
    let bestScore = -Infinity;

    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index];
      const artist = normalizeText(candidate.artist);
      const genre = genreKey(candidate);
      if (
        enforceArtistDiversity &&
        usedArtists.has(artist) &&
        pool.some((item) => !usedArtists.has(normalizeText(item.artist)))
      ) {
        continue;
      }
      if (
        enforceGenreDiversity &&
        usedGenres.has(genre) &&
        pool.some((item) => !usedGenres.has(genreKey(item)))
      ) {
        continue;
      }
      const scores = scoreForRole(
        candidate,
        brief,
        role,
        selected.length,
        usedArtists,
        usedGenres,
        usedDecades,
      );
      if (scores.total > bestScore) {
        bestIndex = index;
        bestScore = scores.total;
        bestScores = scores;
      }
    }

    if (bestIndex === -1) {
      bestIndex = 0;
      bestScores = scoreForRole(
        pool[0],
        brief,
        role,
        selected.length,
        usedArtists,
        usedGenres,
        usedDecades,
      );
    }

    const [picked] = pool.splice(bestIndex, 1);
    const decorated: SongCandidate = {
      ...picked,
      role,
      scores: bestScores,
      telemetrySignals: brief.driveSignals,
      reason:
        picked.reason || `${role} for ${brief.intensity} ${brief.destination}`,
    };
    selected.push(decorated);
    const artist = normalizeText(decorated.artist);
    const genre = genreKey(decorated);
    const decade = decadeOf(decorated.year);
    usedArtists.set(artist, (usedArtists.get(artist) ?? 0) + 1);
    usedGenres.set(genre, (usedGenres.get(genre) ?? 0) + 1);
    usedDecades.set(decade, (usedDecades.get(decade) ?? 0) + 1);
  }

  // Sequence the chosen set along the energy curve so adjacent tracks flow (no whiplash), while
  // keeping the opener (the anchor) fixed. Roles follow final position.
  const sequenced = orderByEnergyArc(
    selected,
    brief.energyCurve,
    (candidate) => inferredCandidateEnergy(candidate),
    (candidate) => candidateValence01(candidate),
    { keepFirst: true },
  );
  return sequenced.map((candidate, index) => ({
    ...candidate,
    role: SET_ROLES[index % SET_ROLES.length],
  }));
}

/**
 * Deterministic diversity selection: dedupe, then greedily pick to spread across decades,
 * genres and artists so the set never collapses to one era/genre.
 */
export function balanceCandidates(
  candidates: SongCandidate[],
  _brief: MusicalBrief,
  count: number,
): SongCandidate[] {
  const seen = new Set<string>();
  const pool: SongCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.isrc
      ? `isrc:${candidate.isrc}`
      : `${normalizeText(candidate.artist)}::${normalizeText(candidate.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(candidate);
  }

  const selected: SongCandidate[] = [];
  const usedDecades = new Map<string, number>();
  const usedGenres = new Map<string, number>();
  const usedArtists = new Map<string, number>();

  while (selected.length < count && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const decade = decadeOf(candidate.year);
      const genre = (candidate.genre ?? "unknown").toLowerCase();
      const artist = normalizeText(candidate.artist);
      // Lower repetition counts -> higher diversity score; confidence breaks ties.
      const score =
        -3 * (usedDecades.get(decade) ?? 0) -
        3 * (usedGenres.get(genre) ?? 0) -
        5 * (usedArtists.get(artist) ?? 0) +
        candidate.confidence;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [picked] = pool.splice(bestIndex, 1);
    selected.push(picked);
    const decade = decadeOf(picked.year);
    const genre = (picked.genre ?? "unknown").toLowerCase();
    const artist = normalizeText(picked.artist);
    usedDecades.set(decade, (usedDecades.get(decade) ?? 0) + 1);
    usedGenres.set(genre, (usedGenres.get(genre) ?? 0) + 1);
    usedArtists.set(artist, (usedArtists.get(artist) ?? 0) + 1);
  }

  return selected;
}

async function geminiRequestText(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(
      `Gemini request failed with ${response.status}: ${responseBody}`,
    );
  }
  const text = extractGeminiText(JSON.parse(responseBody));
  if (!text) {
    throw new Error("Gemini response did not include text.");
  }
  return text;
}

export interface MultiLensSongScoutOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mock: boolean;
  lenses?: SongLens[];
  /** Songs requested per lens (cost lever — keep small). */
  perLensCount?: number;
  /** Output-token cap per lens call (cost lever). */
  maxOutputTokens?: number;
  /** Appends the deep_cuts explorer lens (extra grounded call) when true. */
  includeDeepCuts?: boolean;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: overrides the real Gemini call per lens. */
  lensRunner?: (
    lens: SongLens,
    brief: MusicalBrief,
    count: number,
  ) => Promise<SongCandidate[]>;
}

/**
 * Telemetry-driven, multi-lens song scout. Builds a deterministic brief, runs several lenses
 * in parallel (current/classics/cross-genre/regional), then balances for diversity.
 */
export class MultiLensSongScout implements SongScout {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly perLensCount: number;
  private readonly maxOutputTokens: number;

  constructor(private readonly options: MultiLensSongScoutOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_SCOUT_TIMEOUT_MS;
    this.perLensCount = options.perLensCount ?? 5;
    this.maxOutputTokens = options.maxOutputTokens ?? 2048;
  }

  async generateCandidates(
    context: JourneyContext,
    targetCount: number,
  ): Promise<SongCandidate[]> {
    if (this.options.mock || !this.options.apiKey) {
      return fallbackCandidates(context, targetCount);
    }

    try {
      assertJourneyContextIsPrivacySafe(context);
      const brief = buildMusicalBrief(context);
      const runner =
        this.options.lensRunner ??
        ((lens, b, count) => this.runLens(lens, b, count));
      const lenses =
        this.options.lenses ??
        selectJourneyLenses(brief, {
          includeDeepCuts: this.options.includeDeepCuts,
        });
      const settled = await Promise.all(
        lenses.map((lens) =>
          runner(lens, brief, this.perLensCount).catch(
            () => [] as SongCandidate[],
          ),
        ),
      );
      const all = settled.flat();
      if (all.length === 0) {
        return fallbackCandidates(context, targetCount);
      }
      const balanced = buildJourneySet(all, brief, targetCount);
      return balanced.length > 0
        ? balanced
        : fallbackCandidates(context, targetCount);
    } catch {
      return fallbackCandidates(context, targetCount);
    }
  }

  private async runLens(
    lens: SongLens,
    brief: MusicalBrief,
    count: number,
  ): Promise<SongCandidate[]> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/models/${this.options.model}:generateContent`;
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }] },
      contents: [
        {
          role: "user",
          parts: [{ text: buildLensPrompt(lens, brief, count) }],
        },
      ],
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: this.maxOutputTokens,
        // Flash "thinking" otherwise eats the output budget (MAX_TOKENS with empty JSON) and bills
        // extra tokens. Song lists need no reasoning trace — disable it: cheaper, faster, complete.
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    if (lens.grounded) {
      body.tools = [{ google_search: {} }];
    }
    const text = await geminiRequestText(
      url,
      body,
      this.options.apiKey!,
      this.requestTimeoutMs,
      this.fetchImpl,
    );
    const parsed = tryParseCandidateJson(text, count, "gemini") ?? [];
    return parsed.map((candidate) => ({ ...candidate, lens: lens.key }));
  }
}

function resolveCandidatesFromModelText(
  text: string,
  context: JourneyContext,
  targetCount: number,
  source: SongCandidate["source"],
): SongCandidate[] {
  const parsed = tryParseCandidateJson(text, targetCount, source);
  if (parsed && parsed.length >= targetCount) {
    return buildJourneySet(parsed, buildMusicalBrief(context), targetCount);
  }

  if (parsed && parsed.length > 0) {
    const padded = [
      ...parsed,
      ...fallbackCandidates(context, targetCount - parsed.length),
    ];
    return buildJourneySet(
      padded.map((item) => ({ ...item, source })),
      buildMusicalBrief(context),
      targetCount,
    );
  }

  return fallbackCandidates(context, targetCount);
}

export function parseCandidateJson(
  content: string,
  targetCount: number,
  source: SongCandidate["source"] = "grok",
): SongCandidate[] {
  const parsed = tryParseCandidateJson(content, targetCount, source);
  if (!parsed || parsed.length === 0) {
    throw new SyntaxError(
      "Model response did not include parseable song JSON.",
    );
  }
  return parsed;
}

export function fallbackCandidates(
  context: JourneyContext,
  targetCount: number,
): SongCandidate[] {
  const phaseOffset = Math.abs(
    normalizeText(context.phase)
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0),
  );
  // Kids inherits family's all-ages pool (same familyMode logic as buildRecommendationPolicy) so a
  // solo-with-kids drive that falls back still gets curated all-ages picks, not the generic pool.
  const familyMode =
    context.passengerMode === "family" || context.kidsMode === true;
  const fallbackPool = familyMode
    ? FAMILY_FALLBACK_CANDIDATES
    : FALLBACK_CANDIDATES;
  const candidates = [...fallbackPool]
    .slice(phaseOffset % 3)
    .concat(fallbackPool)
    .slice(0, targetCount)
    .map((candidate) => ({
      ...candidate,
      reason: `${candidate.reason}; selected for ${context.phase} toward ${context.destination}`,
    }));
  return buildJourneySet(candidates, buildMusicalBrief(context), targetCount);
}

export function selectRollingBatch<T extends ResolvedTrack>(
  resolvedTracks: T[],
  alreadyAddedProviderIds: Set<string>,
  batchSize = 5,
): T[] {
  const seen = new Set(alreadyAddedProviderIds);
  const selected: T[] = [];

  for (const track of resolvedTracks) {
    if (seen.has(track.providerTrackId)) continue;
    seen.add(track.providerTrackId);
    selected.push(track);
    if (selected.length === batchSize) break;
  }

  return selected;
}

export {
  applyMusicWishesToPolicy,
  avoidSongKeysForWish,
  candidatesFromMusicWishes,
  directSongKeysForWish,
  musicWishSummary,
  parseMusicWish,
  roleTagsForWish,
  type MusicWishIntent,
  type MusicWishSource,
  type MusicWishStatus,
  type ParsedMusicWish,
} from "./musicWish.js";

export {
  EXPLORATION_ANGLES,
  hashString,
  makeVarietyContext,
  mulberry32,
  rotateWindow,
  seededExplorationAngle,
  seededJitter,
  type VarietyContext,
  type VarietyInput,
} from "./variety.js";

export {
  momentumRadioCandidates,
  similarRankWindow,
  type SimilarSource,
} from "./momentumRadio.js";

export {
  releaseRadarCandidates,
  isWithinFreshWindow,
  releaseAgeDays,
  type AlbumSource,
} from "./releaseRadar.js";

export { driveStoryAct, type StoryAct, type StoryBeat } from "./driveStory.js";

export { looksLikeSpokenWord } from "./spokenWord.js";
