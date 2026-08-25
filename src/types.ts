export interface BookerInfo {
  country: string;
  platform: string;
}
export interface GuestsInfo {
  number_of_adults: number;
  number_of_rooms: number;
  children?: number[];
}
export interface AccommodationSearchRequestFull {
  booker: BookerInfo;
  checkin: string;
  checkout: string;
  city: number;
  guests: GuestsInfo;
  currency?: string;
  rows?: number;
  offset?: number;
}

// WAŻNE: Booking.com API zwraca błąd 400 "conflicting_parameters", jeśli
// 'page' jest wysłane razem z jakimkolwiek innym polem. Token 'page'
// sam w sobie koduje oryginalne parametry zapytania, więc przy pobieraniu
// kolejnej strony trzeba wysłać WYŁĄCZNIE { page: "..." }, nic więcej.
export interface AccommodationSearchRequestPage {
  page: string;
}

export type AccommodationSearchRequest =
  | AccommodationSearchRequestFull
  | AccommodationSearchRequestPage;
export interface PriceInfo {
  amount: number;
  currency: string;
  amount_per_night?: number;
}
export interface Hotel {
  hotel_id: number;
  name: string;
  star_rating?: number;
  review_score?: number;
  review_count?: number;
  review_score_word?: string;
  price?: PriceInfo;
  currency?: string;
  location?: {
    city?: string;
    address?: string;
    distance_to_center?: number;
    latitude?: number;
    longitude?: number;
  };
  meal_plans?: { code?: string; name?: string }[];
  // Cena śniadania jako platny dodatek (gdy NIE jest wliczone w cene pokoju).
  // Booking.com zwraca to w polu meal_prices.breakfast z /accommodations/details,
  // niezaleznie od tego, czy ktorys "product" ma bezplatny meal_plan.
  breakfast_price_paid?: number;
  url?: string;
  property_type?: string;
  free_cancellation?: boolean;
  facilities?: number[];
  accommodation_type_id?: number;
}
export interface SearchResult {
  hotels: Hotel[];
  total_count: number;
  currency?: string;
  // Token do pobrania kolejnej strony wyników. Brak tego pola oznacza,
  // że to już ostatnia strona (patrz: docs Booking.com - Pagination guide).
  next_page?: string;
  // Czy pobranie facilities (drugie zapytanie do /accommodations/details
  // wewnatrz searchAccommodations) zawiodlo mimo retry. Gdy true,
  // facilities bedzie puste dla WSZYSTKICH hoteli w tym wyniku - to NIE
  // oznacza ze zaden hotel nie spelnia required_facilities, tylko ze nie
  // udalo sie tego sprawdzic. Wywolujacy (hotelSearch.ts) musi to
  // rozroznic od prawdziwego "brak wynikow", zeby nie pokazywac userowi
  // mylacego falszywego negatywu (przypadek Eweliny: zwierzeta+sniadanie
  // w Gdansku dawaly "brak wynikow" mimo dostepnych hoteli).
  facilities_fetch_failed: boolean;
}
export interface BookingApiError {
  status: number;
  message: string;
  details?: string;
}
export interface FormattedHotel {
  hotel_id: number;
  name: string;
  stars: number | null;
  review_score: number | null;
  review_count: number | null;
  review_word: string | null;
  price_total: number | null;
  price_per_night: number | null;
  currency: string;
  address: string | null;
  distance_to_center_km: number | null;
  distance_km: number | null;
  breakfast_included: boolean;
  breakfast_price_paid: number | null;
  free_cancellation: boolean;
  property_type: string | null;
  booking_url: string | null;
}
export interface HotelSearchOutput {
  [key: string]: unknown;
  success: boolean;
  city: string;
  city_id: number;
  checkin: string;
  checkout: string;
  nights: number;
  adults: number;
  total_found: number;
  hotels: FormattedHotel[];
  currency: string;
}
export interface CityEntry {
  city_id: number;
  name: string;
  country: string;
}
export interface CityListOutput {
  cities: CityEntry[];
  total: number;
}