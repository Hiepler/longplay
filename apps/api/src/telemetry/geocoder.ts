export interface GeocoderOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface GeocodeResult {
  coarseRegion?: string;
  countryName?: string;
  countryCode?: string;
  geoSource: "reverse-geocode";
}

const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";

/** Rounds to ~0.1° (~11 km) so a coarse area maps to one cache bucket. */
function bucket(lat: number, lon: number): string {
  return `${lat.toFixed(1)},${lon.toFixed(1)}`;
}

function regionFromAddress(
  address: Record<string, unknown> | undefined,
): string | undefined {
  if (!address) return undefined;
  const area =
    (address.state as string) ||
    (address.region as string) ||
    (address.county as string) ||
    (address.city as string) ||
    (address.town as string);
  const country = address.country as string | undefined;
  if (area && country) return `${area}, ${country}`;
  return area || country || undefined;
}

function geocodeFromAddress(
  address: Record<string, unknown> | undefined,
): GeocodeResult | undefined {
  const coarseRegion = regionFromAddress(address);
  const countryName = address?.country as string | undefined;
  const countryCode =
    typeof address?.country_code === "string"
      ? address.country_code.toUpperCase()
      : undefined;
  if (!coarseRegion && !countryName && !countryCode) return undefined;
  return {
    coarseRegion,
    countryName,
    countryCode,
    geoSource: "reverse-geocode",
  };
}

/** One-shot reverse geocode → coarse region + country metadata; undefined on any error. */
export async function geocodeFor(
  lat: number,
  lon: number,
  options: GeocoderOptions = {},
): Promise<GeocodeResult | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? NOMINATIM_REVERSE;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "8");
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": "Longplay/1.0 (single-user journey soundtrack)",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as {
      address?: Record<string, unknown>;
    };
    return geocodeFromAddress(payload.address);
  } catch {
    return undefined;
  }
}

/**
 * One-shot FORWARD geocode of a destination text (e.g. "Montpellier") → coarse region + country.
 * Used as the deterministic geo baseline when no live GPS is available. Undefined on any error.
 */
export async function forwardGeocodeFor(
  query: string,
  options: GeocoderOptions = {},
): Promise<GeocodeResult | undefined> {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? NOMINATIM_SEARCH;
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("q", trimmed);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "1");
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": "Longplay/1.0 (single-user journey soundtrack)",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as Array<{
      address?: Record<string, unknown>;
    }>;
    if (!Array.isArray(payload) || payload.length === 0) return undefined;
    return geocodeFromAddress(payload[0]?.address);
  } catch {
    return undefined;
  }
}

/** Builds a cached forward geocoder: identical destination strings reuse the first result. */
export function makeForwardGeocodeResolver(
  options: GeocoderOptions = {},
): (query: string) => Promise<GeocodeResult | undefined> {
  const cache = new Map<string, GeocodeResult | undefined>();
  return async (query: string) => {
    const key = query.trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const result = await forwardGeocodeFor(query, options);
    cache.set(key, result);
    return result;
  };
}

/** One-shot reverse geocode → coarse region (e.g. "Bavaria, Germany"); undefined on any error. */
export async function coarseRegionFor(
  lat: number,
  lon: number,
  options: GeocoderOptions = {},
): Promise<string | undefined> {
  return (await geocodeFor(lat, lon, options))?.coarseRegion;
}

/** Builds a cached geocoder: nearby coordinates (same ~0.1° bucket) reuse the first result. */
export function makeGeocodeResolver(
  options: GeocoderOptions = {},
): (lat: number, lon: number) => Promise<GeocodeResult | undefined> {
  const cache = new Map<string, GeocodeResult | undefined>();
  return async (lat: number, lon: number) => {
    const key = bucket(lat, lon);
    if (cache.has(key)) return cache.get(key);
    const result = await geocodeFor(lat, lon, options);
    cache.set(key, result);
    return result;
  };
}

export function makeGeocoder(
  options: GeocoderOptions = {},
): (lat: number, lon: number) => Promise<string | undefined> {
  const geocode = makeGeocodeResolver(options);
  return async (lat: number, lon: number) => {
    const result = await geocode(lat, lon);
    return result?.coarseRegion;
  };
}
