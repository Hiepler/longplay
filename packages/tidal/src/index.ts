import { createAPIClient } from "@tidal-music/api";

import type { ResolvedTrack, SongCandidate } from "@longplay/core";
import { normalizeText } from "@longplay/core";

export interface TidalTrackSearchResult {
  id: string;
  title: string;
  artist: string;
  isrc?: string;
  album?: string;
  explicit?: boolean;
}

export interface TidalPlaylist {
  id: string;
  name: string;
  url?: string;
}

export function isMockTidalPlaylistId(playlistId: string | undefined): boolean {
  return playlistId?.startsWith("mock-") ?? false;
}

export interface TidalCredentials {
  token: string;
}

export interface TidalAdapter {
  createPlaylist(args: {
    accessToken: string;
    name: string;
    description: string;
    countryCode: string;
    idempotencyKey: string;
  }): Promise<TidalPlaylist>;
  searchTracks(args: {
    accessToken: string;
    query: string;
    countryCode: string;
    limit: number;
  }): Promise<TidalTrackSearchResult[]>;
  addTracks(args: {
    accessToken: string;
    playlistId: string;
    trackIds: string[];
    countryCode: string;
    idempotencyKey: string;
  }): Promise<void>;
  sharingLink(args: {
    accessToken: string;
    playlistId: string;
  }): Promise<string>;
}

interface TidalApiOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

function clientFor(accessToken: string, baseUrl: string) {
  return createAPIClient(
    {
      getCredentials: async () => ({ token: accessToken }),
    } as never,
    baseUrl,
  );
}

export class OfficialTidalAdapter implements TidalAdapter {
  constructor(private readonly options: TidalApiOptions) {}

  async createPlaylist(args: {
    accessToken: string;
    name: string;
    description: string;
    countryCode: string;
    idempotencyKey: string;
  }): Promise<TidalPlaylist> {
    const client = clientFor(args.accessToken, this.options.baseUrl);
    const response = await client.POST("/playlists", {
      params: {
        query: {
          countryCode: args.countryCode,
        },
      },
      headers: {
        "Idempotency-Key": args.idempotencyKey,
      },
      body: {
        data: {
          type: "playlists",
          attributes: {
            accessType: "UNLISTED",
            name: args.name,
            description: args.description,
          },
        },
      },
    });

    if (response.error || !response.data?.data?.id) {
      throw new Error("TIDAL playlist creation failed.");
    }

    const id = response.data.data.id;
    return {
      id,
      name: args.name,
      url: `https://tidal.com/playlist/${id}`,
    };
  }

  async searchTracks(args: {
    accessToken: string;
    query: string;
    countryCode: string;
    limit: number;
  }): Promise<TidalTrackSearchResult[]> {
    const client = clientFor(args.accessToken, this.options.baseUrl);
    const response = await client.GET(
      "/searchResults/{id}/relationships/tracks",
      {
        params: {
          path: { id: args.query },
          query: {
            countryCode: args.countryCode,
            include: ["tracks"],
          },
        },
      },
    );

    if (response.error) {
      throw new Error("TIDAL track search failed.");
    }

    const included = Array.isArray(response.data?.included)
      ? response.data.included
      : [];
    return included
      .filter((item: any) => item?.type === "tracks" && item?.id)
      .slice(0, args.limit)
      .map((item: any) => ({
        id: item.id,
        title:
          item.attributes?.title ?? item.attributes?.name ?? "Unknown title",
        artist:
          item.attributes?.artistName ??
          item.attributes?.artists
            ?.map((artist: { name: string }) => artist.name)
            .join(", ") ??
          "Unknown artist",
        isrc: item.attributes?.isrc,
        album: item.attributes?.album?.title,
        explicit: item.attributes?.explicit,
      }));
  }

  async addTracks(args: {
    accessToken: string;
    playlistId: string;
    trackIds: string[];
    countryCode: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (args.trackIds.length === 0) {
      return;
    }

    const client = clientFor(args.accessToken, this.options.baseUrl);
    const response = await client.POST("/playlists/{id}/relationships/items", {
      params: {
        path: { id: args.playlistId },
        query: { countryCode: args.countryCode },
      },
      headers: {
        "Idempotency-Key": args.idempotencyKey,
      },
      body: {
        data: args.trackIds.map((id) => ({
          id,
          type: "tracks" as const,
          meta: {
            addedAt: new Date().toISOString(),
          },
        })),
      },
    });

    if (response.error) {
      throw new Error("TIDAL playlist item update failed.");
    }
  }

  async sharingLink(args: {
    accessToken: string;
    playlistId: string;
  }): Promise<string> {
    return `https://tidal.com/playlist/${args.playlistId}`;
  }
}

export class MockTidalAdapter implements TidalAdapter {
  private playlists = new Map<string, string[]>();

  async createPlaylist(args: {
    accessToken: string;
    name: string;
    description: string;
    countryCode: string;
    idempotencyKey: string;
  }): Promise<TidalPlaylist> {
    const id = `mock-${crypto.randomUUID()}`;
    this.playlists.set(id, []);
    return {
      id,
      name: args.name,
    };
  }

  async searchTracks(args: {
    accessToken: string;
    query: string;
    countryCode: string;
    limit: number;
  }): Promise<TidalTrackSearchResult[]> {
    const [artist = "Unknown Artist", title = args.query] =
      args.query.split(" - ");
    return Array.from({ length: args.limit }, (_, index) => ({
      id: `mock-track-${normalizeText(args.query)}-${index}`,
      title: index === 0 ? title.trim() : `${title.trim()} (${index + 1})`,
      artist: artist.trim(),
      isrc:
        index === 0
          ? `MOCK${normalizeText(args.query).slice(0, 8).toUpperCase()}`
          : undefined,
    }));
  }

  async addTracks(args: {
    accessToken: string;
    playlistId: string;
    trackIds: string[];
    countryCode: string;
    idempotencyKey: string;
  }): Promise<void> {
    const existing = this.playlists.get(args.playlistId) ?? [];
    this.playlists.set(args.playlistId, [...existing, ...args.trackIds]);
  }

  async sharingLink(args: { playlistId: string }): Promise<string> {
    if (isMockTidalPlaylistId(args.playlistId)) {
      throw new Error("Mock TIDAL playlists cannot be opened in TIDAL.");
    }
    return `https://tidal.com/playlist/${args.playlistId}`;
  }
}

export class TidalResolver {
  constructor(
    private readonly adapter: TidalAdapter,
    private readonly options: { accessToken: string; countryCode: string },
  ) {}

  async resolveCandidates(
    candidates: SongCandidate[],
  ): Promise<ResolvedTrack[]> {
    const resolved: ResolvedTrack[] = [];

    for (const candidate of candidates) {
      const query = `${candidate.artist} - ${candidate.title}`;
      const results = await this.adapter.searchTracks({
        accessToken: this.options.accessToken,
        query,
        countryCode: this.options.countryCode,
        limit: 5,
      });
      const best = bestMatch(candidate, results);
      if (best && best.confidence >= 0.7) {
        resolved.push({
          provider: "tidal",
          providerTrackId: best.track.id,
          artist: best.track.artist,
          title: best.track.title,
          isrc: best.track.isrc,
          popularity: candidate.popularity,
          explicit: candidate.explicit,
          releaseDate: candidate.releaseDate,
          chartRank: candidate.chartRank,
          chartPlaycount: candidate.chartPlaycount,
          chartCountry: candidate.chartCountry,
          chartSource: candidate.chartSource,
          moodTags: candidate.moodTags,
          matchConfidence: best.confidence,
          matchReason: best.reason,
        });
      }
    }

    return resolved;
  }
}

export function bestMatch(
  candidate: SongCandidate,
  results: TidalTrackSearchResult[],
):
  | { track: TidalTrackSearchResult; confidence: number; reason: string }
  | undefined {
  const candidateArtist = normalizeText(candidate.artist);
  const candidateTitle = normalizeText(candidate.title);

  let best:
    | {
        track: TidalTrackSearchResult;
        confidence: number;
        reason: string;
      }
    | undefined;

  for (const track of results) {
    const artistMatch =
      normalizeText(track.artist).includes(candidateArtist) ||
      candidateArtist.includes(normalizeText(track.artist));
    const titleMatch = normalizeText(track.title) === candidateTitle;
    const titleContains =
      normalizeText(track.title).includes(candidateTitle) ||
      candidateTitle.includes(normalizeText(track.title));
    const isrcMatch =
      candidate.isrc && track.isrc && candidate.isrc === track.isrc;

    const confidence = isrcMatch
      ? 0.98
      : artistMatch && titleMatch
        ? 0.94
        : artistMatch && titleContains
          ? 0.82
          : titleMatch
            ? 0.72
            : 0.45;
    const reason = isrcMatch
      ? "isrc match"
      : artistMatch && titleMatch
        ? "artist and title match"
        : artistMatch && titleContains
          ? "artist and fuzzy title match"
          : "low-confidence fuzzy match";

    if (!best || confidence > best.confidence) {
      best = { track, confidence, reason };
    }
  }

  return best;
}
