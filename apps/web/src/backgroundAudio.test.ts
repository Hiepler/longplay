import { describe, expect, it, vi } from "vitest";

import { applyMediaSession, buildMediaMetadata, createSilentKeepAlive } from "./backgroundAudio.js";

describe("buildMediaMetadata", () => {
  it("maps a track to MediaMetadata init fields", () => {
    expect(buildMediaMetadata({ title: "Wait", artist: "M83", albumArtUrl: "https://img/x" })).toEqual({
      title: "Wait",
      artist: "M83",
      album: undefined,
      artwork: [{ src: "https://img/x" }]
    });
  });

  it("falls back gracefully with no track / no artwork", () => {
    const meta = buildMediaMetadata(undefined);
    expect(meta.title).toBe("Longplay");
    expect(meta.artwork).toEqual([]);
  });
});

describe("applyMediaSession", () => {
  it("sets metadata, playbackState and skip handlers", () => {
    const setActionHandler = vi.fn();
    const session: { metadata: unknown; playbackState: string; setActionHandler: typeof setActionHandler } = {
      metadata: null,
      playbackState: "none",
      setActionHandler
    };
    const next = vi.fn();
    const prev = vi.fn();

    applyMediaSession(
      { mediaSession: session },
      { metadata: { title: "Wait" }, playbackState: "playing", handlers: { nexttrack: next, previoustrack: prev } }
    );

    expect(session.metadata).toEqual({ title: "Wait" });
    expect(session.playbackState).toBe("playing");
    const actions = setActionHandler.mock.calls.map((call) => call[0]);
    expect(actions).toContain("nexttrack");
    expect(actions).toContain("previoustrack");
    // The registered nexttrack handler invokes our callback (this is what the Miniplayer skip calls).
    const nextHandler = setActionHandler.mock.calls.find((call) => call[0] === "nexttrack")?.[1];
    nextHandler?.();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when mediaSession is unavailable", () => {
    expect(() => applyMediaSession({}, { metadata: {}, playbackState: "paused", handlers: {} })).not.toThrow();
  });
});

describe("createSilentKeepAlive", () => {
  it("plays, pauses and disposes the injected element", () => {
    const el = { loop: false, play: vi.fn(), pause: vi.fn(), remove: vi.fn() };
    const keepAlive = createSilentKeepAlive(() => el);
    expect(el.loop).toBe(true);

    keepAlive.play();
    expect(el.play).toHaveBeenCalled();
    keepAlive.pause();
    expect(el.pause).toHaveBeenCalled();
    keepAlive.dispose();
    expect(el.remove).toHaveBeenCalled();
  });
});
