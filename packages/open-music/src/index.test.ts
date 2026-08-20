import { describe, expect, it } from "vitest";

import { OpenMusicClient } from "./index.js";

function clientWith(fetchImpl: typeof fetch): OpenMusicClient {
  return new OpenMusicClient({
    musicBrainzBaseUrl: "https://musicbrainz.test/ws/2",
    listenBrainzBaseUrl: "https://listenbrainz.test/1",
    userAgent: "Longplay-test/0.0.0",
    fetchImpl
  });
}

describe("OpenMusicClient.findRecording", () => {
  it("does not send the invalid `inc` parameter on the search endpoint", async () => {
    let requestedUrl = "";
    const client = clientWith(async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ recordings: [] }), { status: 200 });
    });

    await client.findRecording("M83", "Outro");
    expect(requestedUrl).not.toContain("inc=");
    expect(requestedUrl).toContain("fmt=json");
  });

  it("returns undefined instead of throwing when the body is not valid JSON", async () => {
    // MusicBrainz can answer 200 with a non-JSON schema/error body.
    const client = clientWith(async () => new Response("{ count: int, created: string }", { status: 200 }));

    await expect(client.findRecording("M83", "Outro")).resolves.toBeUndefined();
  });

  it("returns undefined when the network request itself fails", async () => {
    // e.g. "fetch failed: other side closed" when MusicBrainz drops the connection.
    const client = clientWith(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(client.findRecording("M83", "Outro")).resolves.toBeUndefined();
  });

  it("maps a valid recording match", async () => {
    const client = clientWith(
      async () =>
        new Response(
          JSON.stringify({
            recordings: [
              {
                id: "mbid-1",
                title: "Outro",
                score: 100,
                isrcs: ["FRX000000001"],
                "artist-credit": [{ name: "M83" }],
                tags: [{ name: "electronic" }]
              }
            ]
          }),
          { status: 200 }
        )
    );

    const match = await client.findRecording("M83", "Outro");
    expect(match).toMatchObject({
      mbid: "mbid-1",
      isrc: "FRX000000001",
      title: "Outro",
      artist: "M83",
      score: 100,
      tags: ["electronic"]
    });
  });

  it("enrichCandidate keeps the original candidate when enrichment fails", async () => {
    const client = clientWith(async () => new Response("not json", { status: 200 }));
    const candidate = { artist: "M83", title: "Outro", confidence: 0.5 } as Parameters<
      OpenMusicClient["enrichCandidate"]
    >[0];

    await expect(client.enrichCandidate(candidate)).resolves.toMatchObject({ artist: "M83", title: "Outro" });
  });
});
