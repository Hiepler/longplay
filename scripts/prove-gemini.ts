import { GeminiSongScout } from "@longplay/recommendation";

const scout = new GeminiSongScout({
  apiKey: process.env.GEMINI_API_KEY,
  baseUrl: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
  model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  mock: false,
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
  passengerMode: "couple"
} as Parameters<GeminiSongScout["generateCandidates"]>[0];

const startedAt = Date.now();
const songs = await scout.generateCandidates(context, 8);
console.log(`ms=${Date.now() - startedAt} source=${songs[0]?.source} count=${songs.length}`);
for (const song of songs) {
  console.log(`- ${song.artist} — ${song.title}${song.year ? ` (${song.year})` : ""}  ·  ${song.reason}`);
}
