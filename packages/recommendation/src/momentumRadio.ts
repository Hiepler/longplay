import type { SongCandidate } from "@longplay/core";
import { normalizeText } from "@longplay/core";

import { mulberry32 } from "./variety.js";
import { looksLikeSpokenWord } from "./spokenWord.js";

/** Minimaler Last.fm-Ausschnitt, den das Radio braucht (testbar per Stub). */
export interface SimilarSource {
  getSimilarTracks(
    artist: string | undefined,
    title: string | undefined,
    limit?: number,
  ): Promise<Array<{ artist: string; title: string; match: number }>>;
  getSimilarArtists(artist: string | undefined, limit?: number): Promise<string[]>;
  getArtistTopTracks(
    artist: string | undefined,
    limit?: number,
  ): Promise<Array<{ artist: string; title: string; rank: number }>>;
}

/**
 * Popularitäts-Inversion: wählt `take` Ränge aus [min..max], deterministisch pro Seed.
 * Hoher tasteWeight verschiebt das Fenster zu min (vertraute Nachbarn), niedriger zu max.
 */
export function similarRankWindow(args: {
  tasteWeight: number;
  seed: number;
  min: number;
  max: number;
  take: number;
}): number[] {
  const span = Math.max(1, args.max - args.min);
  // tasteWeight=1 → start near min (familiar); tasteWeight=0 → start near mid/max (discovery)
  const base =
    args.min + Math.round((1 - Math.min(1, Math.max(0, args.tasteWeight))) * span * 0.5);
  const rng = mulberry32(args.seed >>> 0);
  // Rotation: shift within the half of span available above base, without wrapping past max
  const halfSpan = Math.max(1, Math.floor((args.max - base) * 0.4));
  const offset = Math.floor(rng() * halfSpan);
  const start = Math.min(base + offset, args.max - args.take + 1);
  const ranks: number[] = [];
  for (let i = 0; i < args.take; i += 1) {
    ranks.push(Math.min(start + i * 2, args.max));
  }
  return ranks;
}

export async function momentumRadioCandidates(args: {
  lastfm: SimilarSource;
  nowPlaying?: { artist: string; title: string };
  wishArtists?: string[];
  tasteArtists?: string[];
  tasteWeight: number;
  seed: number;
  bannedArtists: ReadonlySet<string>;
  moodTags: string[];
  limit: number;
  rankMin?: number;
  rankMax?: number;
}): Promise<SongCandidate[]> {
  const rankMin = args.rankMin ?? 5;
  const rankMax = args.rankMax ?? 30;
  const out: SongCandidate[] = [];
  const seenArtists = new Set<string>();

  const push = (artist: string, title: string, seedLabel: string, confidence: number) => {
    const key = normalizeText(artist);
    if (!artist || !title) return;
    if (args.bannedArtists.has(key) || seenArtists.has(key)) return;
    // The similar graph surfaces Hörspiele around German seeds — keep spoken-word out.
    if (looksLikeSpokenWord(artist, title)) return;
    seenArtists.add(key);
    out.push({
      artist,
      title,
      lens: `lastfm-similar:${seedLabel}`,
      reason: `Because you like ${seedLabel}`,
      source: "lastfm-similar",
      confidence,
      moodTags: args.moodTags,
    });
  };

  // Seed-Klasse 1: gerade gespielter Track → ähnliche Tracks im Rang-Fenster.
  if (args.nowPlaying?.artist && args.nowPlaying.title) {
    const sims = await args.lastfm.getSimilarTracks(
      args.nowPlaying.artist,
      args.nowPlaying.title,
      rankMax + 5,
    );
    const ranks = similarRankWindow({
      tasteWeight: args.tasteWeight,
      seed: args.seed,
      min: rankMin,
      max: Math.min(rankMax, Math.max(rankMin, sims.length)),
      take: 4,
    });
    for (const rank of ranks) {
      const item = sims[rank - 1];
      if (item) push(item.artist, item.title, args.nowPlaying.artist, 0.72);
    }
  }

  // Seed-Klasse 2: Wunsch-Artisten → eigene Top-Tracks + Nachbarn.
  for (const wishArtist of (args.wishArtists ?? []).slice(0, 2)) {
    const top = await args.lastfm.getArtistTopTracks(wishArtist, 10);
    const pick = top[(args.seed + out.length) % Math.max(1, top.length)];
    if (pick) push(pick.artist, pick.title, wishArtist, 0.74);
    const cousins = await args.lastfm.getSimilarArtists(wishArtist, rankMax + 5);
    const ranks = similarRankWindow({
      tasteWeight: args.tasteWeight,
      seed: args.seed + 13,
      min: rankMin,
      max: Math.min(rankMax, Math.max(rankMin, cousins.length)),
      take: 2,
    });
    for (const rank of ranks) {
      const cousin = cousins[rank - 1];
      if (!cousin) continue;
      const cousinTop = await args.lastfm.getArtistTopTracks(cousin, 5);
      const cut = cousinTop[(args.seed + rank) % Math.max(1, cousinTop.length)];
      if (cut) push(cut.artist, cut.title, wishArtist, 0.68);
    }
  }

  // Seed-Klasse 3: Taste-Profil → Nachbarschaft der Lieblings-Artisten.
  for (const tasteArtist of (args.tasteArtists ?? []).slice(0, 2)) {
    const cousins = await args.lastfm.getSimilarArtists(tasteArtist, rankMax + 5);
    const ranks = similarRankWindow({
      tasteWeight: args.tasteWeight,
      seed: args.seed + 29,
      min: rankMin,
      max: Math.min(rankMax, Math.max(rankMin, cousins.length)),
      take: 2,
    });
    for (const rank of ranks) {
      const cousin = cousins[rank - 1];
      if (!cousin) continue;
      const cousinTop = await args.lastfm.getArtistTopTracks(cousin, 5);
      const cut = cousinTop[(args.seed + rank) % Math.max(1, cousinTop.length)];
      if (cut) push(cut.artist, cut.title, tasteArtist, 0.66);
    }
  }

  return out.slice(0, args.limit);
}
