import { BookingApiClient } from "./bookingClient.js";
import { normalizeText } from "./textNormalize.js";

export interface CitySearchResult {
  city_id: number;
  name: string;
  country: string;
  name_variants: string[];
}

interface CachedCity {
  city_id: number;
  name: string;
  name_variants: string[];
}

const cityCache = new Map<string, CachedCity>();

const MAX_PAGES = 200;

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

// Sprawdza ile hoteli faktycznie zwraca dana lokalizacja (probne zapytanie,
// interesuje nas total_count, nie same dane). Uzywane do rozstrzygania
// miedzy DOWOLNA liczba zduplikowanych wpisow tego samego miasta w bazie
// Booking.com - moga byc 2, 3 lub wiecej takich wpisow, funkcja dziala
// niezaleznie od ich liczby.
async function countHotelsForCity(client: BookingApiClient, cityId: number): Promise<number> {
  try {
    const base = new Date();
    base.setDate(base.getDate() + 90);
    const co = new Date(base);
    co.setDate(co.getDate() + 2);
    const resp = await client.post<any>("/accommodations/search", {
      booker: { country: "nl", platform: "desktop" },
      checkin: base.toISOString().split("T")[0],
      checkout: co.toISOString().split("T")[0],
      city: cityId,
      guests: { number_of_adults: 1, number_of_rooms: 1 },
      currency: "PLN",
      rows: 10,
    });
    const data: any[] = resp.data ?? resp.result ?? resp.hotels ?? [];
    return resp.total_count ?? resp.metadata?.total_results ?? resp.count ?? data.length;
  } catch (err) {
    console.error("=== Blad przy liczeniu hoteli dla city_id=" + cityId + " (pomijam, liczba=0): " +
      (err instanceof Error ? err.message : String(err)));
    return 0;
  }
}

// Szuka City ID po nazwie miasta, pytajac API Booking.com (z kartkowaniem stron).
//
// KLUCZOWA ZASADA (ogolna, nie punktowa dla jednego miasta): Booking.com
// moze miec DOWOLNA liczbe zduplikowanych wpisow TEGO SAMEGO miasta w
// swojej bazie (potwierdzony przypadek: "Leszno" ma DWA rozne city_id o
// identycznej nazwie, jeden z zaledwie 1 hotelem w puli, drugi z pelna
// oferta zawierajaca realne, znane hotele jak "B&B HOTEL Leszno" - branie
// pierwszego z brzegu dawalo falszywy no_match). Ta funkcja ZAWSZE zbiera
// WSZYSTKIE dokladne dopasowania nazwy w calym kraju (bez wzgledu na to
// czy jest ich 1, 2, 5 czy wiecej), a gdy jest ich wiecej niz jedno,
// sprawdza KAZDE z nich przez probne zapytanie o realna liczbe hoteli i
// wybiera wariant z NAJWIEKSZA pula. To ogolne zabezpieczenie dziala dla
// kazdego miasta na swiecie, nie tylko dla przypadkow juz wykrytych.
export async function resolveCityId(
  client: BookingApiClient,
  cityName: string,
  country: string
): Promise<CitySearchResult | null> {
  const normCountry = country.toLowerCase().trim();
  const normName = normalizeText(cityName);
  const cacheKey = normCountry + ":" + normName;

  const cached = cityCache.get(cacheKey);
  if (cached) {
    return {
      city_id: cached.city_id,
      name: cached.name,
      country: normCountry,
      name_variants: cached.name_variants,
    };
  }

  let body: any = { country: normCountry };
  const exactMatches: CachedCity[] = [];

  // UWAGA: przechodzimy WSZYSTKIE strony kraju (nie przerywamy na
  // pierwszym trafieniu) - to jedyny niezawodny sposob, by wykryc
  // KAZDY mozliwy duplikat nazwy, niezaleznie od tego gdzie w kolejnosci
  // paginacji Booking.com go umiesci. Kosztowniejsze przy pierwszym
  // zapytaniu o dane miasto, zlagodzone przez cache dla kolejnych zapytan.
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.post<any>("/common/locations/cities", body);
    const data: any[] = resp.data ?? [];

    for (const entry of data) {
      const name = extractName(entry.name);
      if (!name || entry.id == null) continue;
      const variants = extractAllNameVariants(entry.name);

      const key = normCountry + ":" + normalizeText(name);
      if (!cityCache.has(key)) {
        cityCache.set(key, { city_id: entry.id, name: name, name_variants: variants });
      }

      if (normalizeText(name) === normName && !exactMatches.some((m) => m.city_id === entry.id)) {
        exactMatches.push({ city_id: entry.id, name: name, name_variants: variants });
      }
    }

    if (!resp.next_page) break;
    body = { page: resp.next_page };
  }

  if (exactMatches.length === 0) {
    console.error("=== Miasto NIE rozwiazane: \"" + cityName + "\" w kraju \"" + country + "\"");
    return null;
  }

  let chosen: CachedCity;

  if (exactMatches.length === 1) {
    chosen = exactMatches[0];
    console.error("=== Miasto rozwiazane: \"" + cityName + "\" -> " + chosen.name +
      " (id=" + chosen.city_id + "), jedno dopasowanie, bez duplikatow.");
  } else {
    // DUPLIKAT NAZWY MIASTA - dziala dla DOWOLNEJ liczby duplikatow (2, 3, ...).
    console.error("=== OSTRZEZENIE: znaleziono " + exactMatches.length +
      " zduplikowanych wpisow miasta \"" + cityName + "\" w kraju \"" + country +
      "\" w bazie Booking.com (city_id: " + exactMatches.map((m) => m.city_id).join(", ") +
      "). Sprawdzam realna liczbe hoteli w kazdym wariancie...");

    const counts = await Promise.all(
      exactMatches.map((m) => countHotelsForCity(client, m.city_id))
    );

    console.error("=== DIAG resolveCityId: liczba hoteli per city_id dla \"" + cityName + "\": " +
      exactMatches.map((m, i) => m.city_id + "=" + counts[i] + "szt.").join(", "));

    let bestIndex = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] > counts[bestIndex]) bestIndex = i;
    }
    chosen = exactMatches[bestIndex];

    console.error("=== Wybrano city_id=" + chosen.city_id + " dla \"" + cityName + "\" (" +
      counts[bestIndex] + " hoteli) sposrod " + exactMatches.length + " duplikatow w bazie.");
  }

  const finalKey = normCountry + ":" + normalizeText(chosen.name);
  cityCache.set(finalKey, chosen);

  return {
    city_id: chosen.city_id,
    name: chosen.name,
    country: normCountry,
    name_variants: chosen.name_variants,
  };
}

// Wyszukiwanie miast po fragmencie nazwy (dla narzedzia booking_search_cities)
export async function searchCities(
  client: BookingApiClient,
  query: string,
  country: string,
  limit: number
): Promise<Omit<CitySearchResult, "name_variants">[]> {
  const normCountry = country.toLowerCase().trim();
  const normQuery = normalizeText(query);
  const results: Omit<CitySearchResult, "name_variants">[] = [];
  const seen = new Set<number>();

  let body: any = { country: normCountry };

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.post<any>("/common/locations/cities", body);
    const data: any[] = resp.data ?? [];

    for (const entry of data) {
      const name = extractName(entry.name);
      if (!name || entry.id == null) continue;

      const key = normCountry + ":" + normalizeText(name);
      if (!cityCache.has(key)) {
        cityCache.set(key, { city_id: entry.id, name: name, name_variants: extractAllNameVariants(entry.name) });
      }

      if (normalizeText(name).indexOf(normQuery) !== -1 && !seen.has(entry.id)) {
        seen.add(entry.id);
        results.push({ city_id: entry.id, name: name, country: normCountry });
        if (results.length >= limit) return results;
      }
    }

    if (!resp.next_page) break;
    body = { page: resp.next_page };
  }

  return results;
}