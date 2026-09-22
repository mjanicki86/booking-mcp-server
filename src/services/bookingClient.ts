import {
  AccommodationSearchRequest,
  BookingApiError,
  FormattedHotel,
  Hotel,
  SearchResult,
} from "../types.js";
import { config } from "../config.js";

// === OCENY GOSCI (2026-09-22) ===
// Oceny gosci NIE przychodza ani z /accommodations/search, ani z
// /accommodations/details - sa pod osobnym endpointem /accommodations/reviews/scores.
// Dopoki ich nie pobieralismy, review_score kazdego hotelu bylo null, co dawalo
// trzy ciche bledy naraz: sort_by=review_score nie zmienial kolejnosci (PRZED==PO
// w DIAG), filtr min_review_score nie odrzucal niczego, a model - pozbawiony danych,
// ktore opis narzedzia mu obiecuje - ZMYSLAL oceny w odpowiedziach dla usera
// (potwierdzony przypadek z produkcji 2026-09-22: "9,2/10", "9,1/10" dla hoteli,
// dla ktorych nie bylo zadnych danych).
const REVIEWS_ENDPOINT = "/accommodations/reviews/scores";

// Oceny zmieniaja sie w skali dni, nie minut, wiec 24h TTL jest bezpieczne
// merytorycznie i praktycznie kasuje narzut na API: konsultant robi kaskade
// (ten sam zbior hoteli, zmieniany filtr albo sortowanie w kolejnych turach),
// wiec tury 2..N trafiaja w cache. Klucz to numeryczne accommodation_id, wiec
// nie powtarza sie tu problem zatrucia cache'u z cityResolver.ts - identyfikator
// jest jednoznaczny i nie wymaga deduplikacji wariantow nazw.
const REVIEW_SCORE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedReviewScore {
  score?: number;
  count?: number;
  fetchedAt: number;
}

const reviewScoreCache = new Map<number, CachedReviewScore>();

export class BookingApiClient {
  private readonly apiKey: string;
  private readonly affiliateId: string;

  constructor(apiKey: string, affiliateId: string) {
    this.apiKey = apiKey;
    this.affiliateId = affiliateId;
  }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    const url = config.bookingApiBaseUrl + endpoint;
    // Resolwowanie miasta (/common/locations/cities) potrafi wygenerowac
    // dziesiatki stron zanim znajdzie dopasowanie - to zalewa strumien logow
    // i przez to gubia sie istotne linie DIAG/CHECKPOINT wypisywane pozniej
    // w tym samym zadaniu. Dla tego endpointu logujemy tylko skrotowo.
    const isCityLookup = endpoint.indexOf("/common/locations/cities") !== -1;

    if (!isCityLookup) {
      console.error("=== Calling Booking.com: " + url);
      console.error("=== Request body: " + JSON.stringify(body));
    }

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

    if (!isCityLookup) {
      console.error("=== Booking.com response status: " + response.status);
      console.error("=== Booking.com response body: " + responseText.slice(0, 1000));
    }

    if (!response.ok) {
      throw new BookingApiRequestError({
        status: response.status,
        message: "Booking.com API error " + response.status + ": " + response.statusText,
        details: responseText,
      });
    }

    return JSON.parse(responseText) as T;
  }

  // Zwraca slownik id -> {score, count}. Pyta API tylko o te ID, ktorych nie ma
  // w cache lub ktorych wpis sie przedawnil. Rzuca wyjatkiem tylko wtedy, gdy
  // realnie probowala odpytac API i sie nie udalo - wywolujacy decyduje, czy to
  // blad krytyczny (patrz reviews_fetch_failed).
  private async fetchReviewScores(
    ids: number[]
  ): Promise<{ byId: Record<number, CachedReviewScore>; failed: boolean }> {
    const byId: Record<number, CachedReviewScore> = {};
    const now = Date.now();
    const missing: number[] = [];

    for (const id of ids) {
      const cached = reviewScoreCache.get(id);
      if (cached && now - cached.fetchedAt < REVIEW_SCORE_CACHE_TTL_MS) {
        byId[id] = cached;
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0) {
      console.error("=== DIAG reviews: wszystkie " + ids.length +
        " ocen z cache, zero wywolan API.");
      return { byId: byId, failed: false };
    }

    console.error("=== DIAG reviews: " + (ids.length - missing.length) + " z cache, " +
      missing.length + " do pobrania z API.");

    try {
      const raw = await this.post<any>(REVIEWS_ENDPOINT, { accommodations: missing });
      const data: any[] = raw.data ?? raw.result ?? [];
      let withScore = 0;
      for (const r of data) {
        if (r?.id == null) continue;
        const entry: CachedReviewScore = {
          score: typeof r.score === "number" ? r.score : undefined,
          count: typeof r.number_of_reviews === "number" ? r.number_of_reviews : undefined,
          fetchedAt: now,
        };
        reviewScoreCache.set(r.id, entry);
        byId[r.id] = entry;
        if (entry.score != null) withScore++;
      }
      console.error("=== DIAG reviews: API zwrocilo " + data.length + " wpisow, " +
        withScore + " z ocena. W cache lacznie: " + reviewScoreCache.size + " obiektow.");
      return { byId: byId, failed: false };
    } catch (err) {
      console.error("=== Nie udalo sie pobrac ocen gosci (" + REVIEWS_ENDPOINT + "): " +
        (err instanceof Error ? err.message : String(err)));
      return { byId: byId, failed: true };
    }
  }

  async searchAccommodations(
    request: AccommodationSearchRequest
  ): Promise<SearchResult & { reviews_fetch_failed?: boolean }> {
    const raw = await this.post<any>("/accommodations/search", request);
    const rawHotels: any[] = raw.data ?? raw.result ?? raw.hotels ?? [];

    // Token kolejnej strony - Booking.com zwraca go pod metadata.next_page
    // (v3.1/v3.2), ale sprawdzamy defensywnie też top-level next_page,
    // na wypadek innego kształtu odpowiedzi.
    const nextPage: string | undefined =
      raw.metadata?.next_page ?? raw.next_page ?? undefined;

    const ids = rawHotels
      .map((h: any) => h.hotel_id ?? h.id)
      .filter((id: any) => id != null);

    const namesById: Record<number, string> = {};
    const coordsById: Record<number, { latitude: number; longitude: number }> = {};
    const facilitiesById: Record<number, number[]> = {};
    const accTypeById: Record<number, number> = {};
    // Cena sniadania jako platnego dodatku (gdy nie jest wliczone w cene
    // pokoju) - Booking.com zwraca to w meal_prices.breakfast, dostepne
    // przy okazji tego samego wywolania /accommodations/details co facilities.
    const breakfastPriceById: Record<number, number> = {};
    // Oceny gosci - z osobnego endpointu, nie z /details.
    let reviewById: Record<number, CachedReviewScore> = {};
    let reviewsFetchFailed = false;

    // WAZNE: jesli to zapytanie o facilities zawiedzie (timeout, rate limit,
    // chwilowy blad sieci), facilitiesById zostaje puste dla WSZYSTKICH
    // hoteli. Wczesniej blad byl cicho polykany, a filtr required_facilities
    // w hotelSearch.ts odrzucal wtedy KAZDY hotel (bo "if (!h.facilities)
    // return false"), co wygladalo jak falszywy "brak wynikow" mimo ze
    // hotele spelniajace kryterium realnie istnialy. Teraz probujemy
    // ponownie raz, a jesli nadal sie nie uda - jawnie sygnalizujemy to
    // wywolujacemu przez facilitiesFetchFailed, zamiast pozwalac na
    // mylace zero wynikow.
    let facilitiesFetchFailed = false;

    if (ids.length > 0) {
      const fetchDetails = () =>
        this.post<any>("/accommodations/details", { accommodations: ids, extras: ["facilities"] });

      let details: any = null;
      try {
        details = await fetchDetails();
      } catch (err1) {
        console.error(
          "=== Pierwsza proba pobrania facilities nieudana, ponawiam raz: " +
            (err1 instanceof Error ? err1.message : String(err1))
        );
        try {
          details = await fetchDetails();
        } catch (err2) {
          facilitiesFetchFailed = true;
          console.error(
            "=== Druga proba rowniez nieudana - facilities NIEDOSTEPNE dla tego zapytania: " +
              (err2 instanceof Error ? err2.message : String(err2))
          );
        }
      }

      // Oceny pobieramy rownolegle z details - to dwa niezalezne endpointy,
      // wiec nie ma powodu czekac na jeden przed drugim.
      const reviews = await this.fetchReviewScores(ids);
      reviewById = reviews.byId;
      reviewsFetchFailed = reviews.failed;

      if (details) {
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
          if (d.id != null && Array.isArray(d.facilities)) {
            facilitiesById[d.id] = d.facilities
              .map((f: any) => f.id)
              .filter((fid: any) => typeof fid === "number");
          }
          if (d.id != null && typeof d.accommodation_type === "number") {
            accTypeById[d.id] = d.accommodation_type;
          }
          const breakfastPrice = d.meal_prices?.breakfast;
          if (d.id != null && typeof breakfastPrice === "number") {
            breakfastPriceById[d.id] = breakfastPrice;
          }
        }
      }
    }

    return {
      hotels: rawHotels.map((h: any) =>
        normalizeHotel(h, namesById, coordsById, facilitiesById, accTypeById, breakfastPriceById, reviewById)
      ),
      total_count: raw.total_count ?? raw.metadata?.total_results ?? raw.count ?? rawHotels.length,
      currency: raw.currency,
      next_page: nextPage,
      facilities_fetch_failed: facilitiesFetchFailed,
      reviews_fetch_failed: reviewsFetchFailed,
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

// Booking.com zwraca informacje o planie posiłków i zasadach anulacji NIE
// na samym obiekcie hotelu, tylko wewnątrz tablicy "products" (każdy produkt
// to konkretna oferta/pokój), w polu "policies". Hotel może mieć kilka
// produktów - część z śniadaniem, część bez; sprawdzamy więc, czy
// JAKIKOLWIEK produkt spełnia kryterium, nie tylko pierwszy/domyślny.
function extractMealPlans(products: any): { code?: string; name?: string }[] | undefined {
  if (!Array.isArray(products) || products.length === 0) return undefined;
  const plans = products
    .map((p: any) => p?.policies?.meal_plan?.plan)
    .filter((plan: any) => typeof plan === "string" && plan !== "no_plan");
  if (plans.length === 0) return undefined;
  const unique = Array.from(new Set(plans)) as string[];
  return unique.map((plan) => ({ code: plan, name: plan }));
}

// Sprawdza, czy KTORYKOLWIEK produkt hotelu ma REALNIE uzyteczna darmowa
// anulacje - czyli type:"free_cancellation" ORAZ termin graniczny
// (free_cancellation_until) ktory jeszcze nie minal.
//
// POTWIERDZONY W LOGACH BUG (2026-08-26, Gdansk): Booking.com API zwraca
// type:"free_cancellation" nawet gdy free_cancellation_until wypada tego
// samego dnia co checkin (np. "2026-09-02T15:59:59Z" przy checkinie
// 2026-09-02) - praktycznie bezuzyteczne dla goscia, ktory nie zdazy nic
// odwolac. Wczesniejsza wersja sprawdzala tylko pole "type", ignorujac
// czy termin graniczny ma jeszcze jakikolwiek sens w momencie wywolania
// zapytania. To provadzilo do pokazywania hoteli jako "z darmowa
// anulacja", mimo ze faktycznie ta anulacja nie daje juz zadnej realnej
// elastycznosci.
function extractFreeCancellation(products: any): boolean {
  if (!Array.isArray(products)) return false;
  const now = new Date();
  return products.some((p: any) => {
    if (p?.policies?.cancellation?.type !== "free_cancellation") return false;
    const until = p?.policies?.cancellation?.free_cancellation_until;
    // Brak konkretnej daty granicznej - ufamy samemu polu "type"
    // (moze byc bezterminowa darmowa anulacja, zdarza sie w danych API).
    if (!until) return true;
    return new Date(until).getTime() > now.getTime();
  });
}

function normalizeHotel(
  raw: any,
  namesById: Record<number, string>,
  coordsById: Record<number, { latitude: number; longitude: number }>,
  facilitiesById: Record<number, number[]>,
  accTypeById: Record<number, number>,
  breakfastPriceById: Record<number, number>,
  reviewById: Record<number, { score?: number; count?: number }>
): Hotel {
  const hotelId = raw.hotel_id ?? raw.id ?? 0;

  const v31Price =
    typeof raw.price?.total === "number" ? raw.price.total :
    typeof raw.price?.book === "number" ? raw.price.book : undefined;
  const v31Currency = typeof raw.currency === "string" ? raw.currency : undefined;

  const v32Price = raw.price?.display?.booker_currency ?? raw.price?.total?.booker_currency;
  const v32Currency = raw.currency?.booker ?? raw.currency?.accommodation;

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
    // Zrodlem prawdy jest /accommodations/reviews/scores; raw.* zostaje jako
    // fallback, bo starsze/inne ksztalty odpowiedzi czasem to pole zawieraja.
    review_score: reviewById[hotelId]?.score ?? raw.review_score,
    review_count: reviewById[hotelId]?.count ?? raw.review_nr ?? raw.review_count,
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
    meal_plans: extractMealPlans(raw.products),
    breakfast_price_paid: breakfastPriceById[hotelId],
    url: raw.url ?? raw.deep_link_url,
    property_type: raw.accommodation_type_name,
    free_cancellation: extractFreeCancellation(raw.products),
    facilities: facilitiesById[hotelId],
    accommodation_type_id: accTypeById[hotelId],
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
    breakfast_price_paid: hotel.breakfast_price_paid ?? null,
    free_cancellation: hotel.free_cancellation ?? false,
    property_type: hotel.property_type ?? null,
    booking_url: hotel.url ?? null,
  };
}