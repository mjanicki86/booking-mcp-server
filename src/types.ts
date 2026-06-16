export interface BookerInfo {
  country: string;
  platform: string;
}

export interface GuestsInfo {
  number_of_adults: number;
  number_of_rooms: number;
  number_of_children?: number;
  children_ages?: number[];
}

export interface AccommodationSearchRequest {
  booker: BookerInfo;
  checkin: string;
  checkout: string;
  city: number;
  guests: GuestsInfo;
  currency?: string;
  rows?: number;
  offset?: number;
}

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
  };
  meal_plans?: { code?: string; name?: string }[];
  url?: string;
  property_type?: string;
  free_cancellation?: boolean;
}

export interface SearchResult {
  hotels: Hotel[];
  total_count: number;
  currency?: string;
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
  breakfast_included: boolean;
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