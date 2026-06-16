import {
  AccommodationSearchRequest,
  BookingApiError,
  FormattedHotel,
  Hotel,
  SearchResult,
} from "../types.js";
import { BOOKING_API_BASE_URL } from "../constants.js";

export class BookingApiClient {
  private readonly apiKey: string;
  private readonly affiliateId: string;

  constructor(apiKey: string, affiliateId: string) {
    this.apiKey = apiKey;
    this.affiliateId = affiliateId;
  }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    const url = BOOKING_API_BASE_URL + endpoint;
    console.error("=== Calling Booking.com: " + url);
    console.error("=== Request body: " + JSON.stringify(body));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Affiliate-Id": this.affiliateId,
        "Authorization": "Bearer " + this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    const responseText = await response.text();
    console.error("=== Booking.com response status: " + response.status);
    console.error("=== Booking.com response body: " + responseText);

    if (!response.ok) {
      throw new BookingApiRequestError({
        status: response.status,
        message: "Booking.com API error " + response.status + ": " + response.statusText,
        details: responseText,
      });
    }

    return JSON.parse(responseText) as T;
  }

  async searchAccommodations(request: AccommodationSearchRequest): Promise<SearchResult> {
    const raw = await this.post<any>("/accommodations/search", request);
    const rawHotels = raw.result ?? raw.data ?? raw.hotels ?? [];
    return {
      hotels: rawHotels.map(normalizeHotel),
      total_count: raw.total_count ?? raw.count ?? rawHotels.length,
      currency: raw.currency,
    };
  }
}

export class BookingApiRequestError extends Error {
  public readonly apiError: BookingApiError;
  constructor(apiError: BookingApiError) {
    super(apiError.message);
    this.name = "BookingApiRequestError";
    this.apiError = apiError;
  }
}

function normalizeHotel(raw: any): Hotel {
  return {
    hotel_id: raw.hotel_id ?? raw.id ?? 0,
    name: raw.name ?? "Unknown",
    star_rating: raw.class,
    review_score: raw.review_score,
    review_count: raw.review_nr,
    review_score_word: raw.review_score_word,
    price: raw.min_total_price != null ? {
      amount: raw.price_breakdown?.all_inclusive_price ?? raw.min_total_price,
      currency: raw.price_breakdown?.currency ?? raw.currency_code ?? "EUR",
      amount_per_night: raw.price_breakdown?.sum_gross_price_per_night,
    } : undefined,
    currency: raw.currency_code,
    location: {
      address: raw.address,
      city: raw.city,
      distance_to_center: raw.distance,
    },
    meal_plans: raw.meal_plan ? [raw.meal_plan] : undefined,
    url: raw.url,
    property_type: raw.accommodation_type_name,
    free_cancellation: raw.is_free_cancellable ?? raw.has_free_cancellation ?? false,
  };
}

export function formatHotel(hotel: Hotel, currency: string): FormattedHotel {
  return {
    hotel_id: hotel.hotel_id,
    name: hotel.name,
    stars: hotel.star_rating ?? null,
    review_score: hotel.review_score ?? null,
    review_count: hotel.review_count ?? null,
    review_word: hotel.review_score_word ?? null,
    price_total: hotel.price?.amount ?? null,
    price_per_night: hotel.price?.amount_per_night ?? null,
    currency: hotel.price?.currency ?? hotel.currency ?? currency,
    address: hotel.location?.address ?? hotel.location?.city ?? null,
    distance_to_center_km: hotel.location?.distance_to_center != null
      ? Math.round(hotel.location.distance_to_center * 10) / 10 : null,
    breakfast_included: hotel.meal_plans?.some(mp =>
      mp.code === "breakfast_included" || (mp.name && mp.name.toLowerCase().indexOf("breakfast") !== -1)
    ) ?? false,
    free_cancellation: hotel.free_cancellation ?? false,
    property_type: hotel.property_type ?? null,
    booking_url: hotel.url ?? null,
  };
}