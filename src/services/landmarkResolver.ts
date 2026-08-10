import { BookingApiClient } from "./bookingClient.js";

export interface LandmarkSearchResult {
  landmark_id: number;
  name: string;
  latitude: number;
  longitude: number;
}

const MAX_PAGES = 50;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function extractName(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    return field["en-gb"] ?? field["pl"] ?? field["en"] ?? (Object.values(field)[0] as string) ?? null;
  }
  return null;
}

// Szuka punktow orientacyjnych (zabytki, dworce, lotniska, atrakcje) w obrebie
// KONKRETNEGO miasta (Booking.com wymaga podania city_id - nie ma globalnego
// wyszukiwania punktow orientacyjnych po calym swiecie na raz).
// Dopasowanie: tokenowe substring, analogiczne do dopasowania nazw hoteli -
// pozwala znalezc "Fontanna Neptuna" nawet przy niepelnej/lekko innej nazwie.
export async function searchLandmarks(
  client: BookingApiClient,
  cityId: number,
  query: string,
  limit: number
): Promise<LandmarkSearchResult[]> {
  const queryTokens = normalizeName(query).split(/\s+/).filter(Boolean);
  const results: LandmarkSearchResult[] = [];
  const seen = new Set<number>();

  let body: any = { city: cityId };

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.post<any>("/common/locations/landmarks", body);
    const data: any[] = resp.data ?? [];

    for (const entry of data) {
      const name = extractName(entry.name);
      const lat = entry.coordinates?.latitude;
      const lon = entry.coordinates?.longitude;
      if (!name || entry.id == null || typeof lat !== "number" || typeof lon !== "number") continue;

      const nameTokens = normalizeName(name).split(/\s+/).filter(Boolean);
      const matches = queryTokens.every((qt) =>
        nameTokens.some((nt) => nt.indexOf(qt) !== -1 || qt.indexOf(nt) !== -1)
      );

      if (matches && !seen.has(entry.id)) {
        seen.add(entry.id);
        results.push({ landmark_id: entry.id, name, latitude: lat, longitude: lon });
        if (results.length >= limit) return results;
      }
    }

    if (!resp.next_page) break;
    body = { page: resp.next_page };
  }

  return results;
}