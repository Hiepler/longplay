import type { ResolvedTrack, SongCandidate } from "@longplay/core";
import { normalizeText, songKey } from "@longplay/core";

export interface SpotifyTrackSearchResult {
  id: string;
  uri: string;
  title: string;
  artist: string;
  isrc?: string;
  album?: string;
  isPlayable?: boolean;
  market?: string;
  externalUrl?: string;
  albumArtUrl?: string;
  popularity?: number;
  explicit?: boolean;
  releaseDate?: string;
}

export interface SpotifyPlaybackState {
  activeProviderTrackId?: string;
  activeProviderUri?: string;
  isPlaying: boolean;
  queuedProviderTrackIds: string[];
  /** Playback position of the active track in ms (skip heuristic). */
  progressMs?: number;
  /** Total length of the active track in ms (skip heuristic). */
  durationMs?: number;
  /** What kind of item is playing — distinguishes a track from a podcast/episode or ad. */
  currentlyPlayingType?: "track" | "episode" | "ad" | "unknown";
  /**
   * Id of the device Spotify is actually playing on. Lets the backend follow Spotify Connect
   * when the user moves playback to another device (e.g. the native Tesla app) instead of
   * staying bound to the browser webplayer.
   */
  activeDeviceId?: string;
  /** Human-readable name of the active device (diagnostics / UI). */
  activeDeviceName?: string;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  url?: string;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent?: number;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artist: string;
  releaseDate?: string;
  albumType?: string;
}

export interface SpotifyAdapter {
  searchTracks(args: {
    accessToken: string;
    query: string;
    market: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<SpotifyTrackSearchResult[]>;
  /**
   * Reads the listener's top artists (needs the `user-top-read` scope). Optional: adapters that
   * cannot supply taste data simply omit it, and personalization degrades gracefully.
   */
  getTopArtists?(args: {
    accessToken: string;
    timeRange?: "short_term" | "medium_term" | "long_term";
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyArtist[]>;
  /** Recent albums/singles for an artist (release radar). Optional: adapters may omit it. */
  getArtistAlbums?(args: {
    accessToken: string;
    artistId: string;
    includeGroups?: string;
    market?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyAlbum[]>;
  /** Spotify's curated new releases for a country. Optional. */
  getNewReleases?(args: {
    accessToken: string;
    country?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyAlbum[]>;
  transferPlayback(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void>;
  resolvePlaybackDeviceId(args: {
    accessToken: string;
    preferredDeviceId: string;
  }): Promise<string>;
  skipToNext(args: { accessToken: string; deviceId: string }): Promise<void>;
  skipToPrevious(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void>;
  startPlayback(args: {
    accessToken: string;
    deviceId: string;
    uris: string[];
  }): Promise<void>;
  addToQueue(args: {
    accessToken: string;
    deviceId: string;
    uri: string;
  }): Promise<void>;
  getPlaybackState(args: {
    accessToken: string;
    market: string;
  }): Promise<SpotifyPlaybackState>;
  createPlaylist?(args: {
    accessToken: string;
    name: string;
    description: string;
  }): Promise<SpotifyPlaylist>;
  addTracksToPlaylist?(args: {
    accessToken: string;
    playlistId: string;
    uris: string[];
  }): Promise<void>;
  listDevices?(args: { accessToken: string }): Promise<SpotifyDevice[]>;
  pausePlayback?(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void>;
  resumePlayback?(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void>;
}

interface OfficialSpotifyAdapterOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OfficialSpotifyAdapter implements SpotifyAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(options: OfficialSpotifyAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wait = options.wait ?? delay;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async searchTracks(args: {
    accessToken: string;
    query: string;
    market: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<SpotifyTrackSearchResult[]> {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set("q", args.query);
    url.searchParams.set("type", "track");
    url.searchParams.set("market", args.market);
    url.searchParams.set("limit", String(args.limit));

    const payload = await this.request<any>(url, args.accessToken, {
      signal: args.signal,
    });
    const items = Array.isArray(payload?.tracks?.items)
      ? payload.tracks.items
      : [];
    return items.map((item: any) => mapSpotifyTrack(item, args.market));
  }

  async getTopArtists(args: {
    accessToken: string;
    timeRange?: "short_term" | "medium_term" | "long_term";
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyArtist[]> {
    const url = new URL(`${this.baseUrl}/me/top/artists`);
    url.searchParams.set("time_range", args.timeRange ?? "medium_term");
    url.searchParams.set("limit", String(args.limit ?? 20));

    const payload = await this.request<any>(url, args.accessToken, {
      signal: args.signal,
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items.map((item: any) => ({
      id: String(item?.id ?? ""),
      name: String(item?.name ?? ""),
      genres: Array.isArray(item?.genres)
        ? item.genres.filter(
            (genre: unknown): genre is string => typeof genre === "string",
          )
        : [],
    }));
  }

  async getArtistAlbums(args: {
    accessToken: string;
    artistId: string;
    includeGroups?: string;
    market?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyAlbum[]> {
    const url = new URL(`${this.baseUrl}/artists/${args.artistId}/albums`);
    url.searchParams.set(
      "include_groups",
      args.includeGroups ?? "album,single",
    );
    if (args.market) url.searchParams.set("market", args.market);
    url.searchParams.set("limit", String(args.limit ?? 20));
    const payload = await this.request<any>(url, args.accessToken, {
      signal: args.signal,
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items.map(mapSpotifyAlbum);
  }

  async getNewReleases(args: {
    accessToken: string;
    country?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyAlbum[]> {
    const url = new URL(`${this.baseUrl}/browse/new-releases`);
    if (args.country) url.searchParams.set("country", args.country);
    url.searchParams.set("limit", String(args.limit ?? 20));
    const payload = await this.request<any>(url, args.accessToken, {
      signal: args.signal,
    });
    const items = Array.isArray(payload?.albums?.items)
      ? payload.albums.items
      : [];
    return items.map(mapSpotifyAlbum);
  }

  async transferPlayback(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player`);
    // Activation only: do NOT pass play:true — that would resume the account's previous
    // (external) playback context. startPlayback is the single source of truth for content.
    await this.request(
      url,
      args.accessToken,
      {
        method: "PUT",
        body: JSON.stringify({ device_ids: [args.deviceId], play: false }),
      },
      { parseJson: false },
    );
  }

  async resolvePlaybackDeviceId(args: {
    accessToken: string;
    preferredDeviceId: string;
  }): Promise<string> {
    const url = new URL(`${this.baseUrl}/me/player/devices`);
    const payload = await this.request<{
      devices?: Array<{
        id: string;
        is_active?: boolean;
        name?: string;
        type?: string;
      }>;
    }>(url, args.accessToken);
    const devices = payload?.devices ?? [];
    // Connect-only targeting: honor an explicit choice first, then follow wherever Spotify is
    // actually active (the native Tesla app), then any single available device. We deliberately do
    // NOT prefer a browser "AI Journey" web player or a Computer device — that used to pull playback
    // off the car and into the browser.
    const preferred = devices.find(
      (device) => device.id === args.preferredDeviceId,
    );
    if (preferred) {
      return preferred.id;
    }
    const active = devices.find((device) => device.is_active);
    if (active) {
      return active.id;
    }
    if (devices.length === 1) {
      return devices[0].id;
    }
    return args.preferredDeviceId;
  }

  async skipToNext(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/next`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(
      url,
      args.accessToken,
      { method: "POST" },
      { parseJson: false },
    );
  }

  async skipToPrevious(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/previous`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(
      url,
      args.accessToken,
      { method: "POST" },
      { parseJson: false },
    );
  }

  async startPlayback(args: {
    accessToken: string;
    deviceId: string;
    uris: string[];
  }): Promise<void> {
    if (args.uris.length === 0) return;
    const url = new URL(`${this.baseUrl}/me/player/play`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(
      url,
      args.accessToken,
      {
        method: "PUT",
        body: JSON.stringify({ uris: args.uris }),
      },
      { parseJson: false },
    );
  }

  async addToQueue(args: {
    accessToken: string;
    deviceId: string;
    uri: string;
  }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/queue`);
    url.searchParams.set("uri", args.uri);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(
      url,
      args.accessToken,
      { method: "POST" },
      { parseJson: false },
    );
  }

  async getPlaybackState(args: {
    accessToken: string;
    market: string;
  }): Promise<SpotifyPlaybackState> {
    const url = new URL(`${this.baseUrl}/me/player`);
    url.searchParams.set("market", args.market);
    const payload = await this.request<any>(url, args.accessToken);
    const active = payload?.item
      ? mapSpotifyTrack(payload.item, args.market)
      : undefined;
    const queue = Array.isArray(payload?.queue) ? payload.queue : [];
    return {
      activeProviderTrackId: active?.id,
      activeProviderUri: active?.uri,
      isPlaying: payload?.is_playing === true,
      queuedProviderTrackIds: queue
        .map((item: any) => item?.id)
        .filter((id: unknown): id is string => typeof id === "string"),
      progressMs:
        typeof payload?.progress_ms === "number"
          ? payload.progress_ms
          : undefined,
      durationMs:
        typeof payload?.item?.duration_ms === "number"
          ? payload.item.duration_ms
          : undefined,
      currentlyPlayingType:
        typeof payload?.currently_playing_type === "string"
          ? payload.currently_playing_type
          : undefined,
      activeDeviceId:
        typeof payload?.device?.id === "string" ? payload.device.id : undefined,
      activeDeviceName:
        typeof payload?.device?.name === "string"
          ? payload.device.name
          : undefined,
    };
  }

  async createPlaylist(args: {
    accessToken: string;
    name: string;
    description: string;
  }): Promise<SpotifyPlaylist> {
    const profile = await this.request<any>(
      new URL(`${this.baseUrl}/me`),
      args.accessToken,
    );
    if (!profile?.id) {
      throw new Error("Spotify profile did not include a user id.");
    }

    const playlist = await this.request<any>(
      new URL(`${this.baseUrl}/users/${profile.id}/playlists`),
      args.accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          name: args.name,
          description: args.description,
          public: false,
        }),
      },
    );

    return {
      id: playlist.id,
      name: playlist.name ?? args.name,
      url: playlist.external_urls?.spotify,
    };
  }

  async addTracksToPlaylist(args: {
    accessToken: string;
    playlistId: string;
    uris: string[];
  }): Promise<void> {
    if (args.uris.length === 0) return;
    const url = new URL(`${this.baseUrl}/playlists/${args.playlistId}/tracks`);
    await this.request(
      url,
      args.accessToken,
      { method: "POST", body: JSON.stringify({ uris: args.uris }) },
      { parseJson: false },
    );
  }

  async listDevices(args: { accessToken: string }): Promise<SpotifyDevice[]> {
    const url = new URL(`${this.baseUrl}/me/player/devices`);
    const payload = await this.request<{ devices?: any[] }>(
      url,
      args.accessToken,
    );
    const devices = Array.isArray(payload?.devices) ? payload.devices : [];
    return devices
      .filter((device) => typeof device?.id === "string")
      .map((device) => ({
        id: device.id,
        name: typeof device.name === "string" ? device.name : "Unknown device",
        type: typeof device.type === "string" ? device.type : "Unknown",
        isActive: device.is_active === true,
        isRestricted: device.is_restricted === true,
        volumePercent:
          typeof device.volume_percent === "number"
            ? device.volume_percent
            : undefined,
      }));
  }

  async pausePlayback(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/pause`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(
      url,
      args.accessToken,
      { method: "PUT" },
      { parseJson: false },
    );
  }

  async resumePlayback(args: {
    accessToken: string;
    deviceId: string;
  }): Promise<void> {
    const url = new URL(`${this.baseUrl}/me/player/play`);
    url.searchParams.set("device_id", args.deviceId);
    await this.request(
      url,
      args.accessToken,
      { method: "PUT" },
      { parseJson: false },
    );
  }

  private async request<T>(
    url: URL,
    accessToken: string,
    init: RequestInit = {},
    options: { parseJson?: boolean } = {},
    attempt = 0,
  ): Promise<T> {
    const parseJson = options.parseJson ?? true;
    const response = await this.fetchImpl(url, {
      ...init,
      signal: init.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 429 && attempt < 4) {
      const header = Number(
        response.headers.get("Retry-After") ?? String(attempt + 1),
      );
      // Cap the backoff so a large Retry-After can't stall a search far past its timeout budget,
      // and make the wait abortable so the per-search AbortSignal actually bounds total time.
      const retryAfterMs =
        Math.min(Math.max(1, Number.isFinite(header) ? header : 1), 5) * 1000;
      await this.waitUnlessAborted(retryAfterMs, init.signal);
      return this.request(url, accessToken, init, options, attempt + 1);
    }

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `Spotify request failed with ${response.status}: ${details}`,
      );
    }

    // Fire-and-forget commands (transfer/play/queue) ignore the body; never parse it,
    // because Spotify can answer 2xx (e.g. 202 Accepted) with an empty or non-JSON body.
    if (response.status === 204 || !parseJson) {
      return undefined as T;
    }

    const raw = await response.text();
    if (raw.trim() === "") {
      return undefined as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(
        `Spotify request to ${url.pathname} returned ${response.status} with a non-JSON body: ${JSON.stringify(raw.slice(0, 80))}`,
      );
    }
  }

  /** Waits `ms`, but rejects immediately if the request's abort signal fires (or is already aborted). */
  private async waitUnlessAborted(
    ms: number,
    signal?: AbortSignal | null,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new Error("Spotify request aborted before rate-limit retry.");
    }
    if (!signal) {
      await this.wait(ms);
      return;
    }
    await Promise.race([
      this.wait(ms),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              new Error("Spotify request aborted during rate-limit backoff."),
            ),
          {
            once: true,
          },
        );
      }),
    ]);
  }
}

export function isSpotifyDeviceNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("404") &&
    error.message.toLowerCase().includes("device not found")
  );
}

export function isSpotifyRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("429");
}

export class MockSpotifyAdapter implements SpotifyAdapter {
  private queued = new Map<string, string[]>();
  private active = new Map<string, string>();
  addTracksToPlaylistCalls: { playlistId: string; uris: string[] }[] = [];

  async searchTracks(args: {
    query: string;
    market: string;
    limit: number;
  }): Promise<SpotifyTrackSearchResult[]> {
    const artistOnlyMatch = args.query.match(/^artist:"(.+)"$/);
    const [artist = "Unknown Artist", title = args.query] = artistOnlyMatch
      ? [artistOnlyMatch[1], "Top Hit"]
      : args.query.split(" - ");
    const cleanTitle = title.trim().endsWith(" radio")
      ? title.trim().replace(/\s+radio$/i, "")
      : title.trim();
    return Array.from({ length: args.limit }, (_, index) => {
      const normalized = normalizeText(`${artist}-${title}-${index}`);
      const id = `mock-spotify-${normalized}`;
      return {
        id,
        uri: `spotify:track:${id}`,
        title: index === 0 ? cleanTitle : `${cleanTitle} (${index + 1})`,
        artist: artist.trim(),
        isrc:
          index === 0
            ? `MOCK${normalizeText(args.query).slice(0, 8).toUpperCase()}`
            : undefined,
        isPlayable: true,
        market: args.market,
        externalUrl: `https://open.spotify.com/track/${id}`,
        albumArtUrl: `https://i.scdn.co/image/${id}`,
        popularity: Math.max(30, 86 - index * 4),
        explicit: false,
        releaseDate: index < 3 ? "2024-01-01" : "2018-01-01",
      };
    });
  }

  async getTopArtists(args?: {
    accessToken: string;
    timeRange?: "short_term" | "medium_term" | "long_term";
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyArtist[]> {
    const artists: SpotifyArtist[] = [
      {
        id: "mock-bonobo",
        name: "Bonobo",
        genres: ["electronica", "downtempo", "trip hop"],
      },
      {
        id: "mock-tame-impala",
        name: "Tame Impala",
        genres: ["psychedelic rock", "indie"],
      },
      {
        id: "mock-khruangbin",
        name: "Khruangbin",
        genres: ["funk", "psychedelic rock"],
      },
      { id: "mock-tycho", name: "Tycho", genres: ["electronica", "chillwave"] },
      {
        id: "mock-the-war-on-drugs",
        name: "The War on Drugs",
        genres: ["indie", "heartland rock"],
      },
    ];
    return typeof args?.limit === "number"
      ? artists.slice(0, args.limit)
      : artists;
  }

  async getArtistAlbums(args: {
    accessToken: string;
    artistId: string;
    includeGroups?: string;
    market?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SpotifyAlbum[]> {
    return [
      {
        id: `mock-album-${args.artistId}-fresh`,
        name: "Fresh Drop",
        artist: args.artistId.replace(/^mock-/, "").replace(/-/g, " "),
        releaseDate: new Date(Date.now() - 11 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        albumType: "single",
      },
      {
        id: `mock-album-${args.artistId}-old`,
        name: "Old Record",
        artist: args.artistId.replace(/^mock-/, "").replace(/-/g, " "),
        releaseDate: "2019-03-01",
        albumType: "album",
      },
    ];
  }

  async getNewReleases(): Promise<SpotifyAlbum[]> {
    return [
      {
        id: "mock-newrelease-1",
        name: "Chart Newcomer",
        artist: "Fresh Act",
        releaseDate: new Date(Date.now() - 16 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        albumType: "album",
      },
    ];
  }

  async transferPlayback(): Promise<void> {}

  async resolvePlaybackDeviceId(args: {
    preferredDeviceId: string;
  }): Promise<string> {
    return args.preferredDeviceId;
  }

  async skipToNext(): Promise<void> {}

  async skipToPrevious(): Promise<void> {}

  async startPlayback(args: {
    deviceId: string;
    uris: string[];
  }): Promise<void> {
    if (args.uris[0]) {
      this.active.set(args.deviceId, args.uris[0]);
    }
  }

  async addToQueue(args: { deviceId: string; uri: string }): Promise<void> {
    const existing = this.queued.get(args.deviceId) ?? [];
    this.queued.set(args.deviceId, [...existing, args.uri]);
  }

  async getPlaybackState(): Promise<SpotifyPlaybackState> {
    const activeProviderUri = [...this.active.values()][0];
    const activeDeviceId = [...this.active.keys()][0];
    return {
      activeProviderTrackId: activeProviderUri?.split(":").pop(),
      activeProviderUri,
      isPlaying: Boolean(activeProviderUri),
      queuedProviderTrackIds: [...this.queued.values()]
        .flat()
        .map((uri) => uri.split(":").pop())
        .filter((id): id is string => Boolean(id)),
      currentlyPlayingType: "track",
      activeDeviceId,
    };
  }

  async createPlaylist(args: {
    accessToken: string;
    name: string;
    description: string;
  }): Promise<SpotifyPlaylist> {
    const id = `mock-spotify-playlist-${crypto.randomUUID()}`;
    return {
      id,
      name: args.name,
      url: `https://open.spotify.com/playlist/${id}`,
    };
  }

  async addTracksToPlaylist(args: {
    accessToken: string;
    playlistId: string;
    uris: string[];
  }): Promise<void> {
    if (args.uris.length === 0) return;
    this.addTracksToPlaylistCalls.push({
      playlistId: args.playlistId,
      uris: args.uris,
    });
  }

  async listDevices(): Promise<SpotifyDevice[]> {
    return [
      {
        id: "mock-webplayer",
        name: "Longplay (Browser)",
        type: "Computer",
        isActive: true,
        isRestricted: false,
        volumePercent: 85,
      },
      {
        id: "mock-tesla",
        name: "Tesla Model Y",
        type: "Automobile",
        isActive: false,
        isRestricted: false,
      },
    ];
  }

  async pausePlayback(): Promise<void> {}

  async resumePlayback(): Promise<void> {}
}

/**
 * Persistent search cache. `get` returns the cached resolved track, `null` for a cached
 * "no match", or `undefined` when the query was never searched.
 */
export interface SpotifySearchCache {
  get(key: string): ResolvedTrack | null | undefined;
  set(key: string, value: ResolvedTrack | null): void;
}

export interface SpotifyResolverOptions {
  accessToken: string;
  market: string;
  searchTimeoutMs?: number;
  targetResolveCount?: number;
  /** Optional persistent cache so the same song is searched on Spotify at most once. */
  cache?: SpotifySearchCache;
  onSearch?: (event: {
    index: number;
    artist: string;
    title: string;
    ms: number;
    ok: boolean;
    error?: string;
  }) => void;
}

export class SpotifyResolver {
  constructor(
    private readonly adapter: SpotifyAdapter,
    private readonly options: SpotifyResolverOptions,
  ) {}

  async resolveCandidates(
    candidates: SongCandidate[],
  ): Promise<ResolvedTrack[]> {
    const resolved: ResolvedTrack[] = [];
    const target = this.options.targetResolveCount ?? 5;
    const timeoutMs = this.options.searchTimeoutMs ?? 8_000;

    for (let index = 0; index < candidates.length; index += 1) {
      if (resolved.length >= target) {
        break;
      }

      const candidate = candidates[index];
      const query = spotifySearchQueryForCandidate(candidate);
      const cacheKey = `${this.options.market}:${query.toLowerCase()}`;

      // Cache hit (resolved track) or cached "no match" (null) -> skip the Spotify API call.
      const cached = this.options.cache?.get(cacheKey);
      if (cached !== undefined) {
        if (cached) {
          resolved.push(withCandidateMetadata(cached, candidate));
        }
        continue;
      }

      const startedAt = Date.now();
      try {
        const results = await this.adapter.searchTracks({
          accessToken: this.options.accessToken,
          query,
          market: this.options.market,
          limit: 10,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const best = bestSpotifyMatch(candidate, results);
        const resolvedTrack: ResolvedTrack | null =
          best && best.confidence >= 0.7
            ? {
                provider: "spotify",
                providerTrackId: best.track.id,
                providerUri: best.track.uri,
                externalUrl: best.track.externalUrl,
                isPlayable: best.track.isPlayable ?? true,
                market: best.track.market ?? this.options.market,
                albumArtUrl: best.track.albumArtUrl,
                artist: best.track.artist,
                title: best.track.title,
                isrc: best.track.isrc,
                popularity: best.track.popularity ?? candidate.popularity,
                explicit: best.track.explicit ?? candidate.explicit,
                releaseDate: best.track.releaseDate ?? candidate.releaseDate,
                chartRank: candidate.chartRank,
                chartPlaycount: candidate.chartPlaycount,
                chartCountry: candidate.chartCountry,
                chartSource: candidate.chartSource,
                moodTags: candidate.moodTags,
                energy: candidate.energy,
                valence: candidate.valence,
                matchConfidence: best.confidence,
                matchReason: best.reason,
              }
            : null;
        // Cache hit and miss alike, so the same song is never searched twice over a drive.
        this.options.cache?.set(cacheKey, resolvedTrack);
        if (resolvedTrack) {
          resolved.push(resolvedTrack);
        }

        // For artist-only wish queries, also store additional qualifying tracks so that
        // the hard wish quota can guarantee ≥WISH_QUOTA_MIN tracks per artist in the queue.
        const isArtistWish =
          candidate.source === "music-wish" &&
          candidate.lens === "music-wish-artist";
        if (isArtistWish && best) {
          const seenIds = new Set(
            resolved.map((track) => track.providerTrackId),
          );
          for (const extra of results) {
            if (resolved.length >= target) break;
            if (seenIds.has(extra.id)) continue;
            if (extra.isPlayable === false) continue;
            const extraArtist = normalizeText(extra.artist);
            const candidateArtist = normalizeText(candidate.artist);
            const artistMatch =
              extraArtist.includes(candidateArtist) ||
              candidateArtist.includes(extraArtist);
            if (!artistMatch) continue;
            const extraTrack: ResolvedTrack = {
              provider: "spotify",
              providerTrackId: extra.id,
              providerUri: extra.uri,
              externalUrl: extra.externalUrl,
              isPlayable: extra.isPlayable ?? true,
              market: extra.market ?? this.options.market,
              albumArtUrl: extra.albumArtUrl,
              artist: extra.artist,
              title: extra.title,
              isrc: extra.isrc,
              popularity: extra.popularity ?? candidate.popularity,
              explicit: extra.explicit ?? candidate.explicit,
              releaseDate: extra.releaseDate ?? candidate.releaseDate,
              chartRank: candidate.chartRank,
              chartPlaycount: candidate.chartPlaycount,
              chartCountry: candidate.chartCountry,
              chartSource: candidate.chartSource,
              moodTags: candidate.moodTags,
              energy: candidate.energy,
              valence: candidate.valence,
              matchConfidence: 0.9,
              matchReason: "artist wish match",
            };
            resolved.push(extraTrack);
            seenIds.add(extra.id);
          }
        }
        this.options.onSearch?.({
          index,
          artist: candidate.artist,
          title: candidate.title,
          ms: Date.now() - startedAt,
          ok: true,
        });
      } catch (error) {
        this.options.onSearch?.({
          index,
          artist: candidate.artist,
          title: candidate.title,
          ms: Date.now() - startedAt,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return resolved;
  }
}

function spotifySearchQueryForCandidate(candidate: SongCandidate): string {
  if (candidate.isrc) {
    return `isrc:${candidate.isrc}`;
  }
  if (
    candidate.source === "music-wish" &&
    candidate.lens === "music-wish-artist"
  ) {
    return `artist:"${candidate.artist.replaceAll('"', "").trim()}"`;
  }
  return `${candidate.artist} - ${candidate.title}`;
}

function withCandidateMetadata(
  track: ResolvedTrack,
  candidate: SongCandidate,
): ResolvedTrack {
  return {
    ...track,
    popularity: track.popularity ?? candidate.popularity,
    explicit: track.explicit ?? candidate.explicit,
    releaseDate: track.releaseDate ?? candidate.releaseDate,
    chartRank: track.chartRank ?? candidate.chartRank,
    chartPlaycount: track.chartPlaycount ?? candidate.chartPlaycount,
    chartCountry: track.chartCountry ?? candidate.chartCountry,
    chartSource: track.chartSource ?? candidate.chartSource,
    moodTags: track.moodTags ?? candidate.moodTags,
    energy: track.energy ?? candidate.energy,
    valence: track.valence ?? candidate.valence,
  };
}

export function bestSpotifyMatch(
  candidate: SongCandidate,
  results: SpotifyTrackSearchResult[],
):
  | { track: SpotifyTrackSearchResult; confidence: number; reason: string }
  | undefined {
  const candidateArtist = normalizeText(candidate.artist);
  const candidateTitle = normalizeText(candidate.title);
  const artistWishOnly =
    candidate.source === "music-wish" && candidate.lens === "music-wish-artist";
  let best:
    | { track: SpotifyTrackSearchResult; confidence: number; reason: string }
    | undefined;

  for (const track of results) {
    if (track.isPlayable === false) continue;

    const artist = normalizeText(track.artist);
    const title = normalizeText(track.title);
    const artistMatch =
      artist.includes(candidateArtist) || candidateArtist.includes(artist);
    const titleMatch = title === candidateTitle;
    const titleContains =
      title.includes(candidateTitle) || candidateTitle.includes(title);
    const isrcMatch = Boolean(
      candidate.isrc && track.isrc && candidate.isrc === track.isrc,
    );

    const confidence = isrcMatch
      ? 0.99
      : artistWishOnly && artistMatch
        ? 0.9
        : artistMatch && titleMatch
          ? 0.94
          : artistMatch && titleContains
            ? 0.84
            : titleMatch
              ? 0.72
              : 0.4;
    const reason = isrcMatch
      ? "isrc match"
      : artistWishOnly && artistMatch
        ? "artist wish match"
        : artistMatch && titleMatch
          ? "artist and title match"
          : artistMatch && titleContains
            ? "artist and fuzzy title match"
            : "low-confidence fuzzy match";
    const popularityTieBreak = (track.popularity ?? 0) / 10_000;
    const adjusted = confidence + popularityTieBreak;
    if (
      !best ||
      adjusted > best.confidence + (best.track.popularity ?? 0) / 10_000
    ) {
      best = { track, confidence, reason };
    }
  }

  return best;
}

export function queueTracksForBuffer<T extends ResolvedTrack>(
  resolvedTracks: T[],
  args: {
    activeProviderTrackId?: string;
    alreadyQueuedProviderIds: Set<string>;
    targetBufferSize?: number;
    /** Provider track ids already consumed this journey (played/queued/surfaced). */
    excludeProviderTrackIds?: Set<string>;
    /** Song keys already consumed this journey — blocks other versions of the same song. */
    excludeSongKeys?: Set<string>;
    /** Artist keys already consumed or currently in use. Preferred distinctness, not a hard fail when the pool is small. */
    excludeArtistKeys?: Set<string>;
    preferDistinctArtists?: boolean;
    /** Reorders the result so equal mood keys avoid sitting adjacent (soft, pool-permitting). */
    preferDistinctGenres?: boolean;
    cleanRequired?: boolean;
  },
): T[] {
  const finish = (picked: T[]): T[] =>
    spreadGenres(picked, args.preferDistinctGenres);
  const target = args.targetBufferSize ?? 5;
  // A non-positive target means the buffer is already full: select nothing. Without this
  // guard the early-return below (`selected.length === target`) can never fire and the
  // whole eligible pool would be returned — and then queued on Spotify without ever
  // entering the 5-slot playback model.
  if (target <= 0) return [];
  const seenIds = new Set(args.alreadyQueuedProviderIds);
  if (args.activeProviderTrackId) {
    seenIds.add(args.activeProviderTrackId);
  }
  for (const id of args.excludeProviderTrackIds ?? []) {
    seenIds.add(id);
  }
  const seenKeys = new Set(args.excludeSongKeys ?? []);
  const seenArtists = new Set(args.excludeArtistKeys ?? []);
  const selected: T[] = [];
  const passes = args.preferDistinctArtists ? [true, false] : [false];
  for (const distinctPass of passes) {
    for (const track of resolvedTracks) {
      if (track.provider !== "spotify") continue;
      if (track.isPlayable === false) continue;
      if (args.cleanRequired && track.explicit === true) continue;
      if (!track.providerUri) continue;
      if (seenIds.has(track.providerTrackId)) continue;
      const key = songKey(track.artist, track.title);
      if (seenKeys.has(key)) continue;
      const artist = normalizeText(track.artist);
      if (distinctPass && seenArtists.has(artist)) continue;
      seenIds.add(track.providerTrackId);
      seenKeys.add(key);
      seenArtists.add(artist);
      selected.push(track);
      if (selected.length === target) return finish(selected);
    }
  }
  return finish(selected);
}

/**
 * Genre-Spread: greedy reorder so no two equal mood keys sit adjacent, as long as the
 * pool allows it (soft — if impossible the existing ranking order is preserved).
 */
function spreadGenres<T extends ResolvedTrack>(
  selected: T[],
  enabled?: boolean,
): T[] {
  if (!enabled || selected.length < 3) return selected;
  const genreOf = (track: T): string =>
    normalizeText(track.moodTags?.[0] ?? "unknown");
  const pool = [...selected];
  const ordered: T[] = [];
  while (pool.length > 0) {
    const prev = ordered[ordered.length - 1];
    const index = prev
      ? pool.findIndex((track) => genreOf(track) !== genreOf(prev))
      : 0;
    const pick = pool.splice(index === -1 ? 0 : index, 1)[0];
    ordered.push(pick);
  }
  return ordered;
}

function mapSpotifyAlbum(item: any): SpotifyAlbum {
  return {
    id: String(item?.id ?? ""),
    name: String(item?.name ?? "Unknown album"),
    artist: Array.isArray(item?.artists)
      ? item.artists
          .map((a: { name?: string }) => a.name)
          .filter(Boolean)
          .join(", ")
      : "Unknown artist",
    releaseDate:
      typeof item?.release_date === "string" ? item.release_date : undefined,
    albumType:
      typeof item?.album_type === "string" ? item.album_type : undefined,
  };
}

function mapSpotifyTrack(item: any, market?: string): SpotifyTrackSearchResult {
  const images = Array.isArray(item?.album?.images) ? item.album.images : [];
  return {
    id: item.id,
    uri: item.uri,
    title: item.name ?? "Unknown title",
    artist: Array.isArray(item.artists)
      ? item.artists
          .map((artist: { name?: string }) => artist.name)
          .filter(Boolean)
          .join(", ")
      : "Unknown artist",
    isrc: item.external_ids?.isrc,
    album: item.album?.name,
    isPlayable: item.is_playable ?? true,
    market,
    externalUrl: item.external_urls?.spotify,
    albumArtUrl: images[0]?.url,
    popularity:
      typeof item.popularity === "number" ? item.popularity : undefined,
    explicit: typeof item.explicit === "boolean" ? item.explicit : undefined,
    releaseDate:
      typeof item.album?.release_date === "string"
        ? item.album.release_date
        : undefined,
  };
}
