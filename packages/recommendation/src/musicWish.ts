import type {
  MusicWish,
  MusicWishIntent,
  MusicWishSource,
  MusicWishStatus,
  SongCandidate,
} from "@longplay/core";
import { normalizeText, songKey } from "@longplay/core";
import type { RecommendationPolicy } from "./index.js";

export type { MusicWishIntent, MusicWishSource, MusicWishStatus };

export interface ParsedMusicWish {
  rawText: string;
  status: "active" | "pending_confirmation";
  confidence: number;
  summary: string;
  intents: MusicWishIntent[];
}

const ROLE_PATTERNS: Array<{
  role: Extract<MusicWishIntent, { type: "role" }>["role"];
  patterns: string[];
}> = [
  { role: "singalong", patterns: ["mitsingen", "singalong", "karaoke"] },
  { role: "wake_up", patterns: ["wach", "aufwecken", "energie", "wieder wach", "wake", "energy"] },
  { role: "kids", patterns: ["kinder", "kids", "hinten", "backseat"] },
  { role: "calm_down", patterns: ["ruhiger", "calm", "runter", "entspannen"] },
];

const GENRE_TAGS: Record<string, string[]> = {
  "90s": ["90s", "classic pop"],
  pop: ["pop"],
  "dance pop": ["dance-pop", "pop"],
  "dance-pop": ["dance-pop", "pop"],
  disney: ["disney", "family", "singalong"],
  schlager: ["schlager", "party"],
};

const AMBIGUOUS_BARE_WISH_WORDS = new Set([
  "alle",
  "anders",
  "andere",
  "anderes",
  "beats",
  "bisschen",
  "etwas",
  "familie",
  "gute",
  "hinten",
  "irgendwie",
  "kids",
  "kinder",
  "langsam",
  "laune",
  "lieder",
  "lofi",
  "mehr",
  "musik",
  "party",
  "ruhig",
  "ruhiger",
  "songs",
  "vibe",
  "vibes",
  "wach",
  "was",
  "weniger",
  "wieder",
  "zum",
]);

function cleanSubject(value: string): string {
  return value
    .replace(/[.!?]+$/g, "")
    .replace(/^von\s+/i, "")
    .trim();
}

function titleCaseWords(value: string): string {
  return cleanSubject(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isLikelyBareArtistWish(value: string): boolean {
  const subject = cleanSubject(value);
  const words = subject.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  if (subject.length < 3 || subject.length > 64) return false;
  if (!words.every((word) => /^[\p{L}\p{N}'.&-]+$/u.test(word))) return false;

  const normalizedWords = words.map((word) => normalizeText(word));
  if (normalizedWords.some((word) => AMBIGUOUS_BARE_WISH_WORDS.has(word))) {
    return false;
  }
  if (GENRE_TAGS[normalizeText(subject)]) return false;

  const hasNameCasing = words.some((word) => /^[A-ZÄÖÜ0-9]/.test(word));
  return hasNameCasing || words.length >= 2;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled music wish variant: ${JSON.stringify(value)}`);
}

export function roleTagsForWish(
  role: Extract<MusicWishIntent, { type: "role" }>["role"],
): string[] {
  switch (role) {
    case "singalong":
      return ["pop", "dance-pop", "feelgood", "karaoke"];
    case "wake_up":
      return ["feelgood", "dance-pop", "pop rock"];
    case "kids":
      return ["family", "kids", "pop", "singalong"];
    case "calm_down":
      return ["mellow", "acoustic", "chillout"];
    default:
      return assertNever(role);
  }
}

export function musicWishSummary(intents: MusicWishIntent[]): string {
  const first = intents[0];
  if (!first) return "I'm not sure which music wish you mean.";
  if (first.type === "song") return `${first.immediate ? "Play now" : "More"} ${first.title}`;
  if (first.type === "artist") return `More ${first.artist}`;
  if (first.type === "genre") return `More ${first.genre}`;
  if (first.type === "mood") return `More ${first.moodTags.join(", ")}`;
  if (first.type === "role") {
    return {
      singalong: "More music to sing along to",
      wake_up: "More energy for the next songs",
      kids: "More music for the kids",
      calm_down: "Calmer for the next songs",
    }[first.role];
  }
  if (first.type === "tempo") {
    return first.direction === "faster"
      ? "Faster & more energetic"
      : "Slower & more relaxed";
  }
  if (first.type === "avoid") {
    const avoid = [
      ...(first.artists ?? []),
      ...(first.moodTags ?? []),
      ...(first.songKeys ?? []),
    ].join(", ");
    return avoid ? `Avoid ${avoid}` : "Avoid this vibe";
  }
  return assertNever(first);
}

export function parseMusicWish(rawText: string): ParsedMusicWish {
  const text = rawText.trim();
  const normalized = normalizeText(text);
  const intents: MusicWishIntent[] = [];

  const immediateMatch = text.match(/^(spiel|spiele|play)\s+(jetzt|sofort|now)\s+(.+)$/i);
  if (immediateMatch?.[3]) {
    const subject = cleanSubject(immediateMatch[3]);
    const artistTitle = subject.match(/^(.+)\s+-\s+(.+)$/);
    if (artistTitle?.[1] && artistTitle?.[2]) {
      intents.push({
        type: "song",
        artist: cleanSubject(artistTitle[1]),
        title: cleanSubject(artistTitle[2]),
        immediate: true,
      });
    } else {
      intents.push({ type: "song", title: subject, immediate: true });
    }
    return { rawText: text, status: "active", confidence: 0.9, summary: musicWishSummary(intents), intents };
  }

  const tempoFaster = /^(schneller|faster|mehr tempo|more tempo)\b/i.test(text);
  const tempoSlower = /^(langsamer|slower)\b/i.test(text);
  if (tempoFaster || tempoSlower) {
    intents.push({
      type: "tempo",
      direction: tempoFaster ? "faster" : "slower",
      strength: 0.8,
    });
    return {
      rawText: text,
      status: "active",
      confidence: 0.85,
      summary: musicWishSummary(intents),
      intents,
    };
  }

  const moreMatch = text.match(/^(mehr|more)\s+(.+)$/i);
  if (moreMatch?.[2]) {
    const subject = cleanSubject(moreMatch[2]);
    const key = normalizeText(subject);
    if (GENRE_TAGS[key]) {
      intents.push({ type: "mood", moodTags: GENRE_TAGS[key], strength: 0.82 });
    } else if (/pop|rock|schlager|disco|rap|hip hop|hip-hop/i.test(subject)) {
      intents.push({ type: "genre", genre: subject.toLowerCase(), strength: 0.78 });
    } else {
      intents.push({ type: "artist", artist: titleCaseWords(subject), strength: 0.9 });
    }
    return { rawText: text, status: "active", confidence: 0.82, summary: musicWishSummary(intents), intents };
  }

  const avoidMatch = text.match(/^(keine|kein|nicht|weniger|less|not|no)\s+(schon wieder\s+)?(.+)$/i);
  if (avoidMatch?.[3]) {
    const subject = cleanSubject(avoidMatch[3]);
    const key = normalizeText(subject);
    if (/langsam|ruhig|mellow|sleepy|schlaf|slow|calm|quiet/i.test(subject)) {
      intents.push({ type: "avoid", moodTags: ["mellow", "sleepy", "slow"] });
    } else if (GENRE_TAGS[key]) {
      intents.push({ type: "avoid", moodTags: GENRE_TAGS[key] });
    } else {
      intents.push({ type: "avoid", artists: [titleCaseWords(subject)] });
    }
    return { rawText: text, status: "active", confidence: 0.82, summary: musicWishSummary(intents), intents };
  }

  for (const entry of ROLE_PATTERNS) {
    if (entry.patterns.some((pattern) => normalized.includes(normalizeText(pattern)))) {
      intents.push({ type: "role", role: entry.role, strength: 0.86 });
      return { rawText: text, status: "active", confidence: 0.78, summary: musicWishSummary(intents), intents };
    }
  }

  const songLike = text.match(/^(.+)\s+-\s+(.+)$/);
  if (songLike?.[1] && songLike?.[2]) {
    intents.push({
      type: "song",
      artist: cleanSubject(songLike[1]),
      title: cleanSubject(songLike[2]),
      immediate: false,
    });
    return { rawText: text, status: "active", confidence: 0.74, summary: musicWishSummary(intents), intents };
  }

  if (isLikelyBareArtistWish(text)) {
    intents.push({ type: "artist", artist: titleCaseWords(text), strength: 0.86 });
    return { rawText: text, status: "active", confidence: 0.76, summary: musicWishSummary(intents), intents };
  }

  return {
    rawText: text,
    status: "pending_confirmation",
    confidence: 0.35,
    summary: musicWishSummary([]),
    intents,
  };
}

export function avoidSongKeysForWish(intents: MusicWishIntent[]): string[] {
  return intents.flatMap((intent) => (intent.type === "avoid" ? (intent.songKeys ?? []) : []));
}

export function directSongKeysForWish(intents: MusicWishIntent[]): string[] {
  return intents.flatMap((intent) =>
    intent.type === "song" ? [songKey(intent.artist ?? "", intent.title)] : [],
  );
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function applyMusicWishesToPolicy(
  policy: RecommendationPolicy,
  wishes: MusicWish[],
): RecommendationPolicy {
  const active = wishes.filter((wish) => wish.status === "active" || wish.status === "soft_applied");
  const artistBoosts = [...(policy.artistBoosts ?? [])];
  const avoidArtists = [...policy.avoidArtists];
  const avoidSongKeys = [...policy.avoidSongKeys];
  const avoidMoodTags = [...(policy.avoidMoodTags ?? [])];
  const moodTags = [...policy.moodTags];
  let allowArtistRepeats = policy.allowArtistRepeats ?? false;

  for (const wish of active) {
    for (const intent of wish.intents) {
      if (intent.type === "artist") {
        artistBoosts.push({ artist: intent.artist, strength: intent.strength });
        allowArtistRepeats = true;
      } else if (intent.type === "song") {
        moodTags.push("requested");
      } else if (intent.type === "genre") {
        moodTags.push(intent.genre);
      } else if (intent.type === "mood") {
        moodTags.push(...intent.moodTags);
      } else if (intent.type === "avoid") {
        avoidArtists.push(...(intent.artists ?? []));
        avoidSongKeys.push(...(intent.songKeys ?? []));
        avoidMoodTags.push(...(intent.moodTags ?? []));
      } else if (intent.type === "role") {
        moodTags.push(...roleTagsForWish(intent.role));
      } else if (intent.type === "tempo") {
        moodTags.push(
          ...(intent.direction === "faster"
            ? ["uptempo", "high-energy"]
            : ["mellow", "downtempo"]),
        );
      }
    }
  }

  return {
    ...policy,
    moodTags: unique(moodTags),
    avoidArtists: unique(avoidArtists),
    avoidSongKeys: unique(avoidSongKeys),
    avoidMoodTags: unique(avoidMoodTags),
    artistBoosts,
    allowArtistRepeats,
    preferDistinctArtists: allowArtistRepeats ? false : policy.preferDistinctArtists,
  };
}

export function candidatesFromMusicWishes(wishes: MusicWish[]): SongCandidate[] {
  const candidates: SongCandidate[] = [];
  for (const wish of wishes.filter((item) => item.status === "active" || item.status === "soft_applied")) {
    for (const intent of wish.intents) {
      if (intent.type === "song") {
        candidates.push({
          artist: intent.artist ?? "Unknown Artist",
          title: intent.title,
          lens: "music-wish-song",
          role: "anchor",
          reason: `Direct music wish: ${wish.rawText}`,
          source: "music-wish",
          confidence: intent.immediate ? 0.96 : 0.88,
          moodTags: ["requested"],
        });
      }
      if (intent.type === "artist") {
        candidates.push({
          artist: intent.artist,
          title: `${intent.artist} radio`,
          lens: "music-wish-artist",
          reason: `Artist boost from music wish: ${wish.rawText}`,
          source: "music-wish",
          confidence: 0.74,
          moodTags: ["requested"],
        });
      }
    }
  }
  return candidates;
}
