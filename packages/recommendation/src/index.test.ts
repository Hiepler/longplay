import { describe, expect, it } from "vitest";

import type {
  JourneyContext,
  ResolvedTrack,
  SongCandidate,
} from "@longplay/core";
import { normalizeText, songKey } from "@longplay/core";

import type { RecommendationPolicy } from "./index.js";

import { releaseRecencyScore } from "./index.js";

import {
  assertJourneyContextIsPrivacySafe,
  assertPromptIsPrivacySafe,
  balanceCandidates,
  buildRecommendationPolicy,
  buildJourneyPrompt,
  buildLensPrompt,
  buildMusicalBrief,
  buildJourneySet,
  driveModePromptLine,
  createSongScout,
  DEFAULT_LENSES,
  deriveTasteProfile,
  extractXaiResponseText,
  fallbackCandidates,
  GeminiSongScout,
  lastfmTracksToCandidates,
  MultiLensSongScout,
  parseCandidateJson,
  rankResolvedTracksForPolicy,
  repairJsonString,
  moodTagsForContext,
  orderByEnergyArc,
  resolveXaiModel,
  salvageCandidatesFromText,
  selectJourneyLenses,
  selectRollingBatch,
  tryParseCandidateJson,
  XaiSongScout,
} from "./index.js";

const context: JourneyContext = {
  destination: "Lago di Garda",
  coarseRegion: "Northern Italy",
  localTimeIso: "2026-05-28T18:00:00.000Z",
  weatherFeel: "warm and clear",
  etaMinutes: 95,
  speedBucket: "highway",
  temperatureBucket: "warm",
  phase: "golden_hour",
  userPrompt: "cinematic but focused",
  passengerMode: "couple",
};

describe("recommendation", () => {
  it("builds prompts without raw provider or vehicle data", () => {
    const prompt = buildJourneyPrompt(context, 8).toLowerCase();

    expect(prompt).not.toContain("playlist id");
    expect(prompt).not.toMatch(/\bvin\b/);
    expect(prompt).not.toContain("latitude");
    expect(prompt).not.toContain("longitude");
    expect(prompt).toContain("northern italy");
    expect(prompt).toContain("speedbucket");
    expect(prompt).toContain("web search");
    expect(() => assertJourneyContextIsPrivacySafe(context)).not.toThrow();
  });

  it("createSongScout prefers Gemini by default and respects SONG_SCOUT=xai", () => {
    const gemini = createSongScout({
      provider: "gemini",
      mock: false,
      gemini: {
        apiKey: "g",
        baseUrl: "https://gemini.test/v1beta",
        model: "gemini-3.5-flash",
        mock: false,
      },
      xai: {
        apiKey: "x",
        baseUrl: "https://api.x.ai/v1",
        model: "grok-4.3",
        mock: false,
      },
    });
    expect(gemini.info).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash",
      webSearch: true,
    });
    expect(gemini.scout).toBeInstanceOf(GeminiSongScout);

    const grok = createSongScout({
      provider: "xai",
      mock: false,
      gemini: {
        apiKey: "g",
        baseUrl: "https://gemini.test/v1beta",
        model: "gemini-3.5-flash",
        mock: false,
      },
      xai: {
        apiKey: "x",
        baseUrl: "https://api.x.ai/v1",
        model: "grok-4.3",
        mock: false,
      },
    });
    expect(grok.info.provider).toBe("xai");
    expect(grok.scout).toBeInstanceOf(XaiSongScout);
  });

  it("rejects user prompts that reference private streaming data", () => {
    expect(() => assertPromptIsPrivacySafe("match my tidal library")).toThrow(
      /library/,
    );
  });

  it("maps retired grok model slugs to current models", () => {
    expect(resolveXaiModel("grok-4")).toBe("grok-4.3");
    expect(resolveXaiModel("grok-4.3")).toBe("grok-4.3");
  });

  it("extracts text from responses API payloads", () => {
    const text = extractXaiResponseText({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: '{"songs":[{"artist":"M83","title":"Wait"}]}',
            },
          ],
        },
      ],
    });

    expect(text).toContain("M83");
  });

  it("creates deterministic fallback candidates", () => {
    expect(fallbackCandidates(context, 5)).toHaveLength(5);
  });

  it("GeminiSongScout falls back to deterministic candidates in mock mode", async () => {
    const scout = new GeminiSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta/openai",
      model: "gemini-3.5-flash",
      mock: true,
    });
    await expect(scout.generateCandidates(context, 4)).resolves.toHaveLength(4);
  });

  it("repairs and salvages malformed Gemini JSON instead of throwing", () => {
    const broken = `Here is the set:
{
  "songs":.
  {"artist":"M83","title":"Wait","reason":"golden hour cruise","confidence":0.8},
  {"artist":"Tycho","title":"A Walk","reason":"steady highway flow","confidence":0.77},
]`;

    const parsed = tryParseCandidateJson(broken, 5, "gemini");
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({
      artist: "M83",
      title: "Wait",
      source: "gemini",
    });

    expect(salvageCandidatesFromText(broken)).toHaveLength(2);
    expect(
      parseCandidateJson(
        repairJsonString(
          '{"songs":[{"artist":"A","title":"B","confidence":0.7}]}',
        ),
        1,
      ),
    ).toHaveLength(1);
  });

  it("GeminiSongScout falls back when the model returns unparseable text", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "No JSON here, just prose about driving." }],
              },
            },
          ],
        }),
        { status: 200 },
      );

    const scout = new GeminiSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta",
      model: "gemini-3.5-flash",
      mock: false,
      fetchImpl,
    });

    const candidates = await scout.generateCandidates(context, 4);
    expect(candidates).toHaveLength(4);
    expect(candidates.every((item) => item.source === "fallback")).toBe(true);
  });

  it("GeminiSongScout uses native generateContent with Google Search grounding and parses fenced JSON", async () => {
    let captured:
      | { url: string; headers: Headers; body: Record<string, unknown> }
      | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      // Grounded responses often wrap JSON in a markdown fence with surrounding prose.
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'Here is your set:\n```json\n{"songs":[{"artist":"M83","title":"Wait","confidence":0.8}]}\n```',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const scout = new GeminiSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta",
      model: "gemini-3.5-flash",
      mock: false,
      fetchImpl,
    });

    const candidates = await scout.generateCandidates(context, 5);

    expect(captured?.url).toBe(
      "https://gemini.test/v1beta/models/gemini-3.5-flash:generateContent",
    );
    expect(captured?.headers.get("x-goog-api-key")).toBe("k");
    expect(captured?.body.tools).toEqual([{ google_search: {} }]);
    expect(Array.isArray(captured?.body.contents)).toBe(true);
    expect(candidates[0]).toMatchObject({
      artist: "M83",
      title: "Wait",
      source: "gemini",
    });
  });

  it("GeminiSongScout aborts a hanging request via its timeout signal", async () => {
    let sawSignal = false;
    const fetchImpl: typeof fetch = (_input, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      // Never resolves on its own — only the abort signal can settle it (simulates a hung provider).
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      });
    };
    const scout = new GeminiSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta",
      model: "gemini-3.5-flash",
      mock: false,
      requestTimeoutMs: 30,
      fetchImpl,
    });

    // On timeout the scout aborts and degrades to deterministic candidates, so a journey
    // never blocks forever on a hung provider.
    const candidates = await scout.generateCandidates(context, 5);
    expect(sawSignal).toBe(true);
    expect(candidates).toHaveLength(5);
    expect(candidates[0].source).toBe("fallback");
  });

  it("selects a unique rolling five-track batch", () => {
    const tracks: ResolvedTrack[] = Array.from({ length: 7 }, (_, index) => ({
      provider: "tidal",
      providerTrackId: `track-${index}`,
      artist: "Artist",
      title: `Track ${index}`,
      matchConfidence: 0.9,
      matchReason: "test",
    }));

    const selected = selectRollingBatch(tracks, new Set(["track-1"]), 5);

    expect(selected.map((track) => track.providerTrackId)).toEqual([
      "track-0",
      "track-2",
      "track-3",
      "track-4",
      "track-5",
    ]);
  });

  it("buildMusicalBrief maps telemetry to energy/era/genre targets", () => {
    const fast = buildMusicalBrief(context); // highway + golden_hour, daytime
    expect(fast.targetEnergy).toBeGreaterThan(0.6);
    expect(fast.intensity).toBe("cinematic");
    expect(fast.genres.length).toBeGreaterThan(2);
    expect(fast.regionHint).toBe("Northern Italy");

    const calm = buildMusicalBrief({
      ...context,
      speedBucket: "parked",
      phase: "rest",
      localTimeIso: "2026-05-28T23:30:00.000Z",
    });
    expect(calm.targetEnergy).toBeLessThan(fast.targetEnergy);
    expect(calm.intensity).toBe("winding-down");
  });

  it("Adaptive Drive Mode (calm) lowers energy, leans familiar, and drops the surprise lens", () => {
    const neutral = buildMusicalBrief(context);
    const calm = buildMusicalBrief({
      ...context,
      driveState: {
        mode: "calm",
        reason: "heavy traffic",
        intensity: 0.8,
        signals: ["12 min traffic delay"],
      },
    });

    expect(calm.targetEnergy).toBeLessThan(neutral.targetEnergy);
    expect(calm.driveMode).toBe("calm");
    expect(calm.driveReason).toBe("heavy traffic");
    expect(calm.tasteWeight).toBeGreaterThan(neutral.tasteWeight);
    expect(calm.moodWords).toEqual(
      expect.arrayContaining(["calm", "instrumental-leaning"]),
    );
    // The deliberate "leftfield" surprise lens is dropped in calm.
    expect(selectJourneyLenses(calm).map((l) => l.key)).not.toContain(
      "leftfield_bridge",
    );
    // The drive-state line is injected into the lens prompt for Gemini.
    expect(buildLensPrompt(selectJourneyLenses(calm)[0], calm, 5)).toContain(
      "heavy traffic",
    );
  });

  it("Adaptive Drive Mode (focus) raises energy and stays engaging", () => {
    const neutral = buildMusicalBrief(context);
    const focus = buildMusicalBrief({
      ...context,
      driveState: {
        mode: "focus",
        reason: "long night drive",
        intensity: 0.5,
        signals: ["night highway"],
      },
    });
    expect(focus.targetEnergy).toBeGreaterThan(neutral.targetEnergy);
    expect(focus.driveMode).toBe("focus");
    expect(driveModePromptLine(focus)).toContain("engaging");
  });

  it("driveModePromptLine is empty when neutral", () => {
    expect(driveModePromptLine(buildMusicalBrief(context))).toBe("");
  });

  it("selectJourneyLenses adapts the scout lenses to the cinematic drive context", () => {
    const golden = buildMusicalBrief(context);
    expect(selectJourneyLenses(golden).map((lens) => lens.key)).toEqual([
      "cinematic_warmth",
      "local_language_hits",
      "steady_momentum",
      "regional_texture",
      "timeless_anchor",
    ]);

    const focus = buildMusicalBrief({
      ...context,
      phase: "focus",
      speedBucket: "highway",
      passengerMode: "solo",
      localTimeIso: "2026-05-28T23:30:00.000Z",
    });
    expect(selectJourneyLenses(focus).map((lens) => lens.key)).toContain(
      "low_distraction",
    );
  });

  it("family mode creates a clean current-pop policy and family-specific lenses", () => {
    const familyContext = {
      ...context,
      passengerMode: "family" as const,
      userPrompt: "uplifting, high-energy, feel-good momentum",
      countryName: "Germany",
    };
    const policy = buildRecommendationPolicy(familyContext);
    const brief = buildMusicalBrief(familyContext);

    expect(policy.cleanRequired).toBe(true);
    expect(policy.targetPopularity).toBeGreaterThanOrEqual(70);
    expect(policy.moodTags).toEqual(
      expect.arrayContaining(["dance-pop", "feelgood"]),
    );
    expect(brief.moodWords).toEqual(
      expect.arrayContaining(["clean", "singalong", "current-pop"]),
    );
    expect(brief.genres).toEqual(expect.arrayContaining(["pop", "dance-pop"]));
    // Family now seeds the Disney/animated singalong lens (kids are in the car) while keeping the
    // current-pop + good-mood lead for the adults.
    const familyLenses = selectJourneyLenses(brief).map((lens) => lens.key);
    expect(familyLenses).toEqual([
      "current_pop_hits",
      "good_mood",
      "kids_hits",
      "local_language_hits",
      "singalong_classics",
    ]);
  });

  it("family mode no longer penalizes beloved kid classics on recency, and seeds Disney fallbacks", () => {
    const familyPolicy = buildRecommendationPolicy({
      ...context,
      passengerMode: "family",
    });
    const soloPolicy = buildRecommendationPolicy({
      ...context,
      passengerMode: "solo",
    });
    // Was 0.78 (fresh-only) — now relaxed so timeless singalongs can surface.
    expect(familyPolicy.recencyBias).toBeLessThan(0.78);
    expect(familyPolicy.recencyBias).toBeGreaterThanOrEqual(
      soloPolicy.recencyBias,
    );

    // The family fallback pool now contains real animated-film singalongs, not just current pop.
    const fallbackArtists = fallbackCandidates(
      { ...context, passengerMode: "family" },
      50,
    ).map((candidate) => candidate.artist);
    expect(fallbackArtists).toContain("Idina Menzel");
  });

  it("kids mode stays clean, leads with the kids lens, and welcomes Disney/film singalongs", () => {
    const kidsContext = {
      ...context,
      kidsMode: true,
      userPrompt: "feel-good family drive",
    };
    const policy = buildRecommendationPolicy(kidsContext);
    const brief = buildMusicalBrief(kidsContext);

    // Inherits family's all-ages guardrails.
    expect(policy.cleanRequired).toBe(true);
    expect(brief.kidsMode).toBe(true);
    expect(brief.moodWords).toEqual(
      expect.arrayContaining(["disney", "kids", "singalong"]),
    );

    const lenses = selectJourneyLenses(brief);
    expect(lenses[0].key).toBe("kids_hits");
    expect(lenses.map((lens) => lens.key)).toContain("singalong_classics");

    // The prompt must explicitly ALLOW Disney/film picks (overriding family-mode's avoidance).
    const prompt = buildLensPrompt(lenses[0], brief, 5);
    expect(prompt).toMatch(/Disney/i);
    expect(prompt).not.toMatch(/novelty children-song/i);
  });

  it("kids mode resolves the all-ages mood profile for coherent energy/valence", () => {
    const kidsContext = {
      ...context,
      passengerMode: "solo" as const,
      kidsMode: true,
    };
    const brief = buildMusicalBrief(kidsContext);
    // Previously kids stayed on the time-of-day mood; now it shares family's all-ages profile.
    expect(brief.moodKey).toBe("family_singalong");
    expect(moodTagsForContext(kidsContext)).toEqual(
      expect.arrayContaining(["dance-pop", "feelgood"]),
    );
  });

  it("kids mode draws fallback candidates from the all-ages family pool, even solo", () => {
    const poolArtists = (ctx: JourneyContext) =>
      [
        ...new Set(
          fallbackCandidates(ctx, 50).map((candidate) => candidate.artist),
        ),
      ].sort();
    const kids = poolArtists({
      ...context,
      passengerMode: "solo",
      kidsMode: true,
    });
    const family = poolArtists({ ...context, passengerMode: "family" });
    const solo = poolArtists({ ...context, passengerMode: "solo" });
    // Kids (even on a solo drive) uses the same curated all-ages pool as family…
    expect(kids).toEqual(family);
    // …not the generic pool.
    expect(kids).not.toEqual(solo);
  });

  it("friends mode lifts energy with a crowd-pleasing good-mood lens", () => {
    const solo = buildMusicalBrief({ ...context, passengerMode: "solo" });
    const friends = buildMusicalBrief({ ...context, passengerMode: "friends" });
    expect(friends.targetEnergy).toBeGreaterThanOrEqual(solo.targetEnergy);
    expect(friends.moodWords).toEqual(
      expect.arrayContaining(["upbeat", "crowd-pleasing"]),
    );
    expect(selectJourneyLenses(friends).map((lens) => lens.key)).toContain(
      "good_mood",
    );
    const policy = buildRecommendationPolicy({
      ...context,
      passengerMode: "friends",
    });
    expect(policy.targetPopularity).toBe(66);
    expect(policy.preferDistinctArtists).toBe(true);
  });

  it("couple mode is warmer, calmer, and leans on shared discovery", () => {
    const solo = buildMusicalBrief({ ...context, passengerMode: "solo" });
    const couple = buildMusicalBrief({ ...context, passengerMode: "couple" });
    expect(couple.targetEnergy).toBeLessThanOrEqual(solo.targetEnergy);
    expect(couple.moodWords).toEqual(
      expect.arrayContaining(["warm", "intimate"]),
    );
    expect(selectJourneyLenses(couple).map((lens) => lens.key)).toContain(
      "cinematic_warmth",
    );
    // A couple gets a touch more discovery room than the solo baseline.
    const couplePolicy = buildRecommendationPolicy({
      ...context,
      passengerMode: "couple",
    });
    const soloPolicy = buildRecommendationPolicy({
      ...context,
      passengerMode: "solo",
    });
    expect(couplePolicy.targetDiscoveryRatio ?? 0).toBeGreaterThan(
      soloPolicy.targetDiscoveryRatio ?? 0,
    );
  });

  it("an active singalong wish steers lens selection toward singalong (pivots generation, not just ranking)", () => {
    const wishContext = {
      ...context,
      passengerMode: "solo" as const,
      activeMusicWishes: [
        {
          id: "w1",
          journeyId: "j1",
          rawText: "was zum Mitsingen",
          source: "chip",
          intents: [{ type: "role", role: "singalong", strength: 0.8 }],
          status: "active",
          confidence: 0.8,
          summary: "Mitsingen",
          pinned: true,
          expiresAfterTracks: 5,
          remainingTracks: 5,
          createdAtIso: "2026-05-28T18:00:00.000Z",
          updatedAtIso: "2026-05-28T18:00:00.000Z",
        },
      ],
    } as JourneyContext;
    const brief = buildMusicalBrief(wishContext);
    expect(brief.wishRoles).toContain("singalong");
    const keys = selectJourneyLenses(brief).map((lens) => lens.key);
    expect(keys).toContain("singalong_classics");
    expect(keys).toContain("good_mood");
  });

  it("local touch: a mapped country names the language and seeds a local lens, geo lenses only", () => {
    const franceBrief = buildMusicalBrief({
      ...context,
      countryName: "France",
      countryCode: "FR",
      coarseRegion: "Occitanie, France",
    });
    expect(franceBrief.localLanguage).toBe("French");
    expect(franceBrief.localDemonym).toBe("French");

    const lenses = selectJourneyLenses(franceBrief);
    const localLens = lenses.find((lens) => lens.key === "local_language_hits");
    const neutralLens = lenses.find(
      (lens) =>
        lens.key !== "local_language_hits" && lens.key !== "regional_texture",
    );
    expect(localLens).toBeDefined();
    expect(neutralLens).toBeDefined();

    // The local directive names the language and is scoped to the geo lenses only.
    expect(buildLensPrompt(localLens!, franceBrief, 5)).toMatch(
      /prioritize current, well-loved songs sung in French by homegrown French artists/i,
    );
    expect(buildLensPrompt(neutralLens!, franceBrief, 5)).not.toMatch(
      /Local touch/i,
    );
  });

  it("local touch: unmapped country falls back to inferring the local language from the place", () => {
    // context has coarseRegion "Northern Italy" but no countryCode → no language mapping.
    const brief = buildMusicalBrief(context);
    expect(brief.localLanguage).toBeUndefined();
    const localLens = selectJourneyLenses(brief).find(
      (lens) => lens.key === "local_language_hits",
    );
    expect(localLens).toBeDefined();
    expect(buildLensPrompt(localLens!, brief, 5)).toMatch(
      /LOCAL LANGUAGE of Northern Italy/i,
    );
  });

  it("lastfmTracksToCandidates maps geo/tag chart tracks into chart-aware candidates", () => {
    const candidates = lastfmTracksToCandidates(
      [
        {
          artist: "Miley Cyrus",
          title: "Flowers",
          rank: 1,
          playcount: 1000,
          country: "Germany",
          source: "lastfm-geo",
        },
        {
          artist: "Miley Cyrus",
          title: "Flowers",
          rank: 2,
          tag: "pop",
          source: "lastfm-tag",
        },
      ],
      context,
      ["pop", "feelgood"],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      artist: "Miley Cyrus",
      title: "Flowers",
      source: "lastfm",
      chartRank: 1,
      chartPlaycount: 1000,
      chartCountry: "Germany",
      chartSource: "lastfm-geo",
    });
  });

  it("lastfmTracksToCandidates drops Hörspiele from the German charts", () => {
    const candidates = lastfmTracksToCandidates(
      [
        {
          artist: "Die drei ???",
          title: "Folge 215",
          rank: 1,
          country: "Germany",
          source: "lastfm-geo",
        },
        {
          artist: "Miley Cyrus",
          title: "Flowers",
          rank: 2,
          country: "Germany",
          source: "lastfm-geo",
        },
      ],
      context,
      ["pop"],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].artist).toBe("Miley Cyrus");
  });

  it("rankResolvedTracksForPolicy excludes spoken-word when asked", () => {
    const policy = buildRecommendationPolicy(context);
    const mk = (artist: string, title: string) => ({
      provider: "spotify" as const,
      providerTrackId: `${artist}-${title}`,
      providerUri: `spotify:track:${artist}`,
      artist,
      title,
      matchConfidence: 0.9,
      matchReason: "x",
    });
    const tracks = [mk("Bibi Blocksberg", "Kapitel 1"), mk("Bonobo", "Kerala")];
    const ranked = rankResolvedTracksForPolicy(tracks, policy, {
      excludeSpokenWord: true,
    });
    expect(ranked.map((t) => t.artist)).toEqual(["Bonobo"]);
  });

  it("rankResolvedTracksForPolicy boosts charts/popularity, filters explicit family tracks, and penalizes artist fatigue", () => {
    const policy = buildRecommendationPolicy({
      ...context,
      passengerMode: "family",
    });
    const tracks: ResolvedTrack[] = [
      {
        provider: "spotify",
        providerTrackId: "explicit",
        providerUri: "spotify:track:explicit",
        artist: "A",
        title: "Explicit Hit",
        explicit: true,
        popularity: 99,
        matchConfidence: 0.99,
        matchReason: "artist and title match",
      },
      {
        provider: "spotify",
        providerTrackId: "chart",
        providerUri: "spotify:track:chart",
        artist: "B",
        title: "Chart Hit",
        explicit: false,
        popularity: 82,
        chartRank: 1,
        releaseDate: "2024-01-01",
        moodTags: ["pop"],
        matchConfidence: 0.9,
        matchReason: "artist and title match",
      },
      {
        provider: "spotify",
        providerTrackId: "tired",
        providerUri: "spotify:track:tired",
        artist: "Played Artist",
        title: "Known Song",
        explicit: false,
        popularity: 90,
        chartRank: 2,
        releaseDate: "2024-01-01",
        moodTags: ["pop"],
        matchConfidence: 0.92,
        matchReason: "artist and title match",
      },
    ];

    const ranked = rankResolvedTracksForPolicy(tracks, policy, {
      consumedArtists: ["Played Artist"],
      now: new Date("2026-06-03"),
    });

    expect(ranked.map((track) => track.providerTrackId)).toEqual([
      "chart",
      "tired",
    ]);
  });

  it("rankResolvedTracksForPolicy lifts a wished artist above an otherwise-stronger peer", () => {
    const policy: RecommendationPolicy = {
      ...buildRecommendationPolicy(context),
      artistBoosts: [{ artist: "Wished Artist", strength: 0.9 }],
    };
    const tracks: ResolvedTrack[] = [
      {
        provider: "spotify",
        providerTrackId: "strong",
        providerUri: "spotify:track:strong",
        artist: "Strong Artist",
        title: "Big Hit",
        explicit: false,
        popularity: 95,
        chartRank: 1,
        releaseDate: "2024-01-01",
        matchConfidence: 0.95,
        matchReason: "artist and title match",
      },
      {
        provider: "spotify",
        providerTrackId: "wished",
        providerUri: "spotify:track:wished",
        artist: "Wished Artist",
        title: "Modest Song",
        explicit: false,
        popularity: 55,
        matchConfidence: 0.7,
        matchReason: "artist and title match",
      },
    ];

    const withoutWish = rankResolvedTracksForPolicy(
      tracks,
      buildRecommendationPolicy(context),
      { now: new Date("2026-06-03") },
    );
    expect(withoutWish[0].providerTrackId).toBe("strong");

    const ranked = rankResolvedTracksForPolicy(tracks, policy, {
      now: new Date("2026-06-03"),
    });
    expect(ranked[0].providerTrackId).toBe("wished");
  });

  it("rankResolvedTracksForPolicy demotes tracks carrying an avoided mood tag", () => {
    const policy: RecommendationPolicy = {
      ...buildRecommendationPolicy(context),
      avoidMoodTags: ["mellow"],
    };
    const tracks: ResolvedTrack[] = [
      {
        provider: "spotify",
        providerTrackId: "mellow",
        providerUri: "spotify:track:mellow",
        artist: "Calm Artist",
        title: "Slow One",
        explicit: false,
        popularity: 90,
        chartRank: 1,
        releaseDate: "2024-01-01",
        moodTags: ["mellow"],
        matchConfidence: 0.95,
        matchReason: "artist and title match",
      },
      {
        provider: "spotify",
        providerTrackId: "neutral",
        providerUri: "spotify:track:neutral",
        artist: "Other Artist",
        title: "Bright One",
        explicit: false,
        popularity: 70,
        matchConfidence: 0.75,
        matchReason: "artist and title match",
      },
    ];

    const ranked = rankResolvedTracksForPolicy(tracks, policy, {
      now: new Date("2026-06-03"),
    });
    expect(ranked[0].providerTrackId).toBe("neutral");
  });

  it("buildJourneySet creates a five-track cinematic set with roles and diversity", () => {
    const candidates: SongCandidate[] = [
      {
        artist: "A",
        title: "Anchor",
        year: 2024,
        genre: "electronic",
        reason: "",
        source: "gemini",
        confidence: 0.9,
      },
      {
        artist: "B",
        title: "Drive",
        year: 2023,
        genre: "rock",
        reason: "",
        source: "gemini",
        confidence: 0.88,
      },
      {
        artist: "C",
        title: "Bridge",
        year: 1998,
        genre: "soul",
        reason: "",
        source: "gemini",
        confidence: 0.82,
      },
      {
        artist: "D",
        title: "Surprise",
        year: 2014,
        genre: "hip-hop",
        reason: "",
        source: "gemini",
        confidence: 0.79,
      },
      {
        artist: "E",
        title: "Resolve",
        year: 1979,
        genre: "ambient",
        reason: "",
        source: "gemini",
        confidence: 0.76,
      },
      {
        artist: "A",
        title: "Duplicate Artist",
        year: 2020,
        genre: "electronic",
        reason: "",
        source: "gemini",
        confidence: 0.95,
      },
      {
        artist: "F",
        title: "Another Pulse",
        year: 2022,
        genre: "electronic",
        reason: "",
        source: "gemini",
        confidence: 0.91,
      },
    ];

    const set = buildJourneySet(candidates, buildMusicalBrief(context), 5);

    expect(set).toHaveLength(5);
    expect(set.map((candidate) => candidate.role)).toEqual([
      "anchor",
      "momentum",
      "bridge",
      "surprise",
      "resolution",
    ]);
    expect(new Set(set.map((candidate) => candidate.artist))).toHaveLength(5);
    expect(new Set(set.map((candidate) => candidate.genre))).toHaveLength(5);
    expect(
      set.every((candidate) => candidate.scores && candidate.scores.total > 0),
    ).toBe(true);
  });

  it("orderByEnergyArc follows the curve, keeps the opener, and smooths transitions", () => {
    type Item = { id: string; energy: number; valence: number };
    const energyOf = (item: Item) => item.energy;
    const valenceOf = (item: Item) => item.valence;
    // A rising curve; deliberately shuffle items so a naive pass would whiplash.
    const curve = [0.2, 0.4, 0.6, 0.8, 0.95];
    const items: Item[] = [
      { id: "open", energy: 0.2, valence: 0.5 },
      { id: "hi", energy: 0.95, valence: 0.5 },
      { id: "lo", energy: 0.35, valence: 0.5 },
      { id: "mid", energy: 0.6, valence: 0.5 },
      { id: "peak", energy: 0.85, valence: 0.5 },
    ];

    const ordered = orderByEnergyArc(items, curve, energyOf, valenceOf, {
      keepFirst: true,
    });

    // Opener is pinned; the rest climb with the curve rather than jumping around.
    expect(ordered.map((item) => item.id)).toEqual([
      "open",
      "lo",
      "mid",
      "peak",
      "hi",
    ]);
    // No adjacent whiplash: every step is a gentle climb, never a big drop.
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].energy).toBeGreaterThanOrEqual(ordered[i - 1].energy);
    }
  });

  it("buildJourneySet keeps the LLM energy estimates on the sequenced set", () => {
    const brief = buildMusicalBrief(context);
    const cands: SongCandidate[] = [
      {
        artist: "A",
        title: "1",
        genre: "ambient",
        energy: 0.2,
        valence: 0.4,
        reason: "",
        source: "gemini",
        confidence: 0.9,
      },
      {
        artist: "B",
        title: "2",
        genre: "electronic",
        energy: 0.9,
        valence: 0.6,
        reason: "",
        source: "gemini",
        confidence: 0.88,
      },
      {
        artist: "C",
        title: "3",
        genre: "indie",
        energy: 0.55,
        valence: 0.5,
        reason: "",
        source: "gemini",
        confidence: 0.85,
      },
      {
        artist: "D",
        title: "4",
        genre: "soul",
        energy: 0.45,
        valence: 0.5,
        reason: "",
        source: "gemini",
        confidence: 0.83,
      },
      {
        artist: "E",
        title: "5",
        genre: "rock",
        energy: 0.8,
        valence: 0.5,
        reason: "",
        source: "gemini",
        confidence: 0.8,
      },
    ];

    const set = buildJourneySet(cands, brief, 5);
    expect(set).toHaveLength(5);
    expect(set.map((candidate) => candidate.role)).toEqual([
      "anchor",
      "momentum",
      "bridge",
      "surprise",
      "resolution",
    ]);
    // Sequencing is a permutation: every per-track energy estimate survives intact for downstream
    // curve-fit and flow, and the set is still five distinct songs.
    expect(set.every((candidate) => typeof candidate.energy === "number")).toBe(
      true,
    );
    expect(new Set(set.map((candidate) => candidate.energy)).size).toBe(5);
  });

  it("buildRecommendationPolicy sets the discovery dial from the trip archetype", () => {
    const errand = buildRecommendationPolicy({
      ...context,
      etaMinutes: undefined,
      plannedDurationMinutes: 15,
    });
    const longHaul = buildRecommendationPolicy({
      ...context,
      etaMinutes: undefined,
      plannedDurationMinutes: 300,
    });
    expect(errand.targetDiscoveryRatio as number).toBeLessThan(
      longHaul.targetDiscoveryRatio as number,
    );
    // Errands stay familiar; long hauls open up to discovery.
    expect(errand.targetDiscoveryRatio as number).toBeLessThanOrEqual(0.2);
    expect(longHaul.targetDiscoveryRatio as number).toBeGreaterThanOrEqual(0.5);
  });

  it("selectJourneyLenses keeps errands familiar — no slow regional or leftfield discovery", () => {
    const brief = buildMusicalBrief({
      ...context,
      etaMinutes: undefined,
      plannedDurationMinutes: 15,
    });
    expect(brief.tripArchetype).toBe("errand");
    const lenses = selectJourneyLenses(brief).map((lens) => lens.key);
    expect(lenses).toContain("taste_anchor");
    expect(lenses).not.toContain("regional_texture");
    expect(lenses).not.toContain("leftfield_bridge");
    expect(lenses.length).toBeLessThanOrEqual(5);
  });

  it("targetDiscoveryRatio shifts ranking between hits and lesser-known cuts", () => {
    const mk = (
      id: string,
      artist: string,
      title: string,
      pop: number,
    ): ResolvedTrack => ({
      provider: "spotify",
      providerTrackId: id,
      providerUri: `spotify:track:${id}`,
      artist,
      title,
      explicit: false,
      popularity: pop,
      matchConfidence: 0.9,
      matchReason: "artist and title match",
    });
    const tracks: ResolvedTrack[] = [
      mk("hit", "Hit Artist", "Hit Song", 95),
      mk("cut", "Cut Artist", "Deep Cut", 35),
    ];
    const hitsRanked = rankResolvedTracksForPolicy(
      tracks,
      { ...buildRecommendationPolicy(context), targetDiscoveryRatio: 0 },
      { now: new Date("2026-06-03") },
    );
    const discoverRanked = rankResolvedTracksForPolicy(
      tracks,
      { ...buildRecommendationPolicy(context), targetDiscoveryRatio: 0.9 },
      { now: new Date("2026-06-03") },
    );
    expect(hitsRanked[0].providerTrackId).toBe("hit");
    expect(discoverRanked[0].providerTrackId).toBe("cut");
  });

  it("balanceCandidates dedupes and spreads across decades/genres/artists", () => {
    const brief = buildMusicalBrief(context);
    const cands: SongCandidate[] = [
      {
        artist: "A",
        title: "1",
        year: 1985,
        genre: "rock",
        reason: "",
        source: "gemini",
        confidence: 0.8,
      },
      {
        artist: "A",
        title: "1",
        year: 1985,
        genre: "rock",
        reason: "",
        source: "gemini",
        confidence: 0.8,
      }, // dup
      {
        artist: "B",
        title: "2",
        year: 1986,
        genre: "rock",
        reason: "",
        source: "gemini",
        confidence: 0.7,
      },
      {
        artist: "C",
        title: "3",
        year: 2024,
        genre: "electronic",
        reason: "",
        source: "gemini",
        confidence: 0.6,
      },
      {
        artist: "D",
        title: "4",
        year: 1995,
        genre: "pop",
        reason: "",
        source: "gemini",
        confidence: 0.5,
      },
    ];
    const out = balanceCandidates(cands, brief, 3);
    expect(out).toHaveLength(3);
    expect(out.filter((c) => c.artist === "A")).toHaveLength(1); // deduped
    const decades = new Set(
      out.map((c) => Math.floor((c.year ?? 0) / 10) * 10),
    );
    expect(decades.size).toBeGreaterThanOrEqual(2); // spread across eras, not all 1980s
  });

  it("deriveTasteProfile aggregates genres by frequency and caps representative artists", () => {
    const profile = deriveTasteProfile(
      [
        { name: "Bonobo", genres: ["electronica", "downtempo", "trip hop"] },
        { name: "Tycho", genres: ["electronica", "chillwave"] },
        { name: "Tame Impala", genres: ["psychedelic rock", "electronica"] },
        { name: "Khruangbin", genres: ["psychedelic rock", "funk"] },
        { name: "Air", genres: ["downtempo"] },
        { name: "Caribou", genres: [] },
      ],
      { maxGenres: 3, maxArtists: 4 },
    );

    // electronica appears 3x, then downtempo + psychedelic rock (2x each) -> top 3.
    expect(profile.topGenres[0]).toBe("electronica");
    expect(profile.topGenres).toHaveLength(3);
    expect(profile.topGenres).toContain("downtempo");
    expect(profile.topGenres).toContain("psychedelic rock");
    // Representative artists are capped and preserve input order.
    expect(profile.representativeArtists).toEqual([
      "Bonobo",
      "Tycho",
      "Tame Impala",
      "Khruangbin",
    ]);
  });

  it("deriveTasteProfile is empty-safe", () => {
    const profile = deriveTasteProfile([]);
    expect(profile.topGenres).toEqual([]);
    expect(profile.representativeArtists).toEqual([]);
  });

  it("buildMusicalBrief folds the taste profile into favored genres + weight", () => {
    const brief = buildMusicalBrief({
      ...context,
      tasteWeight: 0.75,
      tasteProfile: {
        topGenres: ["electronica", "indie"],
        representativeArtists: ["Bonobo", "Tycho"],
      },
    });
    expect(brief.tasteWeight).toBeCloseTo(0.75);
    expect(brief.favoredGenres).toEqual(["electronica", "indie"]);
    expect(brief.representativeArtists).toEqual(["Bonobo", "Tycho"]);

    // No taste signal -> neutral defaults, never undefined.
    const neutral = buildMusicalBrief(context);
    expect(neutral.tasteWeight).toBe(0);
    expect(neutral.favoredGenres).toEqual([]);
    expect(neutral.representativeArtists).toEqual([]);
  });

  it("buildLensPrompt steers familiar lenses by taste but keeps cross-genre as pure discovery", () => {
    const brief = buildMusicalBrief({
      ...context,
      tasteWeight: 0.75,
      tasteProfile: {
        topGenres: ["electronica", "indie"],
        representativeArtists: ["Bonobo"],
      },
    });
    const current = DEFAULT_LENSES.find((lens) => lens.key === "current")!;
    const crossgenre = DEFAULT_LENSES.find(
      (lens) => lens.key === "crossgenre",
    )!;

    const currentPrompt = buildLensPrompt(current, brief, 5);
    expect(currentPrompt).toMatch(/75%/);
    expect(currentPrompt.toLowerCase()).toContain("electronica");
    expect(currentPrompt.toLowerCase()).toContain("bonobo");

    // The discovery lens must NOT be biased toward the listener's taste.
    const crossPrompt = buildLensPrompt(crossgenre, brief, 5);
    expect(crossPrompt).not.toMatch(/%/);

    // With no taste weight, even familiar lenses stay neutral.
    const neutralBrief = buildMusicalBrief(context);
    expect(buildLensPrompt(current, neutralBrief, 5)).not.toMatch(/%/);
  });

  it("MultiLensSongScout fans out lenses and balances; falls back in mock mode", async () => {
    const scout = new MultiLensSongScout({
      apiKey: "k",
      baseUrl: "https://gemini.test/v1beta",
      model: "gemini-3.5-flash",
      mock: false,
      perLensCount: 2,
      lensRunner: async (lens) => [
        {
          artist: `${lens.key}-artist`,
          title: "t",
          year: lens.key === "classics" ? 1979 : 2025,
          genre: lens.key,
          reason: "",
          source: "gemini",
          confidence: 0.8,
        },
      ],
    });
    const out = await scout.generateCandidates(context, 4);
    expect(out.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThanOrEqual(4);

    const mockScout = new MultiLensSongScout({
      apiKey: "k",
      baseUrl: "x",
      model: "m",
      mock: true,
    });
    expect(await mockScout.generateCandidates(context, 5)).toHaveLength(5);
  });
});

describe("buildMusicalBrief — time/trip/mood", () => {
  const base: JourneyContext = {
    destination: "Lake",
    localTimeIso: "2026-06-04T02:00:00", // 02:00 local → deep_night
    speedBucket: "highway",
    phase: "cruise",
    userPrompt: "road trip to the coast",
    passengerMode: "solo",
  } as JourneyContext;

  it("deep-night long haul keeps energy at the alertness floor even under calm mode", () => {
    const brief = buildMusicalBrief({
      ...base,
      plannedDurationMinutes: 360,
      elapsedMinutes: 200,
      etaMinutes: 160,
      driveState: {
        mode: "calm",
        reason: "long drive",
        intensity: 1,
        signals: [],
      },
    });
    expect(brief.moodKey).toBe("night_cruise");
    expect(brief.timeBand).toBe("deep_night");
    expect(brief.fatigueRisk).toBeGreaterThan(0);
    // calm mode would push energy well below the floor; the floor must hold it up.
    expect(brief.targetEnergy).toBeGreaterThanOrEqual(0.5);
    // the energy curve must reflect the floored energy too (max point >= ~floor)
    expect(Math.max(...brief.energyCurve)).toBeGreaterThanOrEqual(0.5);
    // floor propagates to the whole curve, not just the target
    expect(Math.min(...brief.energyCurve)).toBeGreaterThanOrEqual(0.5);
    expect(brief.moodWords).toContain("wakeful");
  });

  it("midday short trip is brighter and higher energy than deep night", () => {
    const brief = buildMusicalBrief({
      ...base,
      localTimeIso: "2026-06-04T12:00:00",
      plannedDurationMinutes: 40,
      elapsedMinutes: 10,
      etaMinutes: 30,
    });
    expect(brief.moodKey).toBe("bright_day");
    expect(brief.timeBand).toBe("midday");
    expect(brief.fatigueRisk).toBe(0);
    expect(brief.valence).toBeGreaterThan(0.5);
  });

  it("a short late-night drive is calmer than a midday drive (no floor)", () => {
    const night = buildMusicalBrief({
      ...base,
      localTimeIso: "2026-06-04T22:00:00",
      plannedDurationMinutes: 30,
      elapsedMinutes: 5,
      etaMinutes: 25,
    });
    const day = buildMusicalBrief({
      ...base,
      localTimeIso: "2026-06-04T12:00:00",
      plannedDurationMinutes: 30,
      elapsedMinutes: 5,
      etaMinutes: 25,
    });
    expect(night.fatigueRisk).toBe(0); // "night" band + short trip => below risk threshold
    expect(night.targetEnergy).toBeLessThan(day.targetEnergy);
  });
});

describe("buildMusicalBrief — trip feeling (archetype/weather/nowPlaying/leg)", () => {
  const base: JourneyContext = {
    destination: "Lake",
    localTimeIso: "2026-06-15T08:00:00", // Monday morning
    speedBucket: "city",
    phase: "departure",
    userPrompt: "drive",
    passengerMode: "solo",
  } as JourneyContext;

  it("classifies a short weekend hop as an errand and flattens the opening build", () => {
    const brief = buildMusicalBrief({
      ...base,
      localTimeIso: "2026-06-14T10:00:00", // Sunday
      plannedDurationMinutes: 20,
      elapsedMinutes: 1,
      etaMinutes: 18,
      tasteWeight: 0.4,
    });
    expect(brief.tripArchetype).toBe("errand");
    // familiarity bias raised the taste weight above the base
    expect(brief.tasteWeight).toBeGreaterThan(0.4);
    // no slow opening: the whole curve sits in a tight band around target (no build/dip)
    const spread =
      Math.max(...brief.energyCurve) - Math.min(...brief.energyCurve);
    expect(spread).toBeLessThanOrEqual(0.03);
  });

  it("classifies a weekday morning 45-min drive as a commute", () => {
    const brief = buildMusicalBrief({
      ...base,
      plannedDurationMinutes: 45,
      elapsedMinutes: 5,
      etaMinutes: 40,
    });
    expect(brief.tripArchetype).toBe("commute");
    expect(brief.dayContext).toBe("monday_morning");
  });

  it("keeps a full opening build on a long haul", () => {
    const brief = buildMusicalBrief({
      ...base,
      plannedDurationMinutes: 600,
      elapsedMinutes: 10,
      etaMinutes: 590,
    });
    expect(brief.tripArchetype).toBe("long_haul");
    expect(brief.tripSegment).toBe("opening");
  });

  it("threads weatherFeel, nowPlaying and legIndex into the brief and prompt", () => {
    const brief = buildMusicalBrief({
      ...base,
      weatherFeel: "warm and golden",
      nowPlaying: { artist: "Khruangbin", title: "Maria Tambien" },
      legIndex: 2,
      plannedDurationMinutes: 600,
      elapsedMinutes: 200,
      etaMinutes: 400,
    });
    expect(brief.weatherFeel).toBe("warm and golden");
    expect(brief.nowPlaying).toEqual({
      artist: "Khruangbin",
      title: "Maria Tambien",
    });
    expect(brief.legIndex).toBe(2);
    const prompt = buildLensPrompt(selectJourneyLenses(brief)[0], brief, 5);
    expect(prompt).toMatch(/Now playing: "Maria Tambien" by Khruangbin/);
    expect(prompt).toMatch(/leg 3 of the journey/);
    expect(prompt).toMatch(/Trip shape: long_haul/);
  });

  it("omits the nowPlaying and leg lines when absent", () => {
    const brief = buildMusicalBrief({
      ...base,
      plannedDurationMinutes: 600,
      elapsedMinutes: 10,
      etaMinutes: 590,
    });
    const prompt = buildLensPrompt(selectJourneyLenses(brief)[0], brief, 5);
    expect(prompt).not.toMatch(/Now playing:/);
    expect(prompt).not.toMatch(/leg \d+ of the journey/);
  });

  it("reopens the arc per leg after a charge stop (global 'deep' → leg 'opening')", () => {
    // 500 min into a 600 min haul → global progress ~0.83 = "deep".
    const deepInTrip = {
      ...base,
      plannedDurationMinutes: 600,
      elapsedMinutes: 500,
      etaMinutes: 100,
    } as JourneyContext;

    const beforeStop = buildMusicalBrief(deepInTrip);
    expect(beforeStop.tripArchetype).toBe("long_haul");
    expect(beforeStop.tripSegment).toBe("deep");

    // Just resumed from a charge stop: leg-local elapsed is tiny → the leg opens fresh, while the
    // whole-trip archetype stays long_haul (more exploration).
    const afterStop = buildMusicalBrief({
      ...deepInTrip,
      legIndex: 1,
      legElapsedMinutes: 3,
    });
    expect(afterStop.tripArchetype).toBe("long_haul");
    expect(afterStop.tripSegment).toBe("opening");
    // Opening shape: starts below its own build (first point is the lowest of the curve).
    expect(afterStop.energyCurve[0]).toBe(Math.min(...afterStop.energyCurve));
  });
});

describe("moodTagsForContext — mood-driven", () => {
  it("returns the night_cruise tags for a night drive", () => {
    const tags = moodTagsForContext({
      destination: "Lake",
      localTimeIso: "2026-06-04T23:00:00",
      speedBucket: "highway",
      phase: "cruise",
      userPrompt: "road trip",
      passengerMode: "solo",
      elapsedMinutes: 30,
      etaMinutes: 120,
    } as JourneyContext);
    expect(tags).toContain("synthwave");
  });

  it("returns family tags in family mode", () => {
    const tags = moodTagsForContext({
      destination: "Zoo",
      localTimeIso: "2026-06-04T12:00:00",
      speedBucket: "city",
      phase: "cruise",
      userPrompt: "fun day out",
      passengerMode: "family",
    } as JourneyContext);
    expect(tags).toContain("dance-pop");
  });
});

describe("buildLensPrompt — valence", () => {
  it("includes a valence line", () => {
    const brief = buildMusicalBrief({
      destination: "Lake",
      localTimeIso: "2026-06-04T12:00:00",
      speedBucket: "highway",
      phase: "cruise",
      userPrompt: "road trip",
      passengerMode: "solo",
      elapsedMinutes: 10,
      etaMinutes: 30,
    } as JourneyContext);
    const prompt = buildLensPrompt(DEFAULT_LENSES[0], brief, 5);
    expect(prompt.toLowerCase()).toContain("valence");
  });

  it("surfaces skipped moods so the scout steers away from them", () => {
    const brief = buildMusicalBrief({
      destination: "Lake",
      localTimeIso: "2026-06-04T12:00:00",
      speedBucket: "highway",
      phase: "cruise",
      userPrompt: "road trip",
      passengerMode: "solo",
      elapsedMinutes: 10,
      etaMinutes: 30,
      skippedMoodTags: ["melancholic", "ambient"],
    } as JourneyContext);
    const prompt = buildLensPrompt(DEFAULT_LENSES[0], brief, 5).toLowerCase();
    expect(prompt).toContain("skipping these moods");
    expect(prompt).toContain("melancholic");
    expect(prompt).toContain("ambient");
  });
});

describe("engine v2 lenses", () => {
  it("appends the deep_cuts explorer lens when requested", () => {
    const brief = buildMusicalBrief(context);
    const without = selectJourneyLenses(brief);
    expect(without.some((lens) => lens.key === "deep_cuts")).toBe(false);

    const withExplorer = selectJourneyLenses(brief, { includeDeepCuts: true });
    expect(withExplorer.some((lens) => lens.key === "deep_cuts")).toBe(true);
    expect(withExplorer.length).toBe(without.length + 1); // zusätzlicher Call, verdrängt nichts
  });

  it("regional lens demands real place connection via web search", () => {
    const lens = DEFAULT_LENSES.find((l) => l.key === "regional")!;
    const brief = buildMusicalBrief(context);
    const prompt = buildLensPrompt(lens, brief, 5);
    expect(prompt.toLowerCase()).toContain("web search");
    expect(prompt.toLowerCase()).toMatch(/region|destination/);
  });
});

describe("telemetry fusion", () => {
  it("surfaces traffic, accel style and quiet cabin as drive signals", () => {
    const brief = buildMusicalBrief({
      ...context,
      trafficDelayMinutes: 14,
      accelStyle: "stop_and_go",
      quietCabin: true,
    });
    expect(brief.driveSignals).toEqual(
      expect.arrayContaining(["heavy_traffic", "stop_and_go", "quiet_cabin"]),
    );
  });

  it("heavy traffic dampens energy unless a wake-up bias is active", () => {
    const calm = buildMusicalBrief({ ...context, trafficDelayMinutes: 14 });
    const base = buildMusicalBrief(context);
    expect(calm.targetEnergy).toBeLessThan(base.targetEnergy);

    const awake = buildMusicalBrief({
      ...context,
      trafficDelayMinutes: 14,
      energyBias: 0.15,
    });
    expect(awake.targetEnergy).toBeGreaterThanOrEqual(base.targetEnergy);
  });
});

describe("overnight vacation drive — mood transitions", () => {
  function briefAt(localTimeIso: string, elapsedMinutes: number) {
    return buildMusicalBrief({
      destination: "Coast",
      localTimeIso,
      speedBucket: "highway",
      phase: "cruise",
      userPrompt: "long drive to the coast",
      passengerMode: "solo",
      plannedDurationMinutes: 420,
      elapsedMinutes,
      etaMinutes: Math.max(20, 420 - elapsedMinutes),
    } as JourneyContext);
  }

  it("moves night_cruise → dawn_lift → bright_day and stays alert at night", () => {
    const night = briefAt("2026-06-04T01:00:00", 60);
    const dawn = briefAt("2026-06-04T05:00:00", 300);
    // elapsedMinutes=180: progress=180/420≈0.43 → "body" segment, not "closing".
    // etaMinutes=max(20,420-180)=240. Hour 08:00 → morning band → bright_day.
    const morning = briefAt("2026-06-04T08:00:00", 180);

    expect(night.moodKey).toBe("night_cruise");
    expect(dawn.moodKey).toBe("dawn_lift");
    expect(morning.moodKey).toBe("bright_day");

    // Deep-night + long elapsed → fatigue floor keeps energy up.
    expect(night.fatigueRisk).toBeGreaterThan(0);
    expect(night.targetEnergy).toBeGreaterThanOrEqual(0.5);

    // Daytime brighter than night.
    expect(morning.valence).toBeGreaterThan(night.valence);
  });
});

describe("scout grounding", () => {
  it("buildMusicalBrief surfaces weather, exploration angle and recently-played avoids", () => {
    const brief = buildMusicalBrief({
      ...context,
      weatherFeel: "warm and clear",
      varietyAngle: "favor a different era than the most obvious one",
      recentlyPlayedArtists: ["Dua Lipa", "The Weeknd"],
    });
    expect(brief.weatherFeel).toBe("warm and clear");
    expect(brief.explorationAngle).toBe(
      "favor a different era than the most obvious one",
    );
    expect(brief.avoidRecentArtists).toEqual(["Dua Lipa", "The Weeknd"]);
  });

  it("buildLensPrompt mentions the exploration angle and avoid list", () => {
    const brief = buildMusicalBrief({
      ...context,
      varietyAngle: "surface a less-obvious facet of the mood",
      recentlyPlayedArtists: ["Dua Lipa"],
    });
    const prompt = buildLensPrompt(DEFAULT_LENSES[0], brief, 5);
    expect(prompt).toContain("surface a less-obvious facet of the mood");
    expect(prompt).toContain("Dua Lipa");
  });
});

describe("variety-aware ranking", () => {
  function trackOf(id: string, artist: string, title: string, pop: number) {
    return {
      provider: "spotify" as const,
      providerTrackId: id,
      providerUri: `spotify:track:${id}`,
      artist,
      title,
      explicit: false,
      popularity: pop,
      matchConfidence: 0.9,
      matchReason: "artist and title match",
    };
  }

  it("seeded jitter reorders near-equal tracks but never inverts a clear fit gap", () => {
    const policy = buildRecommendationPolicy(context);
    const near: ResolvedTrack[] = [
      trackOf("a", "Artist A", "Song A", 70),
      trackOf("b", "Artist B", "Song B", 70),
      trackOf("c", "Artist C", "Song C", 70),
    ];
    const seedX = rankResolvedTracksForPolicy(near, policy, {
      now: new Date("2026-06-03"),
      seed: 1,
      jitterStrength: 0.06,
    }).map((t) => t.providerTrackId);
    const seedY = rankResolvedTracksForPolicy(near, policy, {
      now: new Date("2026-06-03"),
      seed: 999,
      jitterStrength: 0.06,
    }).map((t) => t.providerTrackId);
    expect(seedX).not.toEqual(seedY);
    expect([...seedX].sort()).toEqual([...seedY].sort());

    const gap: ResolvedTrack[] = [
      trackOf("weak", "Weak", "Weak", 30),
      {
        ...trackOf("strong", "Strong", "Strong", 99),
        matchConfidence: 0.99,
        chartRank: 1,
      },
    ];
    const ranked = rankResolvedTracksForPolicy(gap, policy, {
      now: new Date("2026-06-03"),
      seed: 7,
      jitterStrength: 0.06,
    });
    expect(ranked[0].providerTrackId).toBe("strong");
  });

  it("recent-fatigue penalizes recent songs/artists and exempts wish artists", () => {
    const policy = buildRecommendationPolicy(context);
    // Equal popularity so the discovery dial can't differentiate them: tired is at index=0 so its
    // base score is fractionally higher (no index tiebreaker penalty); this lets a large
    // recentSongPenalty (0.5) flip the result, and removal of the penalty restores it.
    const tracks: ResolvedTrack[] = [
      trackOf("tired", "Tired Artist", "Tired Song", 88),
      trackOf("fresh", "Fresh Artist", "Fresh Song", 88),
    ];
    const ranked = rankResolvedTracksForPolicy(tracks, policy, {
      now: new Date("2026-06-03"),
      recentSongPenalty: new Map([
        [songKey("Tired Artist", "Tired Song"), 0.5],
      ]),
    });
    expect(ranked[0].providerTrackId).toBe("fresh");

    const exempt = rankResolvedTracksForPolicy(tracks, policy, {
      now: new Date("2026-06-03"),
      recentSongPenalty: new Map([
        [songKey("Tired Artist", "Tired Song"), 0.5],
      ]),
      fatigueExemptArtists: ["Tired Artist"],
    });
    expect(exempt[0].providerTrackId).toBe("tired");
  });
});

describe("artist ban ranking", () => {
  function bTrack(id: string, artist: string) {
    return {
      provider: "spotify" as const,
      providerTrackId: id,
      providerUri: `spotify:track:${id}`,
      artist,
      title: `Song ${id}`,
      explicit: false,
      popularity: 80,
      matchConfidence: 0.9,
      matchReason: "artist and title match",
    };
  }

  it("hard-excludes banned artists but never exempted ones", () => {
    const policy = buildRecommendationPolicy(context);
    const tracks: ResolvedTrack[] = [
      bTrack("a", "Banned Star"),
      bTrack("b", "Fresh Find"),
    ];

    const ranked = rankResolvedTracksForPolicy(tracks, policy, {
      now: new Date("2026-06-11"),
      bannedArtists: new Set([normalizeText("Banned Star")]),
    });
    expect(ranked.map((t) => t.providerTrackId)).toEqual(["b"]);

    const exempt = rankResolvedTracksForPolicy(tracks, policy, {
      now: new Date("2026-06-11"),
      bannedArtists: new Set([normalizeText("Banned Star")]),
      fatigueExemptArtists: ["Banned Star"],
    });
    expect(exempt.map((t) => t.providerTrackId).sort()).toEqual(["a", "b"]);
  });
});

describe("releaseRecencyScore date-based curve", () => {
  const now = new Date("2026-06-26T00:00:00Z");
  it("scores brand-new releases highest and decays by days", () => {
    expect(releaseRecencyScore("2026-06-10", now, true)).toBe(1);
    expect(releaseRecencyScore("2026-04-01", now, true)).toBeCloseTo(0.85, 2);
    expect(releaseRecencyScore("2025-10-01", now, true)).toBeCloseTo(0.6, 2);
    // a classic stays above the legacy floor, never crashes to 0
    expect(releaseRecencyScore("1999-01-01", now, true)).toBeGreaterThanOrEqual(
      0.18,
    );
  });
  it("falls back to year-buckets when dateScoring is off", () => {
    expect(releaseRecencyScore("2026-01-01", now, false)).toBe(1);
    expect(releaseRecencyScore("2020-01-01", now, false)).toBeCloseTo(0.58, 2);
  });
  it("returns the neutral default for a missing date", () => {
    expect(releaseRecencyScore(undefined, now, true)).toBe(0.35);
  });
});

describe("current lens grounding", () => {
  const makeJourneyContext = (
    overrides: Partial<JourneyContext>,
  ): JourneyContext => ({
    destination: "Hamburg",
    coarseRegion: "Northern Germany",
    localTimeIso: "2026-06-26T14:00:00.000Z",
    etaMinutes: 60,
    speedBucket: "highway",
    phase: "cruise",
    userPrompt: "upbeat drive",
    passengerMode: "solo",
    ...overrides,
  });

  it("injects real releases into the current lens prompt", () => {
    const ctx = makeJourneyContext({
      currentReleases: ["Bonobo – Fresh Drop", "Fresh Act – Chart Newcomer"],
    });
    const brief = buildMusicalBrief(ctx);
    const currentLens = DEFAULT_LENSES.find((l) => l.key === "current")!;
    const prompt = buildLensPrompt(currentLens, brief, 5);
    expect(prompt).toContain("Bonobo – Fresh Drop");
  });

  it("does not inject for non-current lenses", () => {
    const ctx = makeJourneyContext({
      currentReleases: ["Bonobo – Fresh Drop"],
    });
    const brief = buildMusicalBrief(ctx);
    const classics = DEFAULT_LENSES.find((l) => l.key === "classics")!;
    expect(buildLensPrompt(classics, brief, 5)).not.toContain("Fresh Drop");
  });
});
