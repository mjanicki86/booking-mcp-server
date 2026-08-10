import { BookingApiClient } from "./bookingClient.js";

export interface CitySearchResult {
  city_id: number;
  name: string;
  country: string;
  // Wszystkie warianty językowe nazwy miasta znalezione w odpowiedzi API
  // (np. "Warsaw" i "Warszawa" naraz) - przydatne np. do wykluczania nazwy
  // miasta jako kryterium dopasowania nazwy hotelu, niezależnie od tego,
  // w jakim języku user ją wpisał.
  name_variants: string[];
}

interface CachedCity {
  city_id: number;
  name: string;
  name_variants: string[];
}

// Pamiec podreczna: klucz "kraj:znormalizowana-nazwa" -> miasto.
// Czysci sie przy restarcie serwera - to OK, ID miast sie nie zmieniaja.
const cityCache = new Map<string, CachedCity>();

// Bezpiecznik: maksymalna liczba stron do przekartkowania dla jednego kraju
const MAX_PAGES = 200;

function normalizeCityName(cityName: string): string {
  return cityName
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

// Wyciaga WSZYSTKIE warianty jezykowe nazwy (np. en-gb i pl naraz), nie
// tylko jeden preferowany - potrzebne do wykluczania nazwy miasta jako
// kryterium dopasowania niezaleznie od jezyka, w ktorym user ja wpisal.
function extractAllNameVariants(field: any): string[] {
  if (!field) return [];
  if (typeof field === "string") return [field];
  if (typeof field === "object") {
    return Object.values(field).filter((v): v is string => typeof v === "string");
  }
  return [];
}

// Szuka City ID po nazwie miasta, pytajac API Booking.com (z kartkowaniem stron).
// Wszystkie miasta napotkane po drodze laduja w cache, wiec kolejne pytania
// o miasta z tego samego kraju sa coraz szybsze.
export async function resolveCityId(
  client: BookingApiClient,
  cityName: string,
  country: string
): Promise<CitySearchResult | null> {
  const normCountry = country.toLowerCase().trim();
  const normName = normalizeCityName(cityName);
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

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.post<any>("/common/locations/cities", body);
    const data: any[] = resp.data ?? [];

    let found: CachedCity | null = null;

    for (const entry of data) {
      const name = extractName(entry.name);
      if (!name || entry.id == null) continue;
      const variants = extractAllNameVariants(entry.name);

      const key = normCountry + ":" + normalizeCityName(name);
      if (!cityCache.has(key)) {
        cityCache.set(key, { city_id: entry.id, name: name, name_variants: variants });
      }

      if (!found && normalizeCityName(name) === normName) {
        found = { city_id: entry.id, name: name, name_variants: variants };
      }
    }

    if (found) {
      console.error("=== Miasto rozwiazane: \"" + cityName + "\" -> " + found.name +
        " (id=" + found.city_id + ") po " + (page + 1) + " stronach");
      return {
        city_id: found.city_id,
        name: found.name,
        country: normCountry,
        name_variants: found.name_variants,
      };
    }

    if (!resp.next_page) break;
    body = { page: resp.next_page };
  }

  console.error("=== Miasto NIE rozwiazane: \"" + cityName + "\" w kraju \"" + country + "\"");
  return null;
}

// Wyszukiwanie miast po fragmencie nazwy (dla narzedzia booking_search_cities)
export async function searchCities(
  client: BookingApiClient,
  query: string,
  country: string,
  limit: number
): Promise<Omit<CitySearchResult, "name_variants">[]> {
  const normCountry = country.toLowerCase().trim();
  const normQuery = normalizeCityName(query);
  const results: Omit<CitySearchResult, "name_variants">[] = [];
  const seen = new Set<number>();

  let body: any = { country: normCountry };

  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await client.post<any>("/common/locations/cities", body);
    const data: any[] = resp.data ?? [];

    for (const entry of data) {
      const name = extractName(entry.name);
      if (!name || entry.id == null) continue;

      const key = normCountry + ":" + normalizeCityName(name);
      if (!cityCache.has(key)) {
        cityCache.set(key, { city_id: entry.id, name: name, name_variants: extractAllNameVariants(entry.name) });
      }

      if (normalizeCityName(name).indexOf(normQuery) !== -1 && !seen.has(entry.id)) {
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