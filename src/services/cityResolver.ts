import { BOOKING_API_BASE_URL } from "../constants.js";

export interface CitySearchResult {
  city_id: number;
  name: string;
  country: string;
  region?: string;
}

const cityCache = new Map<string, CitySearchResult | null>();

export async function resolveCityId(
  cityName: string,
  apiKey: string,
  affiliateId: string
): Promise<CitySearchResult | null> {
  const cacheKey = cityName.toLowerCase().trim();

  if (cityCache.has(cacheKey)) {
    return cityCache.get(cacheKey) ?? null;
  }

  const url = BOOKING_API_BASE_URL + "/locations/cities?name=" + encodeURIComponent(cityName) + "&limit=5";

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Affiliate-Id": affiliateId,
        "Authorization": "Bearer " + apiKey,
      },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new Error("Network error while looking up city \"" + cityName + "\": " + (err instanceof Error ? err.message : String(err)));
  }

  if (!response.ok) {
    if (response.status === 404) {
      cityCache.set(cacheKey, null);
      return null;
    }
    const errorText = await response.text().catch(() => "");
    throw new Error("City lookup failed (HTTP " + response.status + "): " + response.statusText + ". " + errorText);
  }

  const data: any = await response.json();
  const results: any[] = data.result ?? data.data ?? data.cities ?? data ?? [];

  if (!Array.isArray(results) || results.length === 0) {
    cityCache.set(cacheKey, null);
    return null;
  }

  const normalised = cityName.toLowerCase().trim();
  const best = results.find((r: any) => {
    const n = (r.name ?? r.city_name ?? "").toLowerCase();
    return n === normalised;
  }) ?? results[0];

  const resolved: CitySearchResult = {
    city_id: best.city_id ?? best.id ?? best.dest_id,
    name: best.name ?? best.city_name ?? cityName,
    country: best.country ?? best.country_code ?? "",
    region: best.region ?? best.state ?? undefined,
  };

  cityCache.set(cacheKey, resolved);
  return resolved;
}

export async function searchCities(
  query: string,
  apiKey: string,
  affiliateId: string,
  limit = 10
): Promise<CitySearchResult[]> {
  const url = BOOKING_API_BASE_URL + "/locations/cities?name=" + encodeURIComponent(query) + "&limit=" + limit;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Affiliate-Id": affiliateId,
      "Authorization": "Bearer " + apiKey,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error("City search failed (HTTP " + response.status + "): " + response.statusText + ". " + errorText);
  }

  const data: any = await response.json();
  const results: any[] = data.result ?? data.data ?? data.cities ?? data ?? [];

  if (!Array.isArray(results)) return [];

  return results.map((r: any) => ({
    city_id: r.city_id ?? r.id ?? r.dest_id,
    name: r.name ?? r.city_name ?? query,
    country: r.country ?? r.country_code ?? "",
    region: r.region ?? r.state ?? undefined,
  }));
}