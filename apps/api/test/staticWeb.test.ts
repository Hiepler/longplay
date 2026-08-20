import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const tmpDirs: string[] = [];
afterEach(() => {
  delete process.env.WEB_DIST_DIR;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ai-journey-dj-static-"));
  tmpDirs.push(dir);
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: join(dir, "test.db"),
    APP_SECRET: "a-long-test-secret-value",
    TIDAL_MOCK: "true",
    SPOTIFY_MOCK: "true",
    XAI_MOCK: "true",
    CORS_ORIGIN: "http://localhost:5173"
  });
}

describe("static SPA serving", () => {
  it("serves index.html for non-API GET routes and keeps API routes JSON", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "ai-journey-dj-webdist-"));
    tmpDirs.push(webDir);
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Longplay</title>");
    process.env.WEB_DIST_DIR = webDir;

    const { app } = await buildApp(testConfig());

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("Longplay");

    const spaRoute = await app.inject({ method: "GET", url: "/cockpit" });
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.body).toContain("Longplay");

    // API still serves JSON (health) and 404s unknown API paths instead of the SPA.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const unknownApi = await app.inject({ method: "GET", url: "/journeys/does-not-exist/nope" });
    expect(unknownApi.statusCode).toBe(404);

    await app.close();
  });

  it("does not serve a SPA when no dist is configured (dev/test default)", async () => {
    const { app } = await buildApp(testConfig());
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(404);
    await app.close();
  });
});
