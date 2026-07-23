import {
  AccommodationSearchRequest,
  BookingApiError,
  FormattedHotel,
  Hotel,
  SearchResult,
} from "../types.js";
import { config } from "../config.js";

export class BookingApiClient {
  private readonly apiKey: string;
  private readonly affiliateId: string;

  constructor(apiKey: string, affiliateId: string) {
    this.apiKey = apiKey;
    this.affiliateId = affiliateId;
  }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    const url = config.bookingApiBaseUrl + endpoint;
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
    console.error("=== Booking.com response body: " + responseText.slice(0, 1000));

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
    const rawHotels: any[] = raw.data ?? raw.result ?? raw.hotels ?? [];

    // API 3.1 nie zwraca nazw ani wspolrzednych w wynikach wyszukiwania.
    // Dociagamy je jednym zbiorczym zapytaniem o szczegoly wszystkich znalezionych hoteli.
    const ids = rawHotels
      .map((h: any) => h.hotel_id ?? h.id)
      .filter((id: any) => id != null);

    const namesById: Record<number, string> = {};
    const coordsById: Record<number, { latitude: number; longitude: number }> = {};

    if (ids.length > 0) {
      try {
        const details = await this.post<any>("/accommodations/details", {
          accommodations: ids,
        });
        const detailsData: any[] = details.data ?? details.result ?? [];
        for (const d of detailsData) {
          const nm = extractLocalizedText(d.name);
          if (d.id != null && nm) {
            namesById[d.id] = nm;
          }
          const lat = d.location?.coordinates?.latitude;
          const lon = d.location?.coordinates?.longitude;
          if (d.id != null && typeof lat === "number" && typeof lon === "number") {
            coordsById[d.id] = { latitude: lat, longitude: lon };
          }
        }
      } catch (err) {
        // Nazwy/wspolrzedne to dodatek - jesli sie nie uda, lista i tak wraca
        console.error(
          "=== Nie udalo sie pobrac nazw/wspolrzednych hoteli: " +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }

    return {
      hotels: rawHotels.map((h: any) => normalizeHotel(h, namesById, coordsById)),
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

// Booking.com zwraca teksty jako obiekt wielojezyczny, np. {"en-gb": "Hotel X"}
function extractLocalizedText(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    return (
      field["en-gb"] ?? field["pl"] ?? field["en"] ??
      (Object.values(field)[0] as string) ?? null
    );
  }
  return null;
}

function normalizeHotel(
  raw: any,
  namesById: Record<number, string>,
  coordsById: Record<number, { latitude: number; longitude: number }>
): Hotel {
  const hotelId = raw.hotel_id ?? raw.id ?? 0;

  // Format 3.1: price.total / price.book to zwykle liczby, currency to tekst (np. "PLN")
  const v31Price =
    typeof raw.price?.total === "number" ? raw.price.total :
    typeof raw.price?.book === "number" ? raw.price.book : undefined;
  const v31Currency = typeof raw.currency === "string" ? raw.currency : undefined;

  // Format 3.2: ceny i waluty zagniezdzone w obiektach
  const v32Price = raw.price?.display?.booker_currency ?? raw.price?.total?.booker_currency;
  const v32Currency = raw.currency?.booker ?? raw.currency?.accommodation;

  // Starsze formaty
  const legacyPrice = raw.min_total_price ?? raw.price_breakdown?.all_inclusive_price;
  const legacyCurrency = raw.price_breakdown?.currency ?? raw.currency_code;

  const priceAmount = v31Price ?? v32Price ?? legacyPrice;
  const priceCurrency = v31Currency ?? v32Currency ?? legacyCurrency ?? "PLN";

  const name =
    namesById[hotelId] ??
    extractLocalizedText(raw.name) ??
    raw.hotel_name ??
    "Hotel " + hotelId;

  const coords = coordsById[hotelId];

  return {
    hotel_id: hotelId,
    name: name,
    star_rating: raw.class ?? raw.star_rating,
    review_score: raw.review_score,
    review_count: raw.review_nr ?? raw.review_count,
    review_score_word: raw.review_score_word,
    price: priceAmount != null ? {
      amount: priceAmount,
      currency: priceCurrency,
      amount_per_night: raw.price_breakdown?.sum_gross_price_per_night,
    } : undefined,
    currency: priceCurrency,
    location: {
      address: raw.address,
      city: raw.city,
      distance_to_center: raw.distance,
      latitude: coords?.latitude,
      longitude: coords?.longitude,
    },
    meal_plans: raw.meal_plan ? [raw.meal_plan] : undefined,
    url: raw.url ?? raw.deep_link_url,
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
    distance_km: null,
    breakfast_included: hotel.meal_plans?.some(function (mp) {
      return mp.code === "breakfast_included" || (mp.name != null && mp.name.toLowerCase().indexOf("breakfast") !== -1);
    }) ?? false,
    free_cancellation: hotel.free_cancellation ?? false,
    property_type: hotel.property_type ?? null,
    booking_url: hotel.url ?? null,
  };
}