# Security Policy

Longplay is a self-hosted application that handles sensitive material on the operator's own
infrastructure: Spotify/TIDAL OAuth tokens, a Last.fm key, an LLM API key, and — when enabled —
read-only Tesla Fleet API credentials and a vehicle public key. Credentials are encrypted at rest in
SQLite with `APP_SECRET`. Because each install is operated by its owner, the most important security
boundary is your own deployment (see [`docs/deployment.md`](docs/deployment.md)).

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's
[**Report a vulnerability**](https://github.com/Hiepler/longplay/security/advisories/new) flow
(Security → Advisories). This opens a private advisory visible only to the maintainers.

When reporting, please include:

- affected component (e.g. `apps/api`, OAuth callback, telemetry ingest) and version/commit,
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested remediation if you have one.

We aim to acknowledge a report within **7 days** and to agree on a disclosure timeline with you. As a
single-maintainer, non-commercial project there is no bug-bounty program, but credit is gladly given
in the advisory and release notes unless you prefer to remain anonymous.

## Scope

In scope:

- the API, web app and recommendation/telemetry packages in this repository,
- credential handling, OAuth flows, and the Tesla integration as configured by `.env.example`.

Out of scope:

- vulnerabilities in third-party services (Spotify, TIDAL, Tesla, Gemini, Last.fm, LRCLIB) — report
  those to the respective vendor,
- misconfiguration of a self-hosted deployment (e.g. a weak `APP_SECRET`, an exposed `.env`, a
  reverse proxy without TLS) — see the deployment guide for hardening,
- denial-of-service from running without the documented rate limits / caches.

## Hardening reminders for operators

- Set a strong, unique `APP_SECRET` and keep `.env` out of version control.
- Terminate TLS in front of the API; never expose the API or MQTT broker directly to the internet.
- Keep the Tesla integration read-only; the app never needs vehicle-command scope for music curation.
- Rotate provider keys if a machine that held them is compromised.
