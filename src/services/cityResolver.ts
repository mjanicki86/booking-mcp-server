import { CITY_ID_MAP } from "../constants.js";

export interface CitySearchResult {
  city_id: number;
  name: string;
  country: string;
}

function normalizeCityName(cityName: string): string {
  return cityName
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function resolveCityId(cityName: string): CitySearchResult | null {
  const normalized = normalizeCityName(cityName);
  const entry = CITY_ID_MAP[normalized];
  if (!entry) {
    return null;
  }
  return {
    city_id: entry.city_id,
    name: entry.name,
    country: entry.country,
  };
}

export function searchCities(query: string, limit: number): CitySearchResult[] {
  const normalized = normalizeCityName(query);
  const results: CitySearchResult[] = [];
  const seen = new Set<number>();

  for (const key in CITY_ID_MAP) {
    if (key.indexOf(normalized) !== -1 || normalized.indexOf(key) !== -1) {
      const entry = CITY_ID_MAP[key];
      if (!seen.has(entry.city_id)) {
        seen.add(entry.city_id);
        results.push({ city_id: entry.city_id, name: entry.name, country: entry.country });
        if (results.length >= limit) {
          break;
        }
      }
    }
  }

  return results;
}