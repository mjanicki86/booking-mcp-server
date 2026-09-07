import { BookingApiClient } from "./bookingClient.js";
import { normalizeText } from "./textNormalize.js";

export interface LandmarkSearchResult {
  landmark_id: number;
  name: string;
  latitude: number;
  longitude: number;
}

const MAX_PAGES = 50;

function tokenize(name: string): string[] {
  return normalizeText(name)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Dla krótkich tokenów (do 3 znaków włącznie) prosty substring jest
// niebezpieczny - moga wystapic jako PODCIAG zupelnie niepowiazanego,
// dluzszego slowa (np. "art" wewnatrz "apartment").
//
// Dodatkowo: fallback dla polskiej fleksji (odmiana przez przypadki) -
// "targi"/"targach", "hotel"/"hotelu" itp. czesto roznia sie tylko
// koncowka. Pelna lematyzacja wymagalaby slownika NLP - zamiast tego
// porownujemy "rdzen" (pierwsze min. 4 znaki). POTWIERDZONY BUG: ta sama
// funkcja w findHotel.ts miala juz ten fix, ale zabraklo go tutaj -
// "targach" (Poznan International Fair) dawalo 0 dopasowan mimo ze
// "Targi" jest w nazwie landmarku.
const STEM_MIN_LENGTH = 4;

function stemsMatch(a: string, b: string): boolean {
  if (a.length < STEM_MIN_LENGTH || b.length < STEM_MIN_LENGTH) return false;
  const stemLen = Math.min(STEM_MIN_LENGTH, a.length, b.length);
  return a.slice(0, stemLen) === b.slice(0, stemLen);
}

function tokensMatch(a: string, b: string): boolean {
  const minLen = Math.min(a.length, b.length);
  if (minLen <= 3) {
    return a === b;
  }
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) {
    return true;
  }
  return stemsMatch(a, b);
}

function extractName(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    return field["en-gb"] ?? field["pl"] ?? field["en"] ?? (Object.values(field)[0] as string) ?? null;
  }
  return null;
}

function extractAllNameVariants(field: any): string[] {
  if (!field) return [];
  if (typeof field === "string") return [field];
  if (typeof field === "object") {
    return Object.values(field).filter((v): v is string => typeof v === "string");
  }
  return [];
}

export async function searchLandmarks(
  client: BookingApiClient,
  cityId: number,
  query: string,
  limit: number
): Promise<LandmarkSearchResult[]> {
  const queryTokens = tokenize(query);
  const results: LandmarkSearchResult[] = [];
  const seen = new Set<number>();

  let body: any = { city: cityId, languages: ["en-gb", "pl", "de"] };

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.post<any>("/common/locations/landmarks", body);
    const data: any[] = resp.data ?? [];

    for (const entry of data) {
      const displayName = extractName(entry.name);
      const allVariants = extractAllNameVariants(entry.name);
      const lat = entry.coordinates?.latitude;
      const lon = entry.coordinates?.longitude;
      if (!displayName || entry.id == null || typeof lat !== "number" || typeof lon !== "number") continue;

      const nameTokens = allVariants.flatMap((v) => tokenize(v));
      if (queryTokens.length === 0 || nameTokens.length === 0) continue;

      const matches = queryTokens.every((qt) =>
        nameTokens.some((nt) => tokensMatch(nt, qt))
      );

      if (matches && !seen.has(entry.id)) {
        seen.add(entry.id);
        results.push({ landmark_id: entry.id, name: displayName, latitude: lat, longitude: lon });
        if (results.length >= limit) return results;
      }
    }

    if (!resp.next_page) break;
    body = { page: resp.next_page };
  }

  console.error("=== DIAG searchLandmarks: query=\"" + query + "\" -> " + results.length +
    " dopasowan: " + JSON.stringify(results.map((r) => r.name)));

  return results;
}

export async function geocodeAddress(query: string, cityName: string): Promise<LandmarkSearchResult | null> {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(query + ", " + cityName);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "booking-mcp-server/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return {
      landmark_id: -1,
      name: query,
      latitude: parseFloat(data[0].lat),
      longitude: parseFloat(data[0].lon),
    };
  } catch (err) {
    console.error("=== Geocoding fallback nieudany: " + (err instanceof Error ? err.message : String(err)));
    return null;
  }
}