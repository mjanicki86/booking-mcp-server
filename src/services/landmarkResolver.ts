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

// Wyciaga WSZYSTKIE warianty jezykowe nazwy (np. "Neptune Fountain" i
// "Fontanna Neptuna" naraz) - Booking.com zwraca tylko jezyki, o ktore
// jawnie poprosimy w polu "languages" zapytania. Bez tego dostajemy tylko
// domyslny angielski wariant, przez co polska nazwa nigdy nie pasuje.
function extractAllNameVariants(field: any): string[] {
  if (!field) return [];
  if (typeof field === "string") return [field];
  if (typeof field === "object") {
    return Object.values(field).filter((v): v is string => typeof v === "string");
  }
  return [];
}

// Szuka punktow orientacyjnych (zabytki, dworce, lotniska, atrakcje) w obrebie
// KONKRETNEGO miasta (Booking.com wymaga podania city_id - nie ma globalnego
// wyszukiwania punktow orientacyjnych po calym swiecie na raz).
// Dopasowanie: tokenowe substring PO WSZYSTKICH wariantach jezykowych nazwy,
// zeby polska nazwa ("Fontanna Neptuna") trafila w angielski wpis w bazie
// ("Neptune Fountain"), a nie tylko dokladnie ten sam jezyk.
export async function searchLandmarks(
  client: BookingApiClient,
  cityId: number,
  query: string,
  limit: number
): Promise<LandmarkSearchResult[]> {
  const queryTokens = normalizeName(query).split(/\s+/).filter(Boolean);
  const results: LandmarkSearchResult[] = [];
  const seen = new Set<number>();

  // Zadamy kilku najbardziej prawdopodobnych jezykow naraz - polski (dla
  // polskich uzytkownikow), angielski (jezyk bazowy Booking.com) i
  // niemiecki (czesty trzeci jezyk w regionie). Mozna rozszerzyc w razie
  // potrzeby o kolejne.
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

      const nameTokens = allVariants.flatMap((v) => normalizeName(v).split(/\s+/).filter(Boolean));
      const matches = queryTokens.every((qt) =>
        nameTokens.some((nt) => nt.indexOf(qt) !== -1 || qt.indexOf(nt) !== -1)
      );

      if (matches && !seen.has(entry.id)) {
        seen.add(entry.id);
        results.push({ landmark_id: entry.id, name: displayName, latitude: lat, longitude: lon });
        if (results.length >= limit) return results;
      }
    }

    if (!resp.next_page) break;
    // UWAGA: przy paginacji "page" musi byc jedynym polem (tak jak przy
    // /accommodations/search) - token juz zawiera oryginalne parametry.
    body = { page: resp.next_page };
  }

  return results;
}