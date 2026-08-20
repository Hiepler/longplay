import { buildMusicalBrief, MultiLensSongScout } from "@longplay/recommendation";

const scout = new MultiLensSongScout({
  apiKey: process.env.GEMINI_API_KEY,
  baseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
  model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  mock: false,
  perLensCount: 5,
  maxOutputTokens: 1024,
  requestTimeoutMs: 45_000
});

const context = {
  destination: "Dijon",
  coarseRegion: "Burgundy, France",
  localTimeIso: "2026-05-30T19:30:00.000Z",
  weatherFeel: "warm, clear golden-hour light",
  etaMinutes: 75,
  speedBucket: "highway",
  temperatureBucket: "warm",
  phase: "golden_hour",
  userPrompt: "cinematic golden-hour drive, focused but emotional",
  passengerMode: "couple",
  // Personalization signal (familiarity↔discovery). Try tasteWeight 0.25 vs 0.75 to feel the shift.
  tasteWeight: 0.75,
  tasteProfile: {
    topGenres: ["electronica", "indie", "psychedelic rock"],
    representativeArtists: ["Bonobo", "Tame Impala", "Khruangbin"]
  }
} as Parameters<MultiLensSongScout["generateCandidates"]>[0];

const brief = buildMusicalBrief(context);
console.log("BRIEF:", JSON.stringify({ energy: brief.targetEnergy, intensity: brief.intensity, genres: brief.genres, region: brief.regionHint }));

const startedAt = Date.now();
const songs = await scout.generateCandidates(context, 8);
console.log(`ms=${Date.now() - startedAt} source=${songs[0]?.source} count=${songs.length}`);
for (const song of songs) {
  console.log(`- ${song.artist} — ${song.title}${song.year ? ` (${song.year})` : ""} [${song.genre ?? "?"}|${song.lens ?? "?"}]  ·  ${song.reason}`);
}
