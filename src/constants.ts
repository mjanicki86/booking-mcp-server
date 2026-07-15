export const BOOKING_API_BASE_URL = "https://demandapi-sandbox.booking.com/3.2";

export const CHARACTER_LIMIT = 50000;
export const DEFAULT_RESULTS_LIMIT = 20;
export const DEFAULT_CURRENCY = "PLN";
export const DEFAULT_BOOKER_COUNTRY = "nl";
export const DEFAULT_BOOKER_PLATFORM = "desktop";

export interface CityMapEntry {
  city_id: number;
  name: string;
  country: string;
}

export const CITY_ID_MAP: Record<string, CityMapEntry> = {
  amsterdam: { city_id: -2140479, name: "Amsterdam", country: "Netherlands" },
  warsaw: { city_id: -756135, name: "Warszawa", country: "Poland" },
  warszawa: { city_id: -756135, name: "Warszawa", country: "Poland" },
  krakow: { city_id: -755070, name: "Krakow", country: "Poland" },
  cracow: { city_id: -755070, name: "Krakow", country: "Poland" },
  gdansk: { city_id: -755754, name: "Gdansk", country: "Poland" },
  wroclaw: { city_id: -756714, name: "Wroclaw", country: "Poland" },
  poznan: { city_id: -756328, name: "Poznan", country: "Poland" },
  london: { city_id: -2601889, name: "London", country: "United Kingdom" },
  londyn: { city_id: -2601889, name: "London", country: "United Kingdom" },
  paris: { city_id: -1456928, name: "Paris", country: "France" },
  paryz: { city_id: -1456928, name: "Paris", country: "France" },
  berlin: { city_id: -1746443, name: "Berlin", country: "Germany" },
  rome: { city_id: -126693, name: "Rome", country: "Italy" },
  rzym: { city_id: -126693, name: "Rome", country: "Italy" },
  barcelona: { city_id: -372490, name: "Barcelona", country: "Spain" },
  madrid: { city_id: -390625, name: "Madrid", country: "Spain" },
  vienna: { city_id: -1995499, name: "Vienna", country: "Austria" },
  wien: { city_id: -1995499, name: "Vienna", country: "Austria" },
  prague: { city_id: -553173, name: "Prague", country: "Czech Republic" },
  praga: { city_id: -553173, name: "Prague", country: "Czech Republic" },
  budapest: { city_id: -835842, name: "Budapest", country: "Hungary" },
};