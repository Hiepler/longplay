# Contributing to Longplay

Thanks for your interest in contributing! Issues and pull requests are welcome. This project is a
self-hosted, non-commercial, single-user experiment, so contributions that keep it easy to run,
inspect and reason about are especially valued.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

**Prerequisites**

- Node.js `>=22.13.0`
- npm `>=10.0.0`

**Setup (mock mode — no credentials needed)**

```bash
npm install
cp .env.example .env
npm run dev
```

Mock mode (`SPOTIFY_MOCK=true`, `TIDAL_MOCK=true`, `XAI_MOCK=true`) runs the full engine without a
Tesla, Spotify, TIDAL, Last.fm or LLM account — you can start journeys and watch the queue update
locally. Open `http://localhost:5173`.

## Project layout

This is an npm-workspaces TypeScript monorepo:

- `apps/web` — React 19 + Vite PWA cockpit
- `apps/api` — Fastify API, SQLite, OAuth, playback orchestration, telemetry ingest, journey worker
- `packages/recommendation` — Musical Brief, Drive Story, Journey Moments, lens selection, ranking
- `packages/spotify`, `packages/telemetry`, `packages/{core,crypto,open-music,tidal,test-fixtures}`

The engine design is documented in [`docs/architecture.md`](docs/architecture.md); deployment in
[`docs/deployment.md`](docs/deployment.md).

## Development guidelines

- **Keep the deterministic core deterministic.** The Musical Brief, drive-story acts, moment
  detector, drive-mode classifier, ranking and diversity logic are pure, seeded and unit-tested. The
  LLM is only used to resolve an already-fixed brief into real tracks. New behavior that decides
  _what kind_ of music fits should be testable without calling a model.
- **Add tests for logic changes.** Prefer unit tests close to the package you change; use the mock
  providers and `packages/test-fixtures` rather than live services.
- **Gate new features behind an env flag** (default on/off as appropriate) and document it in
  `.env.example`, mirroring the existing pattern.
- **Don't break mock mode** — it must keep running with no credentials.
- Match the style of the surrounding code; linting and types are enforced in CI.

## Before opening a PR

Run the same checks CI runs on every push:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Then:

1. Keep the PR focused; describe the change and the motivation.
2. Note any new env flags or migrations.
3. If you changed engine behavior, say how you verified it (tests, mock-mode walkthrough).

## Especially useful contribution areas

- opt-in, privacy-respecting measurement logging for the [research question](docs/research.md)
- new recommendation lenses, moment detectors or regional music sources
- telemetry fixtures and simulator scenarios
- Spotify Connect and playback-reconciliation hardening
- docs, setup notes and deployment reports from real self-hosted installs

## Reporting bugs and security issues

- Functional bugs: open a [GitHub issue](https://github.com/Hiepler/longplay/issues) using the
  bug template.
- Security vulnerabilities: **do not** open a public issue — follow [SECURITY.md](SECURITY.md).
