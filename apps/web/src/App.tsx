import { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  Coffee,
  Compass,
  Crosshair,
  Heart,
  ListMusic,
  Loader2,
  Mic,
  MonitorSpeaker,
  MapPin,
  Music2,
  Navigation,
  Pause,
  Pin,
  PinOff,
  Play,
  Power,
  RefreshCw,
  Radio,
  RotateCcw,
  Route,
  Satellite,
  Scale,
  Moon,
  Send,
  SkipBack,
  SkipForward,
  Sparkles,
  Sunset,
  Wifi,
  Wind,
  X,
} from "lucide-react";

import {
  api,
  type Health,
  type Journey,
  type JourneyDetail,
  type LiveTelemetry,
  type MusicWish,
  type SpotifyDevice,
} from "./lib/api.js";
import { queueTracksInPlaybackOrder } from "./lib/queue.js";
import {
  getSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
} from "./lib/speech.js";
import { MOOD_PRESETS, moodPromptFor } from "./lib/moods.js";
import { buildContextPills, telemetryLiveness } from "./lib/driveContext.js";
import { applyMediaSession, buildMediaMetadata } from "./backgroundAudio.js";
import {
  activeDeviceLabel,
  shouldAutoAdoptConnectDevice,
} from "./lib/devices.js";

const passengerModes = ["solo", "couple", "family", "friends"];

// Short labels for where the journey's location came from (shown on the cockpit geo chip).
const GEO_SOURCE_LABELS: Record<string, string> = {
  "reverse-geocode": "GPS",
  "browser-gps": "Browser",
  destination: "Destination",
  manual: "Manual",
  simulated: "Sim",
};

// Labels for the Adaptive Drive Mode reasons surfaced by the backend.
const DRIVE_MODE_REASON_LABELS: Record<string, string> = {
  "heavy traffic": "heavy traffic",
  "low range": "low range",
  "wintry conditions": "wintry",
  "long night drive": "night drive",
};

// Synced-karaoke tuning. Lines light up slightly early so they're easy to follow; we re-sync the
// playback position only every few seconds and interpolate in between (smooth + low API load).
const LYRICS_LOOKAHEAD_MS = 250;
const LYRICS_SYNC_INTERVAL_MS = 2500;

/** Index of the line that should be highlighted at a given (interpolated) playback position. */
function lyricLineIndex(
  synced: { timeMs: number }[],
  positionMs: number,
): number {
  let index = -1;
  for (let i = 0; i < synced.length; i += 1) {
    if (synced[i].timeMs <= positionMs + LYRICS_LOOKAHEAD_MS) index = i;
    else break;
  }
  return index;
}

// Celebratory family-event copy for a freshly-fired journey moment (shown briefly in the cockpit).
function momentEventLabel(moment: { type: string; country?: string }): {
  emoji: string;
  text: string;
} {
  switch (moment.type) {
    case "border_crossing":
      return {
        emoji: "🎉",
        text: moment.country
          ? `Welcome to ${moment.country}!`
          : "New country!",
      };
    case "traffic_release":
      return { emoji: "🚀", text: "Open road — the jam has cleared!" };
    case "traffic_jam":
      return { emoji: "🧘", text: "Traffic — let's stay relaxed" };
    case "golden_hour":
      return { emoji: "🌇", text: "Golden hour" };
    case "temp_swing":
      return { emoji: "🌡️", text: "The weather is turning" };
    case "arrival":
      return { emoji: "🏁", text: "Almost there!" };
    default:
      return { emoji: "✨", text: "New moment" };
  }
}

const PHASES: { key: string; label: string; Icon: typeof Navigation }[] = [
  { key: "departure", label: "Departure", Icon: Navigation },
  { key: "cruise", label: "Cruise", Icon: Route },
  { key: "golden_hour", label: "Golden hour", Icon: Sunset },
  { key: "focus", label: "Focus", Icon: Crosshair },
  { key: "arrival", label: "Arrival", Icon: MapPin },
  { key: "rest", label: "Rest", Icon: Coffee },
];

function phaseMeta(phase?: string) {
  return PHASES.find((entry) => entry.key === phase) ?? PHASES[0];
}

// Familiarity↔discovery mix: discrete, deliberate taps (re-curation costs AI tokens, so no
// continuous slider). Each step maps to the per-journey tasteWeight (0..1).
const VIBE_MIX: {
  key: string;
  label: string;
  weight: number;
  Icon: typeof Navigation;
}[] = [
  { key: "familiar", label: "Familiar", weight: 0.25, Icon: Heart },
  { key: "balanced", label: "Balanced", weight: 0.5, Icon: Scale },
  { key: "discovery", label: "Discover", weight: 0.75, Icon: Compass },
];

const DEFAULT_TASTE_WEIGHT = 0.4;

function nearestVibe(weight?: number) {
  const target = weight ?? DEFAULT_TASTE_WEIGHT;
  return VIBE_MIX.reduce((best, entry) =>
    Math.abs(entry.weight - target) < Math.abs(best.weight - target)
      ? entry
      : best,
  );
}

function humanizeAnalysisError(message: string): string {
  if (/json|syntaxerror|unexpected token/i.test(message)) {
    return "Song suggestions could not be loaded. Tap Retry below — the server will try again.";
  }
  return message;
}

export function App() {
  const [health, setHealth] = useState<Health>();
  const [history, setHistory] = useState<Journey[]>([]);
  const [activeJourneyId, setActiveJourneyId] = useState<string>();
  const [detail, setDetail] = useState<JourneyDetail>();
  const [destination, setDestination] = useState("Lago di Garda");
  const [liveTelemetry, setLiveTelemetry] = useState<LiveTelemetry>();
  const [liveLoading, setLiveLoading] = useState(false);
  const [momentBanner, setMomentBanner] = useState<{
    type: string;
    country?: string;
    atIso: string;
  }>();
  const [karaokeOn, setKaraokeOn] = useState(false);
  const [lyrics, setLyrics] = useState<{
    trackId: string;
    synced: { timeMs: number; text: string }[] | null;
    plain: string | null;
  }>();
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [activeLyricIndex, setActiveLyricIndex] = useState(-1);
  const [selectedMood, setSelectedMood] = useState(MOOD_PRESETS[0].key);
  const [passengerMode, setPassengerMode] = useState("couple");
  // Connect-only: the web app is a remote control + cockpit. Playback always runs on the active
  // Spotify Connect device (the native Tesla app) — we never create a browser Web Playback player,
  // which previously stole playback whenever the Tesla browser was in the foreground.
  const [isPaused, setIsPaused] = useState<boolean | undefined>();
  const [retuningPhase, setRetuningPhase] = useState<string>();
  const [vibeTuning, setVibeTuning] = useState<string>();
  const [devices, setDevices] = useState<SpotifyDevice[]>([]);
  const [showDevices, setShowDevices] = useState(false);
  const [wishText, setWishText] = useState("");
  const [wishDrawerOpen, setWishDrawerOpen] = useState(false);
  const [wishLoading, setWishLoading] = useState(false);
  const [kidsBusy, setKidsBusy] = useState(false);
  const [geoEditing, setGeoEditing] = useState(false);
  const [geoInput, setGeoInput] = useState("");
  const [geoBusy, setGeoBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const speechSupported =
    typeof window !== "undefined" && isSpeechRecognitionSupported();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const recoveryAttemptedFor = useRef<string | undefined>(undefined);
  // Device id we've already auto-taken-over for, so a newly-active Connect device is bound + started
  // exactly once (not on every devices poll). Reset when the journey changes.
  const autoTakeoverForRef = useRef<string | undefined>(undefined);
  // Did the driver type/pick a destination themselves? A ref (not state) so the in-flight live
  // pre-fill reads the *latest* value at apply-time and never clobbers a destination typed mid-fetch.
  const destinationTouchedRef = useRef(false);
  // Guards the start-screen auto-pull to one Tesla read per session (reset when a journey starts), so
  // a health re-fetch toggling teslaConnected can't re-trigger billed reads.
  const liveAutoFetchedRef = useRef(false);
  // Last journey moment shown as a banner — so the same fired moment isn't celebrated twice.
  const shownMomentAtRef = useRef<string | undefined>(undefined);
  // The currently-sung karaoke line, kept scrolled into view.
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  // Journey id for which we've already attempted the one-shot browser-geolocation fallback.
  const geoFallbackTriedRef = useRef<string | undefined>(undefined);
  // Latest playback-position sample for synced karaoke; the rAF loop interpolates from it with a local
  // clock so highlighting stays smooth between (infrequent) re-syncs. durationRef feeds lyrics matching.
  const lyricsSyncRef = useRef<
    { positionMs: number; isPlaying: boolean; atMs: number } | undefined
  >(undefined);
  const lyricsDurationRef = useRef<number | undefined>(undefined);
  // Holds the latest playback actions so MediaSession / visibility handlers never call stale closures.
  const playbackActionsRef = useRef({
    next: () => {},
    prev: () => {},
    toggle: () => {},
    resume: () => {},
  });
  useEffect(() => {
    refreshShell().catch((err) =>
      setError(
        err instanceof Error
          ? err.message
          : "API unreachable. Run npm run dev and ensure port 3000 is free.",
      ),
    );

    const params = new URLSearchParams(window.location.search);
    const spotify = params.get("spotify");
    const tidal = params.get("tidal");
    if (
      spotify === "connected" ||
      spotify === "mock" ||
      tidal === "connected" ||
      tidal === "mock"
    ) {
      refreshShell().catch((err) =>
        setError(
          err instanceof Error
            ? err.message
            : "API unreachable. Run npm run dev and ensure port 3000 is free.",
        ),
      );
    }
    if (spotify === "error" || tidal === "error") {
      setError(
        decodeURIComponent(params.get("message") ?? "Provider login failed."),
      );
    }
    if (spotify || tidal) {
      params.delete("spotify");
      params.delete("tidal");
      params.delete("message");
      const nextUrl = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
      window.history.replaceState({}, "", nextUrl);
    }
  }, []);

  useEffect(() => {
    if (!activeJourneyId) return;
    const timer = setInterval(() => {
      api
        .journey(activeJourneyId)
        .then(setDetail)
        .catch((err) => setError(String(err)));
    }, 6000);
    return () => clearInterval(timer);
  }, [activeJourneyId]);

  // Poll Connect devices while the device menu is open OR a Spotify journey is active — the latter
  // lets us follow/auto-adopt the active device (native Tesla app) for Connect-only playback.
  useEffect(() => {
    const shouldPoll =
      showDevices ||
      Boolean(
        activeJourneyId &&
        detail?.journey.provider === "spotify" &&
        !health?.spotifyMock,
      );
    if (!shouldPoll) return;
    let cancelled = false;
    const load = () =>
      api
        .spotifyDevices()
        .then((res) => {
          if (!cancelled) setDevices(res.devices);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    showDevices,
    activeJourneyId,
    detail?.journey.provider,
    health?.spotifyMock,
  ]);

  // On the start screen, pull one live reading as soon as the car is connected so the destination/ETA
  // can pre-fill — instead of waiting for the journey's first background poll. Strictly one-shot per
  // start-screen session (Tesla reads are billed and touch the car); a journey starting re-arms it,
  // and the driver can re-pull explicitly with the refresh button.
  useEffect(() => {
    if (activeJourneyId) {
      liveAutoFetchedRef.current = false;
      return;
    }
    if (!health?.teslaConnected || liveAutoFetchedRef.current) return;
    liveAutoFetchedRef.current = true;
    refreshLiveTelemetry();
  }, [activeJourneyId, health?.teslaConnected]);

  // Browser-geolocation fallback for the "local touch": when a journey is active but we have no real
  // GPS fix (only the destination seed or nothing), ask the device once for its position and hand the
  // coordinates to the API. Works on phones and on Teslas whose firmware exposes geolocation; silently
  // does nothing when unavailable or denied. Live Tesla GPS, when present, always takes precedence.
  useEffect(() => {
    if (!activeJourneyId || !navigator.geolocation) return;
    const source = detail?.context?.geoSource;
    if (
      source === "reverse-geocode" ||
      source === "browser-gps" ||
      source === "manual"
    )
      return;
    if (geoFallbackTriedRef.current === activeJourneyId) return;
    geoFallbackTriedRef.current = activeJourneyId;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void api
          .setGeo(
            activeJourneyId,
            position.coords.latitude,
            position.coords.longitude,
          )
          .then(() => api.journey(activeJourneyId))
          .then(setDetail)
          .catch(() => undefined);
      },
      () => undefined,
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  }, [activeJourneyId, detail?.context?.geoSource]);

  // Celebrate a freshly-fired journey moment as a brief, auto-dismissing family-event banner.
  useEffect(() => {
    const moment = detail?.context?.moment;
    if (!moment || shownMomentAtRef.current === moment.atIso) return;
    shownMomentAtRef.current = moment.atIso;
    setMomentBanner(moment);
    const timer = setTimeout(() => setMomentBanner(undefined), 7000);
    return () => clearTimeout(timer);
  }, [detail?.context?.moment?.atIso]);

  const queuedIds = detail?.playbackSession?.queuedTrackIds ?? [];
  const bufferTracks = useMemo(() => {
    if (!detail) return [];
    return queueTracksInPlaybackOrder(detail.tracks, queuedIds);
  }, [detail, queuedIds]);
  const recentDestinations = useMemo(() => {
    const seen = new Set<string>();
    const places: string[] = [];
    for (const journey of history) {
      if (journey.destination && !seen.has(journey.destination)) {
        seen.add(journey.destination);
        places.push(journey.destination);
      }
      if (places.length === 4) break;
    }
    return places;
  }, [history]);
  const displayTracks =
    bufferTracks.length > 0 ? bufferTracks : (detail?.tracks ?? []).slice(0, 8);
  const bufferCount =
    queuedIds.length > 0 ? queuedIds.length : displayTracks.length;
  const activeTrack = detail?.playbackSession?.activeTrack;
  const sessionStatus = detail?.playbackSession?.status;
  const isSpotifyJourney = detail?.journey.provider === "spotify";
  const boundDeviceId = detail?.journey.spotifyDeviceId;
  const activeConnectDevice = devices.find((device) => device.isActive);
  // Connect-only: nothing plays in the browser. The driver starts playback on a Spotify Connect
  // device (the native Tesla app); we surface that when no device is playing/paused yet.
  const needsConnectStart =
    !health?.spotifyMock &&
    isSpotifyJourney &&
    Boolean(activeJourneyId && displayTracks.length > 0) &&
    sessionStatus !== "playing" &&
    sessionStatus !== "paused";
  // No Connect device available at all → guide the driver to open Spotify on the Tesla once.
  const needsConnectDevice =
    needsConnectStart && !activeConnectDevice && !boundDeviceId;
  const tracksPending = Boolean(
    activeJourneyId &&
    detail &&
    detail.tracks.length === 0 &&
    !detail.analysisError,
  );
  const tracksFailed = Boolean(
    detail?.analysisError || detail?.latestUpdate?.status === "failed",
  );
  const spotifyConnected = Boolean(health?.spotifyConnected);

  const liveReading = liveTelemetry?.reading ?? undefined;
  // Freshness badge for the start screen: a real timestamp when we have a reading, "no live data"
  // when the car is reachable but asleep/offline. Hidden entirely when Tesla isn't connected.
  const liveBadge = useMemo(() => {
    if (!health?.teslaConnected || !liveTelemetry?.available) return undefined;
    return telemetryLiveness(liveReading?.timestampIso, nowMs);
  }, [
    health?.teslaConnected,
    liveTelemetry?.available,
    liveReading?.timestampIso,
    nowMs,
  ]);
  const navDestination = liveReading?.destination?.trim();
  const navDestinationAvailable = Boolean(
    navDestination && navDestination !== destination,
  );
  const startContextPills = useMemo(
    () => (liveReading ? buildContextPills(liveReading) : []),
    [liveReading],
  );

  const statusLine = useMemo(() => {
    if (!health) return "Loading…";
    if (!spotifyConnected) return "Connect Spotify to start your journey.";
    if (!health.spotifyPremium)
      return "Spotify Premium is required for playback.";
    if (health.spotifyMock) return "Demo mode — playback is simulated.";
    if (activeJourneyId && detail) {
      if (needsConnectDevice) {
        return "Open Spotify once on the Tesla display — playback will then be picked up automatically.";
      }
      if (needsConnectStart) {
        return "Tracks ready — tap “Start in the car” to play on your Spotify Connect device.";
      }
      const queueHint =
        detail.journey.provider === "spotify"
          ? `Queue ${bufferCount}/5`
          : "TIDAL playlist";
      return `${queueHint} · ${detail.journey.phase}`;
    }
    return "Ready — press Start Journey.";
  }, [
    activeJourneyId,
    bufferCount,
    detail,
    health,
    needsConnectDevice,
    needsConnectStart,
    spotifyConnected,
  ]);

  async function refreshShell(options: { autoResume?: boolean } = {}) {
    const { autoResume = true } = options;
    const [nextHealth, nextHistory] = await Promise.all([
      api.health(),
      api.history(),
    ]);
    setHealth(nextHealth);
    setHistory(nextHistory.journeys);
    const active = nextHistory.journeys.find(
      (journey) => journey.status === "active",
    );
    if (autoResume && active) {
      setActiveJourneyId(active.id);
      setDetail(await api.journey(active.id));
    }
  }

  // Pulls a fresh live reading on demand (start-screen pre-fill). Auto-adopts the car's nav
  // destination unless the driver already typed one. Best-effort: silent on any failure.
  async function refreshLiveTelemetry() {
    setLiveLoading(true);
    try {
      const live = await api.liveTelemetry();
      setLiveTelemetry(live);
      const navDestination = live.reading?.destination?.trim();
      if (navDestination && !destinationTouchedRef.current) {
        setDestination(navDestination);
      }
    } catch {
      // Telemetry is a bonus on the start screen — never block journey creation on it.
    } finally {
      setLiveLoading(false);
    }
  }

  // Connect-only device resolver: the id of the active Spotify Connect device (native Tesla app),
  // the device already bound to the journey, or — when exactly one device is visible — that one.
  // No browser Web Playback player is ever created, so we can never steal playback from the car.
  async function resolveConnectDeviceId(): Promise<string | undefined> {
    if (boundDeviceId) return boundDeviceId;
    try {
      const { devices: list } = await api.spotifyDevices();
      setDevices(list);
      const active = list.find((device) => device.isActive);
      return active?.id ?? (list.length === 1 ? list[0]?.id : undefined);
    } catch {
      return activeConnectDevice?.id;
    }
  }

  function connectSpotify() {
    window.location.assign(api.spotifyLoginUrl);
  }

  async function startJourney() {
    if (!spotifyConnected) {
      connectSpotify();
      return;
    }

    setLoading(true);
    setError(undefined);
    try {
      if (!health?.spotifyMock) {
        const token = await api.spotifyToken();
        if (!token.premium) {
          throw new Error("Spotify Premium is required for playback.");
        }
      }
      // Connect-only: start on the active Connect device (native Tesla app). Passing the deviceId to
      // startJourney lets the initial analysis transfer + start playback there directly. If no device
      // is active yet, the journey/queue is still built and the auto-adopt effect binds + starts it
      // once Spotify is opened on the car.
      const deviceId = await resolveConnectDeviceId();
      const journey = await api.startJourney({
        destination,
        userPrompt: moodPromptFor(selectedMood),
        passengerMode,
        provider: "spotify",
        deviceId,
        // Spotify is already playing on the driver's chosen Connect device (the regular flow) →
        // defend it from the first beat so playback can't bounce to a transient/foreign device.
        lockDevice: Boolean(deviceId),
      });
      setActiveJourneyId(journey.id);
      autoTakeoverForRef.current = deviceId;
      setDetail(await api.journey(journey.id));
      await refreshShell();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadTracks() {
    if (!activeJourneyId) return;
    setLoading(true);
    setError(undefined);
    try {
      // The backend is the single playback authority: analyze (re)builds the queue and, on the
      // bound Connect device, transfers/queues onto it. We never assert playback from the browser.
      await api.analyze(activeJourneyId);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetail(await api.journey(activeJourneyId).catch(() => detail));
    } finally {
      setLoading(false);
    }
  }

  async function refreshQueue() {
    await loadTracks();
  }

  async function submitMusicWish(
    text: string,
    source: "text" | "voice" | "chip" = "text",
  ) {
    const trimmed = text.trim();
    if (!activeJourneyId || !trimmed) return;
    setWishLoading(true);
    setError(undefined);
    try {
      await api.createMusicWish(activeJourneyId, { text: trimmed, source });
      setWishText("");
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWishLoading(false);
    }
  }

  async function toggleWishPin(wish: MusicWish) {
    if (!activeJourneyId) return;
    setWishLoading(true);
    try {
      await api.updateMusicWish(activeJourneyId, wish.id, {
        pinned: !wish.pinned,
      });
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWishLoading(false);
    }
  }

  async function undoWish(wish: MusicWish) {
    if (!activeJourneyId) return;
    setWishLoading(true);
    try {
      await api.undoMusicWish(activeJourneyId, wish.id);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWishLoading(false);
    }
  }

  const VIBE_DIRECTIVES = [
    {
      label: "⚡ Faster",
      text: "faster",
      match: (i: { type?: string; direction?: string }) =>
        i?.type === "tempo" && i.direction === "faster",
    },
    {
      label: "🎤 Singalong",
      text: "singalong",
      match: (i: { type?: string; role?: string }) =>
        i?.type === "role" && i.role === "singalong",
    },
    {
      label: "☀️ Stay awake",
      text: "wake everyone up",
      match: (i: { type?: string; role?: string }) =>
        i?.type === "role" && i.role === "wake_up",
    },
  ] as const;

  function activeVibeWish(
    match: (intent: Record<string, unknown>) => boolean,
  ): MusicWish | undefined {
    return detail?.activeMusicWishes?.find(
      (wish) =>
        wish.pinned && (wish.intents as Record<string, unknown>[]).some(match),
    );
  }

  async function toggleVibeDirective(entry: (typeof VIBE_DIRECTIVES)[number]) {
    if (!activeJourneyId || wishLoading) return;
    const existing = activeVibeWish(entry.match);
    setWishLoading(true);
    setError(undefined);
    try {
      if (existing) {
        await api.undoMusicWish(activeJourneyId, existing.id);
      } else {
        await api.createMusicWish(activeJourneyId, {
          text: entry.text,
          source: "chip",
          pinned: true,
        });
      }
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWishLoading(false);
    }
  }

  async function applyManualGeo(place: string) {
    if (!activeJourneyId || geoBusy) return;
    setGeoBusy(true);
    setError(undefined);
    try {
      await api.setManualGeo(activeJourneyId, place);
      setDetail(await api.journey(activeJourneyId));
      setGeoEditing(false);
      setGeoInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeoBusy(false);
    }
  }

  async function toggleKidsMode() {
    if (!activeJourneyId || kidsBusy) return;
    setKidsBusy(true);
    setError(undefined);
    try {
      await api.setKidsMode(activeJourneyId, !detail?.journey.kidsMode);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setKidsBusy(false);
    }
  }

  function startWishSpeech() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = "de-DE";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      setWishText(transcript);
      void submitMusicWish(transcript, "voice");
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    setListening(true);
    recognition.start();
  }

  async function retryAnalysis() {
    await loadTracks();
  }

  async function playOnCar() {
    if (!activeJourneyId || health?.spotifyMock || !isSpotifyJourney) return;
    setLoading(true);
    setError(undefined);
    try {
      const deviceId = await resolveConnectDeviceId();
      if (!deviceId) {
        setError(
          "No active Spotify device found. Open Spotify once on the Tesla display — playback will then be picked up automatically.",
        );
        return;
      }
      // Explicit user start on the chosen Connect device. Pin it so passive auto-adopt cannot
      // bounce playback back to a foreground browser device.
      await api.registerSpotifyDevice(activeJourneyId, {
        deviceId,
        status: "ready",
        transfer: true,
        pin: true,
      });
      autoTakeoverForRef.current = deviceId;
      setIsPaused(false);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function skipTrack(direction: "next" | "previous") {
    if (!activeJourneyId || !isSpotifyJourney || health?.spotifyMock) return;
    setLoading(true);
    setError(undefined);
    try {
      // The backend is the single playback authority: it issues an absolute startPlayback of the
      // exact selected track (+ our queue) on the device. We must NOT skip via the Web Playback SDK
      // here — the SDK only skips *relatively*, walking Spotify's own (drifting) queue, which is
      // what made the played track differ from the one shown.
      const deviceId =
        boundDeviceId ??
        (await resolveConnectDeviceId().catch(() => undefined));
      await api.skipTrack(activeJourneyId, { direction, deviceId });
      setDetail(await api.journey(activeJourneyId));
      setIsPaused(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function togglePlayPause() {
    if (!activeJourneyId) return;
    // Nothing playing yet → this is really a "start on the car" action.
    if (needsConnectStart) {
      await playOnCar();
      return;
    }
    // Connect-only: control the active device through the Web API (never the in-browser SDK).
    const willPause = playing;
    setIsPaused(willPause);
    try {
      await api.setTransport(activeJourneyId, willPause ? "pause" : "resume");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectDevice(device: SpotifyDevice) {
    if (!activeJourneyId) return;
    setShowDevices(false);
    setError(undefined);
    try {
      // Explicit device choice from the menu takes over playback on that Connect device. pin:true
      // defends this pick so the passive Connect-follow can't bounce it to a transient web device.
      await api.registerSpotifyDevice(activeJourneyId, {
        deviceId: device.id,
        status: "ready",
        transfer: true,
        pin: true,
      });
      autoTakeoverForRef.current = device.id;
      setIsPaused(false);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectPhase(key: string) {
    if (!activeJourneyId || retuningPhase || vibeTuning) return;
    if (key === detail?.journey.phase) return;
    setRetuningPhase(key);
    setError(undefined);
    try {
      await api.setPhase(activeJourneyId, key);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetuningPhase(undefined);
    }
  }

  async function toggleAdaptiveMode() {
    if (!activeJourneyId) return;
    const next = !(detail?.context?.adaptiveModeEnabled ?? true);
    setError(undefined);
    try {
      await api.setAdaptiveMode(activeJourneyId, next);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function selectVibeMix(entry: {
    key: string;
    label: string;
    weight: number;
  }) {
    if (!activeJourneyId || retuningPhase || vibeTuning) return;
    if (entry.key === nearestVibe(detail?.journey.tasteWeight).key) return;
    setVibeTuning(entry.label);
    setError(undefined);
    try {
      await api.setTasteWeight(activeJourneyId, entry.weight);
      setDetail(await api.journey(activeJourneyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVibeTuning(undefined);
    }
  }

  useEffect(() => {
    if (!detail?.analysisError) {
      recoveryAttemptedFor.current = undefined;
    }
  }, [detail?.analysisError]);

  useEffect(() => {
    if (!activeJourneyId || !detail || loading) return;
    const shouldRecover =
      detail.needsAnalysis ||
      (Boolean(detail.analysisError) && detail.tracks.length === 0);
    if (!shouldRecover) return;
    if (recoveryAttemptedFor.current === activeJourneyId) return;
    recoveryAttemptedFor.current = activeJourneyId;
    void loadTracks();
  }, [
    activeJourneyId,
    detail?.needsAnalysis,
    detail?.analysisError,
    detail?.tracks.length,
    loading,
  ]);

  async function startTidalJourney() {
    if (!health?.tidalConnected && !health?.tidalMock) {
      window.location.assign(api.tidalLoginUrl);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const journey = await api.startJourney({
        destination,
        userPrompt: moodPromptFor(selectedMood),
        passengerMode,
        provider: "tidal",
      });
      setActiveJourneyId(journey.id);
      setDetail(await api.journey(journey.id));
      await refreshShell();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    if (!activeJourneyId) return;
    setLoading(true);
    try {
      autoTakeoverForRef.current = undefined;
      setIsPaused(undefined);
      await api.stop(activeJourneyId);
      setActiveJourneyId(undefined);
      setDetail(undefined);
      await refreshShell({ autoResume: false });
    } finally {
      setLoading(false);
    }
  }

  const primaryLabel = !spotifyConnected
    ? "Connect Spotify"
    : activeJourneyId
      ? "Journey active"
      : "Start Journey";

  const heroTrack = activeTrack ?? displayTracks[0];
  const heroTrackId = heroTrack?.id;
  const upcoming = displayTracks
    .filter((track) => track.id !== heroTrack?.id)
    .slice(0, 5);

  // Fetch lyrics for the current track when karaoke is open (cached server-side; once per track). Pass
  // the playing track's duration so the server matches the right recording (live/remix/edit drift).
  useEffect(() => {
    if (!karaokeOn || !activeJourneyId || !heroTrackId) return;
    if (lyrics?.trackId === heroTrackId) return;
    let cancelled = false;
    setLyricsLoading(true);
    const durationSec = lyricsDurationRef.current
      ? lyricsDurationRef.current / 1000
      : undefined;
    api
      .lyrics(activeJourneyId, heroTrackId, durationSec)
      .then((res) => {
        if (!cancelled)
          setLyrics({
            trackId: heroTrackId,
            synced: res.synced,
            plain: res.plain,
          });
      })
      .catch(() => {
        if (!cancelled)
          setLyrics({ trackId: heroTrackId, synced: null, plain: null });
      })
      .finally(() => {
        if (!cancelled) setLyricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [karaokeOn, activeJourneyId, heroTrackId, lyrics?.trackId]);

  // Re-sync the playback position periodically from the device-independent server endpoint so synced
  // karaoke works on the car's/phone's native Spotify (Connect). Resets on track change so a stale
  // position can't highlight the wrong line.
  useEffect(() => {
    setActiveLyricIndex(-1);
    lyricsSyncRef.current = undefined;
    if (
      !karaokeOn ||
      !lyrics?.synced ||
      lyrics.synced.length === 0 ||
      !activeJourneyId
    )
      return;
    let active = true;
    const syncTick = async () => {
      // Connect-only: position comes from the device-independent server endpoint (works for the
      // car's native Spotify Connect playback; there is no in-browser SDK to read from).
      try {
        const progress = await api.playbackProgress(activeJourneyId);
        if (active && typeof progress.progressMs === "number") {
          lyricsSyncRef.current = {
            positionMs: progress.progressMs,
            isPlaying: progress.isPlaying,
            atMs: performance.now(),
          };
          if (typeof progress.durationMs === "number")
            lyricsDurationRef.current = progress.durationMs;
        }
      } catch {
        // best-effort: leave the last sample, the panel just shows static lyrics
      }
    };
    void syncTick();
    const timer = setInterval(() => void syncTick(), LYRICS_SYNC_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [karaokeOn, activeJourneyId, lyrics?.synced, lyrics?.trackId]);

  // Interpolate between re-syncs with a local clock and only re-render when the highlighted line
  // actually changes — smooth highlighting without per-frame React churn.
  useEffect(() => {
    const synced = lyrics?.synced;
    if (!karaokeOn || !synced || synced.length === 0) return;
    let raf = 0;
    const loop = () => {
      const sample = lyricsSyncRef.current;
      if (sample) {
        const estimated = sample.isPlaying
          ? sample.positionMs + (performance.now() - sample.atMs)
          : sample.positionMs;
        const index = lyricLineIndex(synced, estimated);
        setActiveLyricIndex((prev) => (prev === index ? prev : index));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [karaokeOn, lyrics?.synced, lyrics?.trackId]);

  useEffect(() => {
    if (activeLyricIndex < 0) return;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    activeLineRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
  }, [activeLyricIndex]);
  const currentPhase = phaseMeta(detail?.journey.phase);
  const PhaseIcon = currentPhase.Icon;
  const activeVibe = nearestVibe(detail?.journey.tasteWeight);
  const contextPills = buildContextPills(detail?.context);
  const liveness = telemetryLiveness(detail?.context?.lastTelemetryAt, nowMs);
  const driveMode = detail?.context?.driveMode;
  const driveModeLabel =
    DRIVE_MODE_REASON_LABELS[detail?.context?.driveModeReason ?? ""] ??
    detail?.context?.driveModeReason;
  const demo = Boolean(health?.spotifyMock);
  // Connect-only: the playback truth lives in the server session (kept fresh by the backend poller
  // that follows the active Connect device). `isPaused` is a short-lived optimistic override for the
  // toggle button; it is cleared whenever a fresh session status arrives.
  const playing =
    isPaused === undefined ? sessionStatus === "playing" : !isPaused;
  const nowLabel = activeTrack
    ? playing
      ? "Now playing"
      : "Paused"
    : "Up next";
  const canSkipBack =
    (detail?.playbackSession?.playedTrackIds?.length ?? 0) > 0;
  const canSkipForward = upcoming.length > 0 || displayTracks.length > 1;

  // Tick once a second so the "Live · vor Xs" badge counts up between the 4s detail polls.
  useEffect(() => {
    if (!activeJourneyId) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeJourneyId]);

  // Once the backend reports a fresh playback status (or track), drop the optimistic pause override
  // so the cockpit reflects the real Connect-device state.
  useEffect(() => {
    setIsPaused(undefined);
  }, [sessionStatus, activeTrack?.id]);

  // Keep the latest playback actions in a ref so background/OS handlers never call stale closures.
  useEffect(() => {
    playbackActionsRef.current = {
      next: () => void skipTrack("next"),
      prev: () => void skipTrack("previous"),
      toggle: () => void togglePlayPause(),
      resume: () => void togglePlayPause(),
    };
  });

  // Feed OS / Tesla Miniplayer media controls (also makes its skip buttons work via action handlers).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
      return;
    const metadata =
      typeof MediaMetadata !== "undefined"
        ? new MediaMetadata(buildMediaMetadata(heroTrack))
        : buildMediaMetadata(heroTrack);
    applyMediaSession(navigator as never, {
      metadata,
      playbackState: playing ? "playing" : "paused",
      handlers: {
        play: () => playbackActionsRef.current.toggle(),
        pause: () => playbackActionsRef.current.toggle(),
        nexttrack: () => playbackActionsRef.current.next(),
        previoustrack: () => playbackActionsRef.current.prev(),
      },
    });
  }, [heroTrack?.id, heroTrack?.title, playing]);

  // Connect-only auto-adopt: when no device is playing yet and a Spotify Connect device becomes
  // active (the driver opened Spotify on the Tesla), bind + start playback on it — exactly once per
  // device. There is deliberately no browser-playback fallback, so the foreground tab never steals
  // playback from the car.
  useEffect(() => {
    const active = devices.find((device) => device.isActive);
    if (
      !shouldAutoAdoptConnectDevice({
        activeJourneyId,
        isSpotifyJourney,
        spotifyMock: health?.spotifyMock,
        sessionStatus,
        boundDeviceId,
        activeDeviceId: active?.id,
        autoTakeoverDeviceId: autoTakeoverForRef.current,
      })
    ) {
      return;
    }
    if (!active) return;
    const journeyId = activeJourneyId;
    if (!journeyId) return;
    autoTakeoverForRef.current = active.id;
    void api
      // pin:true — opening Spotify on the Tesla IS the driver choosing where to play. Lock + defend
      // that device exactly like an explicit picker tap so a transient/foreign active device (e.g. a
      // lingering open.spotify.com tab) can't bounce playback away right after we bind it. There is
      // no in-browser Web Playback player anymore, so "whatever is active" is always a real Connect
      // device; a genuine later move is recoverable by picking that device explicitly (it overrides).
      .registerSpotifyDevice(journeyId, {
        deviceId: active.id,
        status: "ready",
        transfer: true,
        pin: true,
      })
      .then(() => api.journey(journeyId))
      .then(setDetail)
      .catch(() => {
        // Allow a retry on the next poll if binding failed.
        autoTakeoverForRef.current = undefined;
      });
  }, [
    devices,
    activeJourneyId,
    isSpotifyJourney,
    health?.spotifyMock,
    sessionStatus,
    boundDeviceId,
  ]);

  // A new journey re-arms auto-adopt.
  useEffect(() => {
    autoTakeoverForRef.current = undefined;
  }, [activeJourneyId]);

  return (
    <div className="app">
      <div
        aria-hidden="true"
        className="ambient"
        style={
          heroTrack?.albumArtUrl
            ? { backgroundImage: `url(${heroTrack.albumArtUrl})` }
            : undefined
        }
      />
      <div aria-hidden="true" className="ambient-veil" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Music2 size={20} />
          </span>
          <span className="brand-name">
            Long<b>play</b>
          </span>
        </div>
        <div className="chips">
          {activeJourneyId && detail ? (
            <span className="chip accent">
              <PhaseIcon size={15} /> {currentPhase.label}
            </span>
          ) : null}
          {activeJourneyId && detail?.playbackSession?.status === "external" ? (
            <span
              className="chip warn"
              title="A track is playing in Spotify outside the journey — Longplay pauses curation until a journey song plays again."
            >
              <Radio size={15} /> External playback
            </span>
          ) : null}
          {activeJourneyId &&
          detail &&
          (health?.teslaConnected || detail.context?.lastTelemetryAt) ? (
            <span
              className={`chip telemetry ${liveness.state}`}
              title={
                liveness.state === "live"
                  ? "Live drive data from Tesla is coming in"
                  : liveness.state === "stale"
                    ? "Last Tesla drive data – no fresh reading right now (car asleep/parked?)"
                    : "No live drive data fetched yet – start a journey and drive off"
              }
            >
              <Satellite size={15} />{" "}
              {liveness.state === "none"
                ? "No live data"
                : liveness.state === "live" &&
                    detail?.context?.telemetrySource === "streaming"
                  ? "Live (Streaming)"
                  : liveness.label}
            </span>
          ) : null}
          {activeJourneyId && detail && driveMode && driveMode !== "neutral" ? (
            <span
              className={`chip drive-mode ${driveMode}`}
              title={`${
                driveMode === "calm"
                  ? "Calmer, familiar music for the current drive situation"
                  : "More alert music to fight monotony"
              }${
                detail.context?.driveModeSignals?.length
                  ? ` · ${detail.context.driveModeSignals.join(", ")}`
                  : ""
              } — comfort feature, not a safety system.`}
            >
              {driveMode === "calm" ? <Wind size={15} /> : <Moon size={15} />}{" "}
              {driveMode === "calm" ? "Calm" : "Focus"}
              {driveModeLabel ? ` · ${driveModeLabel}` : ""}
            </span>
          ) : null}
          {activeJourneyId && isSpotifyJourney ? (
            <span className="chip">
              <Sparkles size={15} /> Queue {bufferCount}/5
            </span>
          ) : null}
          {health?.songScout && !health.songScout.mock ? (
            <span
              className="chip"
              title={
                health.songScout.webSearch
                  ? "Web-grounded song picks"
                  : "AI song picks"
              }
            >
              <Sparkles size={15} />{" "}
              {health.songScout.provider === "xai" ? "Grok" : "Gemini"}
              {health.songScout.webSearch ? " · Search" : ""}
            </span>
          ) : null}
          {demo ? (
            <span className="chip good">
              <BadgeCheck size={15} /> Demo
            </span>
          ) : spotifyConnected ? (
            <button
              className="chip good chip-btn"
              onClick={connectSpotify}
              title="Reconnect Spotify"
              type="button"
            >
              <BadgeCheck size={15} />{" "}
              {health?.spotifyPremium ? "Premium" : "Spotify"}
            </button>
          ) : (
            <button
              className="chip connect"
              onClick={connectSpotify}
              type="button"
            >
              <Wifi size={15} /> Connect Spotify
            </button>
          )}
        </div>
      </header>

      <main className="stage-wrap">
        {!activeJourneyId ? (
          <section className="setup glass">
            <div className="setup-eyebrow-row">
              <p className="eyebrow">Telemetry-aware soundtrack</p>
              {liveBadge ? (
                <button
                  className={`live-badge live-${liveBadge.state}`}
                  onClick={refreshLiveTelemetry}
                  disabled={liveLoading}
                  title="Refresh live data from the car"
                  type="button"
                >
                  {liveLoading ? (
                    <Loader2 className="spin" size={13} />
                  ) : (
                    <Satellite size={13} />
                  )}
                  {liveBadge.label}
                </button>
              ) : null}
            </div>
            <h1 className="setup-title">Where are we headed?</h1>
            <p className="setup-sub">{statusLine}</p>

            {startContextPills.length > 0 ? (
              <div className="context-strip" aria-label="Live drive context">
                {startContextPills.map((pill) => (
                  <span className="ctx-pill" key={pill.key}>
                    <span className="ctx-label">{pill.label}</span>
                    <span className="ctx-value">{pill.value}</span>
                  </span>
                ))}
              </div>
            ) : null}

            <label className="field">
              <span>Destination</span>
              <input
                onChange={(event) => {
                  destinationTouchedRef.current = true;
                  setDestination(event.target.value);
                }}
                placeholder="e.g. Lago di Garda"
                value={destination}
              />
            </label>
            {navDestinationAvailable || recentDestinations.length > 0 ? (
              <div className="quick-picks" aria-label="Destinations">
                {navDestinationAvailable ? (
                  <button
                    className="quick-pick nav"
                    onClick={() => {
                      destinationTouchedRef.current = true;
                      setDestination(navDestination!);
                    }}
                    title="Use the destination from your car's navigation"
                    type="button"
                  >
                    <Navigation size={13} /> {navDestination}
                  </button>
                ) : null}
                {recentDestinations
                  .filter((place) => place !== navDestination)
                  .map((place) => (
                    <button
                      className={`quick-pick${place === destination ? " on" : ""}`}
                      key={place}
                      onClick={() => {
                        destinationTouchedRef.current = true;
                        setDestination(place);
                      }}
                      type="button"
                    >
                      <MapPin size={13} /> {place}
                    </button>
                  ))}
              </div>
            ) : null}

            <div className="field">
              <span>Mood</span>
              <div className="mood-grid" role="group" aria-label="Pick a mood">
                {MOOD_PRESETS.map((preset) => {
                  const Icon = preset.Icon;
                  const isActive = preset.key === selectedMood;
                  return (
                    <button
                      aria-pressed={isActive}
                      className={`mood${isActive ? " on" : ""}`}
                      key={preset.key}
                      onClick={() => setSelectedMood(preset.key)}
                      type="button"
                    >
                      <Icon size={20} />
                      <span>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="segments">
              {passengerModes.map((mode) => (
                <button
                  className={passengerMode === mode ? "seg selected" : "seg"}
                  key={mode}
                  onClick={() => setPassengerMode(mode)}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>

            <button
              className="cta"
              disabled={
                loading || (spotifyConnected && !health?.spotifyPremium)
              }
              onClick={startJourney}
              type="button"
            >
              {loading ? (
                <Loader2 className="spin" size={20} />
              ) : !spotifyConnected ? (
                <Wifi size={20} />
              ) : (
                <Play size={20} />
              )}
              {primaryLabel}
            </button>

            {error ? <p className="error">{error}</p> : null}

            <details
              className="advanced"
              onToggle={(event) => setShowAdvanced(event.currentTarget.open)}
            >
              <summary>More options</summary>
              {showAdvanced ? (
                <div className="advanced-body">
                  <p className="muted">
                    Use TIDAL if Spotify Web Playback is unavailable in your
                    browser.
                  </p>
                  <button
                    className="ghost"
                    disabled={loading}
                    onClick={startTidalJourney}
                    type="button"
                  >
                    Start with TIDAL
                  </button>
                  {history.length > 0 ? (
                    <div className="history-list">
                      {history.slice(0, 5).map((journey) => (
                        <button
                          className="history-row"
                          key={journey.id}
                          onClick={() => {
                            setActiveJourneyId(journey.id);
                            api
                              .journey(journey.id)
                              .then(setDetail)
                              .catch((err) => setError(String(err)));
                          }}
                          type="button"
                        >
                          <span>{journey.destination}</span>
                          <small>
                            {journey.provider} ·{" "}
                            {new Date(journey.createdAtIso).toLocaleString()}
                          </small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </details>
          </section>
        ) : (
          <section className="cockpit">
            {momentBanner ? (
              <div
                className={`moment-banner moment-${momentBanner.type}`}
                role="status"
              >
                <span className="moment-emoji" aria-hidden="true">
                  {momentEventLabel(momentBanner).emoji}
                </span>
                <span className="moment-text">
                  {momentEventLabel(momentBanner).text}
                </span>
              </div>
            ) : null}
            <div className="stage glass">
              <div className="stage-head">
                <span className="now-label">{nowLabel}</span>
                <span className="dest">
                  <MapPin size={14} />{" "}
                  {(() => {
                    const dest = detail?.journey.destination;
                    const next = detail?.journey.currentDestination?.trim();
                    // Across charge stops the car navigates to the next stop first — show it, with the
                    // final destination as the ultimate goal, when they differ.
                    return next &&
                      dest &&
                      next.toLowerCase() !== dest.toLowerCase() ? (
                      <>
                        {next}{" "}
                        <span className="dest-final">· Destination: {dest}</span>
                      </>
                    ) : (
                      dest
                    );
                  })()}
                </span>
              </div>

              {contextPills.length > 0 ? (
                <div className="context-strip" aria-label="Live drive context">
                  {/* "region" is rendered by the editable geo chip below, so skip it here. */}
                  {contextPills
                    .filter((pill) => pill.key !== "region")
                    .map((pill) => (
                      <span className="ctx-pill" key={pill.key}>
                        <span className="ctx-label">{pill.label}</span>
                        <span className="ctx-value">{pill.value}</span>
                      </span>
                    ))}
                </div>
              ) : null}

              {activeJourneyId ? (
                <div className="geo-control">
                  {geoEditing ? (
                    <form
                      className="geo-edit"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void applyManualGeo(geoInput);
                      }}
                    >
                      <input
                        autoFocus
                        className="geo-input"
                        disabled={geoBusy}
                        onChange={(event) => setGeoInput(event.target.value)}
                        placeholder="City/country, e.g. Marseille"
                        value={geoInput}
                      />
                      <button
                        className="geo-btn"
                        disabled={geoBusy || !geoInput.trim()}
                        type="submit"
                      >
                        OK
                      </button>
                      {detail?.context?.geoSource === "manual" ? (
                        <button
                          className="geo-btn ghost"
                          disabled={geoBusy}
                          onClick={() => void applyManualGeo("")}
                          type="button"
                        >
                          Auto
                        </button>
                      ) : null}
                      <button
                        className="geo-btn ghost"
                        disabled={geoBusy}
                        onClick={() => {
                          setGeoEditing(false);
                          setGeoInput("");
                        }}
                        type="button"
                      >
                        ✕
                      </button>
                    </form>
                  ) : (
                    <button
                      className="geo-chip"
                      onClick={() => {
                        setGeoInput(
                          detail?.context?.coarseRegion ??
                            detail?.context?.countryName ??
                            "",
                        );
                        setGeoEditing(true);
                      }}
                      title="Correct location — sets the local music touch"
                      type="button"
                    >
                      <MapPin size={13} />
                      <span className="geo-place">
                        {detail?.context?.coarseRegion ??
                          detail?.context?.countryName ??
                          "Set location"}
                      </span>
                      {detail?.context?.geoSource ? (
                        <span className="geo-src">
                          {GEO_SOURCE_LABELS[detail.context.geoSource] ??
                            detail.context.geoSource}
                        </span>
                      ) : null}
                    </button>
                  )}
                </div>
              ) : null}

              {heroTrack ? (
                <div className="hero">
                  <div className="art-xl">
                    {heroTrack.albumArtUrl ? (
                      <img alt="" src={heroTrack.albumArtUrl} />
                    ) : (
                      <Music2 size={72} />
                    )}
                  </div>
                  <div className="hero-meta">
                    <h2 className="hero-title">{heroTrack.title}</h2>
                    <p className="hero-artist">{heroTrack.artist}</p>
                    {(() => {
                      const why = detail?.tracks.find(
                        (t) => t.id === heroTrack.id,
                      )?.whyLine;
                      return why ? <p className="why-line">{why}</p> : null;
                    })()}
                    <button
                      className={`lyrics-toggle${karaokeOn ? " on" : ""}`}
                      onClick={() => setKaraokeOn((on) => !on)}
                      type="button"
                    >
                      <Mic size={14} /> {karaokeOn ? "Lyrics off" : "Sing along"}
                    </button>
                  </div>
                </div>
              ) : tracksFailed ? (
                <div className="analyze-failed">
                  <p className="muted big">
                    {detail?.analysisError
                      ? humanizeAnalysisError(detail.analysisError)
                      : "Could not load tracks. Check Gemini and Spotify settings, then retry."}
                  </p>
                  <button
                    className="ctrl primary"
                    disabled={loading}
                    onClick={retryAnalysis}
                    type="button"
                  >
                    {loading ? (
                      <Loader2 className="spin" size={20} />
                    ) : (
                      <RefreshCw size={20} />
                    )}
                    <span>Retry song picks</span>
                  </button>
                </div>
              ) : (
                <p className="muted big">
                  {loading || tracksPending
                    ? "Finding songs for your journey…"
                    : "No tracks yet."}
                </p>
              )}

              {karaokeOn && heroTrack ? (
                <div className="karaoke" aria-label="Lyrics to sing along">
                  {lyricsLoading && lyrics?.trackId !== heroTrack.id ? (
                    <p className="karaoke-empty">
                      <Loader2 className="spin" size={16} /> Loading
                      lyrics…
                    </p>
                  ) : lyrics?.synced && lyrics.synced.length > 0 ? (
                    <div className="karaoke-lines">
                      <span className="sr-only" aria-live="polite">
                        {activeLyricIndex >= 0
                          ? lyrics.synced[activeLyricIndex]?.text
                          : ""}
                      </span>
                      {lyrics.synced.map((line, index) => (
                        <p
                          className={`karaoke-line${index === activeLyricIndex ? " active" : ""}`}
                          key={`${line.timeMs}-${index}`}
                          ref={
                            index === activeLyricIndex
                              ? activeLineRef
                              : undefined
                          }
                        >
                          {line.text || "♪"}
                        </p>
                      ))}
                    </div>
                  ) : lyrics?.plain ? (
                    <pre className="karaoke-plain">{lyrics.plain}</pre>
                  ) : (
                    <p className="karaoke-empty">
                      No lyrics found — just hum along 🎶
                    </p>
                  )}
                </div>
              ) : null}

              <div className="transport">
                {demo ? (
                  <span className="transport-note">
                    Demo mode — playback is simulated.
                  </span>
                ) : !isSpotifyJourney ? (
                  detail?.journey.tidalPlaylistUrl ? (
                    <a
                      className="ctrl primary big"
                      href={detail.journey.tidalPlaylistUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      <Play size={22} />
                      <span>Open TIDAL playlist</span>
                    </a>
                  ) : (
                    <span className="transport-note">Playing on TIDAL.</span>
                  )
                ) : needsConnectDevice ? (
                  <span className="transport-note">
                    Open Spotify once on the Tesla display — playback will then
                    be picked up automatically.
                  </span>
                ) : needsConnectStart ? (
                  <button
                    className="ctrl primary big"
                    disabled={loading}
                    onClick={playOnCar}
                    type="button"
                  >
                    {loading ? (
                      <Loader2 className="spin" size={22} />
                    ) : (
                      <Play size={22} />
                    )}
                    <span>Start in the car</span>
                  </button>
                ) : (
                  <>
                    <button
                      className="ctrl"
                      disabled={loading || !canSkipBack}
                      onClick={() => skipTrack("previous")}
                      title="Previous track"
                      type="button"
                    >
                      <SkipBack size={22} />
                      <span className="sr-only">Previous</span>
                    </button>
                    <button
                      className="ctrl primary big"
                      disabled={loading}
                      onClick={togglePlayPause}
                      type="button"
                    >
                      {playing ? <Pause size={22} /> : <Play size={22} />}
                      <span>{playing ? "Pause" : "Play"}</span>
                    </button>
                    <button
                      className="ctrl"
                      disabled={loading || !canSkipForward}
                      onClick={() => skipTrack("next")}
                      title="Next track"
                      type="button"
                    >
                      <SkipForward size={22} />
                      <span className="sr-only">Next</span>
                    </button>
                  </>
                )}
                {boundDeviceId &&
                (sessionStatus === "playing" || sessionStatus === "paused") ? (
                  <span className="transport-note">
                    {sessionStatus === "playing" ? "Playing" : "Paused"} on{" "}
                    {activeDeviceLabel(devices, boundDeviceId)}
                  </span>
                ) : null}
                <button
                  className="ctrl"
                  disabled={loading}
                  onClick={refreshQueue}
                  title="Refresh queue"
                  type="button"
                >
                  <RefreshCw
                    className={loading ? "spin" : undefined}
                    size={20}
                  />
                  <span>Refresh</span>
                </button>
                {detail?.journey.spotifyPlaylistUrl ? (
                  <a
                    className="ctrl"
                    href={detail.journey.spotifyPlaylistUrl}
                    rel="noreferrer"
                    target="_blank"
                    title="Open this journey's playlist on Spotify"
                  >
                    <ListMusic size={20} />
                    <span>Playlist</span>
                  </a>
                ) : null}
                <div className="connect-wrap">
                  <button
                    className="ctrl"
                    onClick={() => setShowDevices((open) => !open)}
                    title="Choose playback device"
                    type="button"
                  >
                    <MonitorSpeaker size={20} />
                    <span>
                      {activeDeviceLabel(
                        devices,
                        detail?.journey.spotifyDeviceId,
                      )}
                    </span>
                  </button>
                  {showDevices ? (
                    <div className="device-menu" role="menu">
                      {devices.length === 0 ? (
                        <p className="device-empty">
                          No Spotify devices found. Open Spotify on a device,
                          then retry.
                        </p>
                      ) : (
                        devices.map((device) => (
                          <button
                            className={`device-row${device.id === detail?.journey.spotifyDeviceId ? " on" : ""}`}
                            key={device.id}
                            onClick={() => selectDevice(device)}
                            type="button"
                          >
                            <MonitorSpeaker size={16} />
                            <span className="device-name">{device.name}</span>
                            <span className="device-type">{device.type}</span>
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
                <button
                  className="ctrl danger"
                  disabled={loading}
                  onClick={stop}
                  title="Stop journey"
                  type="button"
                >
                  <Power size={20} />
                  <span>Stop</span>
                </button>
              </div>

              <div
                className="vibe-row"
                role="group"
                aria-label="Vibe-Direktiven"
              >
                {VIBE_DIRECTIVES.map((entry) => {
                  const active = Boolean(activeVibeWish(entry.match));
                  return (
                    <button
                      className={`vibe-toggle${active ? " on" : ""}`}
                      disabled={wishLoading || !activeJourneyId}
                      key={entry.label}
                      onClick={() => toggleVibeDirective(entry)}
                      type="button"
                    >
                      {entry.label}
                    </button>
                  );
                })}
                <button
                  className={`vibe-toggle${detail?.journey.kidsMode ? " on" : ""}`}
                  disabled={kidsBusy || !activeJourneyId}
                  onClick={toggleKidsMode}
                  title="Kids at the wheel — Disney & movie singalongs for the little ones"
                  type="button"
                >
                  🧸 Kids
                </button>
              </div>

              <div className="wish-bar">
                <form
                  className="wish-input"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitMusicWish(wishText, "text");
                  }}
                >
                  <Sparkles size={16} />
                  <input
                    disabled={wishLoading || !activeJourneyId}
                    onChange={(event) => setWishText(event.target.value)}
                    placeholder="Music wish..."
                    value={wishText}
                  />
                  <button
                    className="icon-btn"
                    disabled={wishLoading || !wishText.trim()}
                    title="Send wish"
                    type="submit"
                  >
                    {wishLoading ? (
                      <Loader2 className="spin" size={16} />
                    ) : (
                      <Send size={16} />
                    )}
                  </button>
                  <button
                    className={`icon-btn${listening ? " on" : ""}`}
                    disabled={!speechSupported || wishLoading}
                    onClick={startWishSpeech}
                    title={
                      speechSupported
                        ? "Voice input"
                        : "Voice input is not available in this browser"
                    }
                    type="button"
                  >
                    <Mic size={16} />
                  </button>
                </form>
                <div className="wish-chips">
                  {["Singalong", "More pop", "Less mellow"].map((chip) => (
                    <button
                      disabled={wishLoading}
                      key={chip}
                      onClick={() => submitMusicWish(chip, "chip")}
                      type="button"
                    >
                      {chip}
                    </button>
                  ))}
                  <button
                    className="wish-drawer-toggle"
                    onClick={() => setWishDrawerOpen(true)}
                    type="button"
                  >
                    Wishes
                  </button>
                </div>
                {detail?.activeMusicWishes?.length ? (
                  <div className="wish-active">
                    {detail.activeMusicWishes.slice(0, 2).map((wish) => (
                      <span className="wish-layer" key={wish.id}>
                        {wish.summary} ·{" "}
                        {wish.pinned
                          ? "Pinned"
                          : `${wish.remainingTracks} Songs`}
                        <button
                          onClick={() => undoWish(wish)}
                          title="Undo"
                          type="button"
                        >
                          <RotateCcw size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              {error ? <p className="error">{error}</p> : null}
            </div>

            <aside className="rail glass">
              <div className="rail-head">
                <span>Up next</span>
                <span className="counter">{bufferCount}/5</span>
              </div>
              <ol className="queue">
                {upcoming.length > 0 ? (
                  upcoming.map((track, index) => (
                    <li
                      className="q-row"
                      key={`${detail?.journey.phase}-${track.id}`}
                      style={{ animationDelay: `${index * 60}ms` }}
                    >
                      <span className="q-num">{index + 1}</span>
                      <span className="q-art">
                        {track.albumArtUrl ? (
                          <img alt="" src={track.albumArtUrl} />
                        ) : (
                          <Music2 size={18} />
                        )}
                      </span>
                      <span className="q-meta">
                        <span className="q-title">{track.title}</span>
                        <span className="q-artist">{track.artist}</span>
                      </span>
                    </li>
                  ))
                ) : tracksFailed ? (
                  <li className="muted">
                    No queue yet — retry song picks above.
                  </li>
                ) : (
                  <li className="muted">Buffering upcoming tracks…</li>
                )}
              </ol>

              <div className="phase-rail" aria-label="Steer the drive vibe">
                {PHASES.map((entry) => {
                  const Icon = entry.Icon;
                  const isActive = entry.key === detail?.journey.phase;
                  const isPending = entry.key === retuningPhase;
                  return (
                    <button
                      aria-pressed={isActive}
                      className={`phase${isActive ? " on" : ""}${isPending ? " pending" : ""}`}
                      disabled={Boolean(retuningPhase) || Boolean(vibeTuning)}
                      key={entry.key}
                      onClick={() => selectPhase(entry.key)}
                      title={`Steer the soundtrack toward "${entry.label}"`}
                      type="button"
                    >
                      {isPending ? (
                        <Loader2 className="spin" size={15} />
                      ) : (
                        <Icon size={15} />
                      )}
                      {isActive || isPending ? <em>{entry.label}</em> : null}
                    </button>
                  );
                })}
              </div>

              <div className="adaptive-toggle">
                <button
                  aria-pressed={detail?.context?.adaptiveModeEnabled ?? true}
                  className={`ghost adaptive-btn${(detail?.context?.adaptiveModeEnabled ?? true) ? " on" : ""}`}
                  onClick={toggleAdaptiveMode}
                  title="Automatically adapts the music to the drive situation (traffic, range, night driving). Comfort feature — not a safety system."
                  type="button"
                >
                  <Wind size={14} /> Adaptive Drive Mode:{" "}
                  {(detail?.context?.adaptiveModeEnabled ?? true)
                    ? "On"
                    : "Off"}
                </button>
                <small className="muted">
                  Comfort feature, not a safety system.
                </small>
              </div>

              <div
                className="vibe-mix"
                aria-label="Familiarity versus discovery"
              >
                <div className="vibe-head">
                  <span className="vibe-title">
                    <Sparkles size={13} /> Vibe-Mix
                  </span>
                  <span className="vibe-sub">Familiar ↔ Discover</span>
                </div>
                <div className="vibe-segments" role="group">
                  {VIBE_MIX.map((entry) => {
                    const Icon = entry.Icon;
                    const isActive = entry.key === activeVibe.key;
                    const isPending = entry.label === vibeTuning;
                    return (
                      <button
                        aria-pressed={isActive}
                        className={`vibe${isActive ? " on" : ""}${isPending ? " pending" : ""}`}
                        disabled={Boolean(vibeTuning) || Boolean(retuningPhase)}
                        key={entry.key}
                        onClick={() => selectVibeMix(entry)}
                        title={`${entry.label} — ${Math.round(entry.weight * 100)}% an deinem Geschmack`}
                        type="button"
                      >
                        {isPending ? (
                          <Loader2 className="spin" size={15} />
                        ) : (
                          <Icon size={15} />
                        )}
                        <span>{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
                {detail?.taste?.topGenres?.length ? (
                  <p className="vibe-genres">
                    <span>Your genres</span>{" "}
                    {detail.taste.topGenres.slice(0, 4).join(" · ")}
                  </p>
                ) : null}
              </div>
            </aside>

            {retuningPhase || vibeTuning || detail?.analysisPending ? (
              <div className="retuning" role="status">
                <div className="retuning-card">
                  <span className="retuning-orb" aria-hidden="true" />
                  <span className="retuning-label">
                    {vibeTuning || !retuningPhase
                      ? "Adjusting mix"
                      : "Re-tuning the vibe"}
                  </span>
                  <strong className="retuning-phase">
                    {vibeTuning ??
                      (retuningPhase
                        ? phaseMeta(retuningPhase).label
                        : "Adjusting mix")}
                  </strong>
                </div>
              </div>
            ) : null}
            {wishDrawerOpen ? (
              <div
                className="wish-drawer"
                role="dialog"
                aria-label="Music wishes"
              >
                <div className="wish-drawer-head">
                  <span>Music Wishes</span>
                  <button
                    className="icon-btn"
                    onClick={() => setWishDrawerOpen(false)}
                    type="button"
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="wish-drawer-chips">
                  {[
                    "Play now feelgood",
                    "More 90s pop",
                    "Not so slow",
                    "For the kids",
                  ].map((chip) => (
                    <button
                      disabled={wishLoading}
                      key={chip}
                      onClick={() => submitMusicWish(chip, "chip")}
                      type="button"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
                <div className="wish-list">
                  {(detail?.recentMusicWishes ?? []).length ? (
                    detail!.recentMusicWishes!.map((wish) => (
                      <div className={`wish-card ${wish.status}`} key={wish.id}>
                        <div>
                          <strong>{wish.summary}</strong>
                          <small>
                            {wish.status} ·{" "}
                            {wish.pinned
                              ? "pinned"
                              : `${wish.remainingTracks}/${wish.expiresAfterTracks} songs`}
                          </small>
                        </div>
                        <div className="wish-card-actions">
                          <button
                            onClick={() => toggleWishPin(wish)}
                            title={wish.pinned ? "Unpin" : "Pin"}
                            type="button"
                          >
                            {wish.pinned ? (
                              <PinOff size={15} />
                            ) : (
                              <Pin size={15} />
                            )}
                          </button>
                          <button
                            onClick={() => undoWish(wish)}
                            title="Undo"
                            type="button"
                          >
                            <RotateCcw size={15} />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="muted">No music wishes yet.</p>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}
