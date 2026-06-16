export const BOOKING_API_BASE_URL = "https://demandapi.booking.com/3.2";

export const CHARACTER_LIMIT = 50000;
export const DEFAULT_RESULTS_LIMIT = 20;
export const DEFAULT_CURRENCY = "PLN";
export const DEFAULT_BOOKER_COUNTRY = "pl";
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
};