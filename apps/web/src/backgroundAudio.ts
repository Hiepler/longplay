export interface MediaMetadataInit {
  title: string;
  artist: string;
  album?: string;
  artwork: { src: string }[];
}

/** Pure mapping from a resolved track to MediaMetadata init fields. */
export function buildMediaMetadata(
  track: { title: string; artist: string; albumArtUrl?: string } | undefined
): MediaMetadataInit {
  return {
    title: track?.title ?? "Longplay",
    artist: track?.artist ?? "",
    album: undefined,
    artwork: track?.albumArtUrl ? [{ src: track.albumArtUrl }] : []
  };
}

export interface MediaSessionHandlers {
  play?: () => void;
  pause?: () => void;
  nexttrack?: () => void;
  previoustrack?: () => void;
}

interface MediaSessionLike {
  metadata: unknown;
  playbackState: string;
  setActionHandler(action: string, handler: (() => void) | null): void;
}

interface NavigatorLike {
  mediaSession?: MediaSessionLike;
}

/** Sets MediaSession metadata + state + handlers. No-op (and never throws) when unsupported. */
export function applyMediaSession(
  nav: NavigatorLike,
  opts: { metadata: unknown; playbackState: "playing" | "paused"; handlers: MediaSessionHandlers }
): void {
  const session = nav.mediaSession;
  if (!session) return;
  try {
    session.metadata = opts.metadata;
    session.playbackState = opts.playbackState;
    (["play", "pause", "nexttrack", "previoustrack"] as const).forEach((action) => {
      try {
        session.setActionHandler(action, opts.handlers[action] ?? null);
      } catch {
        // Some browsers throw for unsupported actions — ignore that action.
      }
    });
  } catch {
    // mediaSession property assignment unsupported — ignore.
  }
}

export interface KeepAliveElement {
  loop: boolean;
  play(): Promise<void> | void;
  pause(): void;
  remove?(): void;
}

export interface SilentKeepAlive {
  play: () => void;
  pause: () => void;
  dispose: () => void;
}

/**
 * Keeps a same-origin, silent, looping audio element "playing" so the embedded browser treats the
 * page as active media (less background freezing; feeds the Tesla Miniplayer). Element is injectable
 * for tests; the default builds a generated silent WAV (valid + inaudible).
 */
export function createSilentKeepAlive(makeElement: () => KeepAliveElement = defaultSilentElement): SilentKeepAlive {
  const element = makeElement();
  element.loop = true;
  return {
    play: () => {
      void Promise.resolve(element.play()).catch(() => undefined);
    },
    pause: () => element.pause(),
    dispose: () => {
      element.pause();
      element.remove?.();
    }
  };
}

function defaultSilentElement(): KeepAliveElement {
  const audio = new Audio(silentWavUrl());
  audio.loop = true;
  audio.volume = 0;
  return audio;
}

/** Builds a 1s mono 8-bit silent WAV object URL (valid + reliably playable). */
function silentWavUrl(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate; // 1 second
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (1 byte/sample)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits/sample
  writeStr(36, "data");
  view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i += 1) view.setUint8(44 + i, 128); // 8-bit silence
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}
