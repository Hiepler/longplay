export type SpotifySdkStatus =
  | "idle"
  | "loading"
  | "ready"
  | "not_ready"
  | "account_error"
  | "authentication_error"
  | "playback_error"
  | "autoplay_failed";

export interface SpotifyBrowserFeatures {
  hasSpotifySdk?: boolean;
  hasMediaKeys: boolean;
}

export function spotifyBrowserCapability(features: SpotifyBrowserFeatures): { ok: true } | { ok: false; reason: string } {
  if (!features.hasMediaKeys) {
    return {
      ok: false,
      reason: "encrypted_media_unavailable"
    };
  }
  return { ok: true };
}

export function spotifySdkStatusLabel(status: SpotifySdkStatus): string {
  const labels: Record<SpotifySdkStatus, string> = {
    idle: "Player not started",
    loading: "Starting player…",
    ready: "Player ready",
    not_ready: "Player unavailable",
    account_error: "Spotify Premium required",
    authentication_error: "Login expired — reconnect",
    playback_error: "Playback error",
    autoplay_failed: "Tap Start again to unlock audio"
  };
  return labels[status];
}

export function loadSpotifySdk(): Promise<void> {
  if (window.Spotify) {
    return Promise.resolve();
  }

  const existing = document.querySelector<HTMLScriptElement>('script[src="https://sdk.scdn.co/spotify-player.js"]');
  if (existing) {
    return new Promise((resolve) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
    });
  }

  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () => reject(new Error("Spotify Web Playback SDK could not be loaded."));
    document.head.appendChild(script);
  });
}

export interface SpotifyPlayerInstance {
  addListener(event: string, callback: (payload: any) => void): void;
  connect(): Promise<boolean>;
  disconnect(): void;
  activateElement?: () => Promise<void>;
  resume?: () => Promise<void>;
  togglePlay?: () => Promise<void>;
  nextTrack?: () => Promise<void>;
  previousTrack?: () => Promise<void>;
  getCurrentState?: () => Promise<{
    paused: boolean;
    position?: number;
    duration?: number;
    track_window: { current_track?: { name: string } };
  } | null>;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: {
      Player: new (options: {
        name: string;
        getOAuthToken: (callback: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayerInstance;
    };
  }
}

export interface SpotifyPlaybackSnapshot {
  paused: boolean;
  trackName?: string;
  artistName?: string;
}

export interface ConnectSpotifyWebPlayerOptions {
  accessToken: string;
  existingPlayer?: SpotifyPlayerInstance | null;
  onStatus: (status: SpotifySdkStatus) => void;
  onDeviceLost?: () => void;
  onPlaybackChange?: (snapshot: SpotifyPlaybackSnapshot) => void;
}

export async function connectSpotifyWebPlayer(
  options: ConnectSpotifyWebPlayerOptions
): Promise<{ deviceId: string; player: SpotifyPlayerInstance }> {
  const capability = spotifyBrowserCapability({
    hasSpotifySdk: Boolean(window.Spotify),
    hasMediaKeys: typeof navigator.requestMediaKeySystemAccess === "function"
  });
  if (!capability.ok) {
    options.onStatus("playback_error");
    throw new Error("This browser cannot run Spotify Web Playback (DRM/EME missing).");
  }

  options.onStatus("loading");
  await loadSpotifySdk();
  if (!window.Spotify) {
    throw new Error("Spotify Web Playback SDK is unavailable.");
  }

  options.existingPlayer?.disconnect();

  const player = new window.Spotify.Player({
    name: "Longplay",
    getOAuthToken: (callback) => callback(options.accessToken),
    volume: 0.85
  });

  const deviceId = await new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Spotify player did not become ready in time."));
    }, 20_000);

    const fail = (status: SpotifySdkStatus, message: string) => {
      window.clearTimeout(timeout);
      options.onStatus(status);
      reject(new Error(message));
    };

    player.addListener("ready", ({ device_id }: { device_id: string }) => {
      window.clearTimeout(timeout);
      options.onStatus("ready");
      resolve(device_id);
    });
    player.addListener("not_ready", () => {
      options.onStatus("not_ready");
      options.onDeviceLost?.();
    });
    player.addListener("account_error", () => fail("account_error", "Spotify Premium is required."));
    player.addListener("authentication_error", () => fail("authentication_error", "Spotify login expired."));
    player.addListener("playback_error", () => fail("playback_error", "Spotify playback failed."));
    player.addListener("initialization_error", () => fail("playback_error", "Spotify player failed to initialize."));
    player.addListener("autoplay_failed", () => options.onStatus("autoplay_failed"));
    player.addListener("player_state_changed", (state: any) => {
      if (!state) return;
      const current = state.track_window?.current_track;
      options.onPlaybackChange?.({
        paused: state.paused === true,
        trackName: current?.name,
        artistName: Array.isArray(current?.artists)
          ? current.artists.map((artist: { name?: string }) => artist?.name).filter(Boolean).join(", ")
          : undefined
      });
    });

    void player.activateElement?.().catch(() => options.onStatus("autoplay_failed"));
    void player.connect().then((connected) => {
      if (!connected) {
        fail("not_ready", "Could not connect Spotify Webplayer.");
      }
    });
  });

  return { deviceId, player };
}

export async function skipSpotifyBrowserTrack(
  player: SpotifyPlayerInstance,
  direction: "next" | "previous"
): Promise<void> {
  if (direction === "next") {
    await player.nextTrack?.();
    return;
  }
  await player.previousTrack?.();
}

export async function startSpotifyBrowserPlayback(player: SpotifyPlayerInstance): Promise<void> {
  try {
    await player.activateElement?.();
  } catch {
    // Browser may still allow resume after a direct user gesture.
  }
  if (player.resume) {
    await player.resume();
    return;
  }
  await player.togglePlay?.();
}
