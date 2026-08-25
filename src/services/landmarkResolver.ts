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

// Dla krótkich tokenów (do 3 znaków włącznie, np. "of", "st", "spa") prosty
// substring jest niebezpieczny - takie tokeny potrafią wystąpić jako
// PODCIĄG zupełnie niepowiązanego, dłuższego słowa (np. "spa" wewnątrz
// "space", "art" wewnątrz "apartment" - ten drugi przypadek złapaliśmy
// realnie w findHotel.ts przy zapytaniu "Art Hotel Dubrovnik" fałszywie
// dopasowanym do "Dubrovnik Dream View Apartment"). Próg podniesiony z
// <=2 na <=3: dla tokenów do 3 znaków wymagamy DOKŁADNEJ równości;
// substring stosujemy tylko dla dłuższych, gdzie ryzyko przypadkowego
// trafienia wewnątrz innego słowa jest dużo mniejsze.
function tokensMatch(a: string, b: string): boolean {
  const minLen = Math.min(a.length, b.length);
  if (minLen <= 3) {
    return a === b;
  }
  return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
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
// Dopasowanie: tokenowe, bezpieczne dla krotkich slow, PO WSZYSTKICH
// wariantach jezykowych nazwy naraz.
export async function searchLandmarks(
  client: BookingApiClient,
  cityId: number,
  query: string,
  limit: number
): Promise<LandmarkSearchResult[]> {
  const queryTokens = tokenize(query);
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
    // UWAGA: przy paginacji "page" musi byc jedynym polem (tak jak przy
    // /accommodations/search) - token juz zawiera oryginalne parametry.
    body = { page: resp.next_page };
  }

  console.error("=== DIAG searchLandmarks: query=\"" + query + "\" -> " + results.length +
    " dopasowan: " + JSON.stringify(results.map((r) => r.name)));

  return results;
}

// Fallback dla adresow/placow, ktorych nie ma w kuratorowanej bazie
// landmarkow Booking.com (np. "plac Artura Zawiszy" w Warszawie).
// Uzywa darmowego geokodowania OpenStreetMap Nominatim.
// UWAGA: Nominatim ma limit ok. 1 zapytanie/sekunde i wymaga naglowka
// User-Agent - przy wiekszym ruchu produkcyjnym rozwazyc platne API
// (np. Google Geocoding).
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