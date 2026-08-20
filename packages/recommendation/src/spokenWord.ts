import { normalizeText } from "@longplay/core";

/**
 * Heuristic that flags spoken-word content — audio dramas (Hörspiele), audiobooks (Hörbücher),
 * readings, bedtime stories, podcasts — which a road-trip MUSIC director must never queue.
 *
 * German charts and the Last.fm similar graph are dominated by Hörspiele ("Die drei ???",
 * "Bibi Blocksberg", …); without this gate the long-tail v2 sources (geo charts, deep-cut explorer
 * lens, momentum radio) flood the queue with episodes. Tuned for high precision: structural episode
 * markers + audiobook keywords + a curated artist denylist, so real songs are not caught.
 *
 * Operates on normalized text (diacritics stripped: "Hörspiel" → "horspiel").
 */

/** Normalized names of prolific German Hörspiel / kids audio-drama franchises. */
const SPOKEN_WORD_ARTISTS = new Set<string>([
  "die drei", // "Die drei ???" and "Die drei !!!" both normalize to this
  "bibi blocksberg",
  "bibi und tina",
  "benjamin blumchen",
  "tkkg",
  "tkkg junior",
  "funf freunde",
  "die funf freunde",
  "was ist was",
  "pumuckl",
  "der kleine drache kokosnuss",
  "die schule der magischen tiere",
  "gregs tagebuch",
  "hanni und nanni",
  "der kleine rabe socke",
  "die olchis",
  "das magische baumhaus",
  "point whitmark",
  "die teufelskicker",
  "teufelskicker",
  "john sinclair",
  "offenbarung 23",
  "paw patrol",
  "peppa pig",
  "peppa wutz",
]);

/** Audiobook / audio-drama keywords (substring match on normalized text). */
const SPOKEN_WORD_KEYWORDS = [
  "horspiel",
  "horbuch",
  "ungekurzt",
  "gekurzt",
  "lesung",
  "podcast",
  "schlafgeschichte",
  "gute nacht geschichte",
  "gutenachtgeschichte",
];

/** Episode markers like "Folge 215", "Kapitel 1", "Teil 12", "Episode 3" — strong Hörspiel signal. */
const EPISODE_MARKER = /\b(folge|kapitel|episode|teil)\s+\d+/;

export function looksLikeSpokenWord(artist: string, title: string): boolean {
  const normArtist = normalizeText(artist);
  const normTitle = normalizeText(title);

  if (SPOKEN_WORD_ARTISTS.has(normArtist)) return true;

  for (const keyword of SPOKEN_WORD_KEYWORDS) {
    if (normArtist.includes(keyword) || normTitle.includes(keyword)) return true;
  }

  return EPISODE_MARKER.test(normTitle);
}
