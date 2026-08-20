# Longplay

[![CI](https://github.com/Hiepler/longplay/actions/workflows/ci.yml/badge.svg)](https://github.com/Hiepler/longplay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

> A self-hosted music engine for road trips. You give it a destination and a mood; it builds a
> Spotify queue and keeps re-curating it as the drive changes, using live telemetry from the car.

Single-user, open source, Spotify-first. TIDAL works as a playlist and deep-link fallback. Mock mode
runs the whole engine with no credentials at all.

![Longplay cockpit](docs/assets/screenshot-home.png)

## Why I built it

Every "smart" playlist I tried picks a vibe once and then keeps serving it. On a six-hour drive that
is wrong within twenty minutes, and skipping songs at 130 km/h is not something I want to be doing.

So the queue here is built as a setlist with a shape: an opener that sets the mood, tracks that carry
momentum, a bridge, one deliberate outlier, and something that lands when you arrive. What makes that
possible is reading the drive as a trajectory rather than a snapshot — which is also where the name
comes from. A drive is an LP side, not a shuffle.

## How it works

Two halves. A deterministic curation layer that costs nothing to run, and an LLM that only does
catalog lookup.

```
Tesla telemetry  ->  musical brief  ->  lens selection  ->  LLM finds real tracks  ->  scored & ordered  ->  Spotify
  (signals over      (energy, mood,     (which generators   (the only AI step,        (roles, diversity,
   time, trends)      arc, moments)      to run at all)      web-grounded)             no repeats)
```

Everything left of the LLM step is pure TypeScript, seeded and unit-tested. The model never sees the
brief object — it receives a short text instruction and returns candidate tracks for an intent the
engine already fixed.

### The musical brief

A plain function turns drive signals into a brief: energy target, intensity, eras, genres, mood
words. No tokens.

The important bit is that it reads trends, not the latest value. Recent telemetry snapshots give a
pace trend (`accelerating` / `slowing` / `steady`) and an ETA trend (`approaching` / `steady`), plus a
drive phase (`departure`, `cruise`, `golden_hour`, `focus`, `arrival`, `rest`). Accelerating pushes
energy up. Slowing eases it off. An approaching ETA tips the brief into a resolving register. It is
dead reckoning applied to music: derive the state from the course, not from one fixed reading.

On top of that sits a drive story with five acts — `opening`, `act_one`, `interlude`, `climax`,
`finale` — picked from elapsed time against planned duration, so a two-hour trip and a nine-hour trip
have different shapes rather than the same loop repeated.

### Lens selection and scoring

The brief then picks which generators to run from a catalog of fourteen lenses, rather than always
running the same four. Among them: a geo-soundtrack lens (artists with a real connection to the
route), a local-language lens (Italian near Garda, French near Montpellier), low-distraction,
cinematic warmth, steady momentum, a timeless anchor, a leftfield bridge, a deep-cut explorer, a
resolving-arrival lens, and a Disney/film singalong lens for kids mode. The chosen ones run as
parallel Gemini calls, and the geo, local-language, current and deep-cut lenses are web-grounded via
Google Search so the tracks are real and actually exist.

Every candidate comes back with two things.

A **role** — one of `anchor`, `momentum`, `bridge`, `surprise`, `resolution` — so each pick has a
function in the arc rather than just being next in a list.

A **score** across `contextFit`, `telemetryFit`, `tasteFit`, `diversityGain`, `novelty` and a
`fatiguePenalty`, along with the drive signals that influenced it. Both are stored per candidate in
SQLite, so after a drive you can query why any given song got picked. The cockpit shows the short
version: a server-composed "why this song" line.

A diversity balancer then spreads the selection across decades, genres and artists before resolving
on Spotify. Search results are cached, so a ten-hour drive does not hit rate limits.

Other things the engine does:

**No song plays twice per journey.** Enforced by exact track ID and by a normalized song key, so
"Song" and "Song (Live / Extended / Remaster)" count as the same song. A cross-journey artist ledger
also de-prioritizes artists you heard on recent drives.

**Momentum Radio** walks the Last.fm similar-artist graph out from what is currently playing, and
inverts popularity — it samples ranks 5–30 rather than the top hits — to reach the
great-but-not-obvious neighbors of music you already like.

**Your Spotify top artists** feed a favored-genre signal, blended in through an adjustable
Familiar / Discover slider in the UI.

**AI calls only happen when the vibe actually changes.** Routine buffer top-ups reuse the existing
candidate pool. The engine keeps a five-track forward window and only appends, since Spotify's API
cannot reorder or remove queued items.

### Telemetry

The car connects through the Tesla Fleet API, read-only, EU and US. Two ingestion modes feed the same
engine: REST polling (simple, one billed `vehicle_data` request per tick) or Fleet Telemetry streaming
over MQTT (near-real-time, no per-tick billing, but you run Tesla's telemetry server and command
proxy). Streaming becomes primary when enabled, with polling as automatic fallback.

Mapped signals: speed, outside temperature, battery, autopilot state, charging state, navigation
destination and ETA, live route traffic delay, predicted range at arrival, and cabin media volume as a
quiet-cabin hint. Streaming adds longitudinal acceleration, brake pedal and hazard lights, which is
enough to tell stop-and-go apart from a smooth glide. Raw GPS is converted into a coarse region
server-side and then dropped.

Those trends feed straight back into the brief and the lens choice, which is where the two halves
meet. A phase change re-curates the queue on its own. It never wakes a sleeping car.

**Journey moments** sit on the same signal stream and shape the next set without hard-cutting the
current song: `traffic_jam`, `traffic_release`, `golden_hour`, `temp_swing`, `border_crossing`,
`charge_approach`, `charge_resume`, `arrival`. Crossing into Italy gets you a cockpit banner and local
music. A detected charge stop starts a new journey leg and resets the arc, so the drive after the
supercharger opens with its own build instead of continuing a finale.

### Adaptive drive mode

A zero-token classifier reads recent telemetry and flips the brief into one of two modes.

**Calm**, in higher-attention situations: heavy traffic from live route delay, low predicted range at
arrival, or wintry cold. Energy goes down toward familiar, instrumental-leaning tracks, and the
surprise lens is dropped.

**Focus**, on long monotonous night-highway stretches. Energy goes up toward forward-moving picks.

The mode changes the brief and adds one line of plain text to the Gemini prompts, so selection shifts
with no extra AI calls. Hysteresis stops it flapping at a single traffic light, and it never cuts the
current track. A chip in the UI shows the active mode and the reason for it (`Calm · heavy traffic`),
with a one-tap toggle to switch the whole thing off.

This is a comfort feature. It is not a safety or driver-assistance system, and it makes no claims
about attention or cognitive load. See [limitations](#limitations) for what it cannot do.

## Features

The UI is built for the Tesla landscape touchscreen: large tap targets, glanceable live context
(phase, pace, ETA, weather, region), a server-generated "why this song" line, and a badge showing when
real telemetry last arrived. No typing while driving, so moods are presets and destinations come from
recent-trip quick-picks.

- **Tap-to-steer** chips for faster, singalong, stay-awake, drive phase and the Familiar/Discover mix
  — each one visibly re-tunes the queue.
- **Music wishes** by text or voice, parsed into artist boosts, avoids, tempo shifts or mood nudges
  with a confirmation step and a track-based expiry.
- **Spotify Connect device picker** for the in-browser player, your phone, or the car's native
  Spotify app, with full transport control of whichever device is selected.
- **Kids mode and synced lyrics** — clean singalong bias, LRCLIB-backed karaoke.
- **Background playback** survives the Tesla browser being minimized, via a silent keep-alive plus
  MediaSession, which also makes the car's mini-player skip buttons work.
- **Journey playlist mirroring** into a private Spotify playlist named after the trip, so you can
  replay a drive later.
- Spotify, AI, Last.fm and telemetry failures all degrade quietly. The music does not stop because a
  poll failed. Every engine feature is individually env-gated, defaults on, so you can A/B your own
  setup.

## Quick start

Mock mode needs no credentials at all — no Tesla, no Spotify, no LLM. You can start a journey and
watch the queue logic run.

Requires Node.js `>=22.13.0` and npm `>=10`.

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`. The dev server proxies the API, so login and OAuth redirects work on one
origin. Defaults ship with `SPOTIFY_MOCK=true`, `TIDAL_MOCK=true` and `XAI_MOCK=true`.

```bash
npm run typecheck   # all workspaces
npm run test        # full Vitest suite
npm run lint
npm run build
```

## Going live

**Spotify** needs Premium. Create an app, add `https://<domain>/auth/spotify/callback`, then set
`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `SPOTIFY_MOCK=false`. Scopes include `user-top-read`
for personalization and `playlist-modify-private` for the journey playlist, so reconnect once after
upgrading from an older version.

**The AI scout**: set `XAI_MOCK=false` and `GEMINI_API_KEY`. The default is `SONG_SCOUT=multilens`.
Grok is an optional fallback via `SONG_SCOUT=xai` and `XAI_API_KEY`.

**Last.fm**: set `LASTFM_API_KEY` for geo/tag charts and Momentum Radio. Without it those sources
degrade gracefully.

**Tesla** is optional for local development and required for real vehicle signals. Fleet API polling
(`TESLA_FLEET_ENABLED=true`) is the simplest path; Fleet Telemetry streaming
(`TESLA_TELEMETRY_ENABLED=true`) is lower latency but needs more infrastructure. Setup and deployment
for both — Docker, Coolify — are in [`docs/deployment.md`](docs/deployment.md). The repo ships a
single-container `Dockerfile` where the API serves the SPA, plus an `.env.example` template.

`GET /health` confirms the active scout and which connections are live.

## Architecture

npm-workspaces monorepo, TypeScript throughout.

| Package                                                 | Responsibility                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/web`                                              | React 19 + Vite PWA cockpit                                                                         |
| `apps/api`                                              | Fastify API, SQLite via `node:sqlite`, OAuth, playback orchestration, telemetry ingest, 60s journey worker |
| `packages/recommendation`                               | Musical brief, drive story, drive-mode classifier, lens selection, scoring, diversity, song keys     |
| `packages/spotify`                                      | Web API adapter (search, playback, devices, playlists) and the track resolver                        |
| `packages/telemetry`                                    | Tesla payload normalization and phase derivation                                                    |
| `packages/{core,crypto,open-music,tidal,test-fixtures}` | Shared types, encrypted credential store, MusicBrainz/ListenBrainz enrichment, TIDAL adapter, fixtures |

In production the API also serves the built SPA, so everything runs on one origin.

Stack: TypeScript, Fastify 5, React 19, Vite, Vitest, Spotify Web Playback SDK and Web API, Gemini
`generateContent` with Google Search grounding, Last.fm, Tesla Fleet API. The deeper engine walkthrough
is in [`docs/architecture.md`](docs/architecture.md).

## Privacy

Raw GPS is used transiently to derive a coarse region. It is never stored and never sent to the model.

The model receives abstracted journey context only. No VIN, no coordinates, no streaming-library data,
no catalog content from Spotify or TIDAL.

Credentials are encrypted at rest in SQLite under `APP_SECRET`. Tesla access is read-only.

## Does it actually work?

Honestly: I don't know beyond my own experience. The hypothesis was that music which continuously
fits the actual drive makes for a better drive, and maybe shifts something measurable in specific
situations — a calmer soundtrack in stop-and-go, a more engaging one on a monotonous night highway.
So far that is ~4000 km, n=1, nothing measured. What the repo does is make the question testable: the
telemetry side and the music side are both observable in the same system. The hypothesis, prior work
and an experiment outline are in [`docs/research.md`](docs/research.md).

## Limitations

Adaptive drive mode biases song selection and nothing else. It does not change volume, apply audio
processing, or cap BPM, because Tesla access is read-only. It is not a safety system and not evidence
of improved driving performance.

The Fleet API has no rain, wiper or autopilot-engagement field, so weather is inferred from outside
temperature. Polling reacts at poll cadence; streaming is near-real-time but still not hard real time.

Spotify's Web API cannot reorder or remove queued items, so the engine only appends forward.
Re-curating affects what comes next, not what is already queued.

Spotify Web Playback needs Premium and a browser with DRM/EME support. Whether the car's native
Spotify shows up in the Connect device list depends on Tesla firmware and region.

Built for self-hosted, non-commercial, single-user use. It does not redistribute audio or expose
streaming as a service.

## Contributing

Issues and PRs welcome. Especially useful:

- opt-in, privacy-respecting measurement logging for the question above
- new lenses, moment detectors or regional music sources
- telemetry fixtures and simulator scenarios
- Spotify Connect and playback-reconciliation hardening
- deployment reports from real self-hosted installs

Before opening a PR, run `npm run typecheck && npm run lint && npm run test && npm run build`. CI runs
the same checks.

## License

MIT, see [`LICENSE`](LICENSE).
