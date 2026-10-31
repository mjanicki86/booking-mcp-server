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

// 2026-10-21: /accommodations/reviews/scores zaczal zwracac 403 Forbidden
// (brak uprawnien dla naszego klucza/affiliate - wczesniej dzialal). Kazde
// wyszukiwanie tracilo na nim czas, a hotelSearch blokowal filtr ocen.
// Po 401/403 wylaczamy ten endpoint na REVIEWS_DISABLE_MS i korzystamy
// z rating.review_score z /accommodations/details (fallback w
// searchAccommodations). Po tym czasie probujemy ponownie - jesli Booking
// przywroci dostep, wrocimy do niego automatycznie.
const REVIEWS_DISABLE_MS = 60 * 60 * 1000;
let reviewsDisabledUntil = 0;

// === KOMPLETNOSC WYNIKOW (2026-10-29, przeglad kodu pkt 2) ===
// /accommodations/search zwraca max `rows` (100) obiektow na strone i token
// next_page. Wczesniej pobieralismy tylko 1. strone - w centrum Krakowa przy
// 1-2 km przychodzilo 96-97 obiektow (prawie limit), a hostele/apartamenty
// odpadaja dopiero u nas, wiec czesc hoteli mogla w ogole nie trafic na liste.
// Teraz dociagamy kolejne strony do SEARCH_MAX_PAGES (500 obiektow).
// /details i oceny pytamy paczkami po ID_CHUNK - jedno zapytanie z kilkuset ID
// nie bylo dotad testowane.
const SEARCH_MAX_PAGES = 5;
const ID_CHUNK = 100;

// === CACHE WYNIKOW (2026-10-29, przeglad optymalizacji) ===
// 1) Surowe strony /accommodations/search po tresci zapytania - 5 min. Agent
//    potrafi w jednej turze (albo w dopytaniu o parking) wyslac identyczne
//    wyszukiwanie drugi raz; ceny i dostepnosc w 5 min sie nie zmieniaja.
// 2) /accommodations/details po ID - 6 h. To dane statyczne (nazwa, typ,
//    gwiazdki, udogodnienia, parking, wspolrzedne). Przy kaskadzie zapytan
//    ("teraz 4*", "bez sniadania", "w promieniu 2 km") te same obiekty
//    wracaja co ture - wczesniej kazda tura pytala o nie ponownie (1-4 zapytania).
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const DETAILS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DETAILS_CACHE_MAX = 5000;

interface SearchPages { first: any; hotels: any[]; pages: number; nextPage?: string; at: number }
const searchCache = new Map<string, SearchPages>();
const detailsCache = new Map<number, { at: number; d: any }>();

function trimMap<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// === LOGI (2026-10-29) ===
// LOG_LEVEL=debug -> pelne body zadan i 1000 znakow odpowiedzi (jak wczesniej).
// Domyslnie skrot: endpoint, poczatek zapytania (300 znakow), status, liczba
// rekordow i czas - zeby Log Analytics nie puchl od surowych odpowiedzi.
export const LOG_DEBUG = (process.env.LOG_LEVEL ?? "").trim().toLowerCase() === "debug";

// === ENDPOINT OCEN (2026-10-29) ===
// /accommodations/reviews/scores zwraca 403 od 2026-10-21 (brak uprawnien
// klucza). Domyslnie wylaczony - oceny z /accommodations/details. Po
// odblokowaniu przez Booking.com: zmienna REVIEWS_ENDPOINT=on.
const REVIEWS_ENDPOINT_ENABLED = (process.env.REVIEWS_ENDPOINT ?? "").trim().toLowerCase() === "on";

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

    const started = Date.now();
    if (!isCityLookup) {
      const bodyText = JSON.stringify(body);
      console.error("=== Calling Booking.com: " + url);
      console.error("=== Request body: " + (LOG_DEBUG || bodyText.length <= 300 ? bodyText : bodyText.slice(0, 300) + "...(" + bodyText.length + " znakow)"));
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
      // Linia ze statusem, liczba rekordow i czasem - zawsze (takze w trybie debug).
      let count = "?";
      try { const d = JSON.parse(responseText)?.data; count = Array.isArray(d) ? String(d.length) : "?"; } catch { /* pomijamy */ }
      console.error("=== Booking.com " + response.status + ", " + count + " rekordow, " + (Date.now() - started) + " ms");
      if (LOG_DEBUG || !response.ok) {
        console.error("=== Booking.com response body: " + responseText.slice(0, 1000));
      }
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

    if (!REVIEWS_ENDPOINT_ENABLED) {
      return { byId: byId, failed: true };
    }
    if (Date.now() < reviewsDisabledUntil) {
      console.error("=== DIAG reviews: endpoint ocen wylaczony po 403 (do " +
        new Date(reviewsDisabledUntil).toISOString() + ") - pomijam wywolanie.");
      return { byId: byId, failed: true };
    }

    console.error("=== DIAG reviews: " + (ids.length - missing.length) + " z cache, " +
      missing.length + " do pobrania z API.");

    try {
      const data: any[] = [];
      for (const part of chunk(missing, ID_CHUNK)) {
        const raw = await this.post<any>(REVIEWS_ENDPOINT, { accommodations: part });
        data.push(...(raw.data ?? raw.result ?? []));
      }
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
      const status = err instanceof BookingApiRequestError ? err.apiError.status : null;
      if (status === 401 || status === 403) {
        reviewsDisabledUntil = Date.now() + REVIEWS_DISABLE_MS;
        console.error("=== Endpoint ocen zwraca " + status + " - wylaczam go na " +
          (REVIEWS_DISABLE_MS / 60000) + " min, oceny z /accommodations/details.");
      }
      return { byId: byId, failed: true };
    }
  }

  async searchAccommodations(
    request: AccommodationSearchRequest
  ): Promise<SearchResult & { reviews_fetch_failed?: boolean }> {
    const searchKey = JSON.stringify(request);
    const cachedSearch = searchCache.get(searchKey);
    const fromCache = !!cachedSearch && Date.now() - cachedSearch.at < SEARCH_CACHE_TTL_MS;
    const pagesData = fromCache ? cachedSearch! : await this.fetchSearchPages(request);
    if (fromCache) {
      console.error("=== DIAG search cache: to samo zapytanie sprzed " +
        Math.round((Date.now() - cachedSearch!.at) / 1000) + " s - " + cachedSearch!.hotels.length +
        " obiektow bez zapytan do Booking.com.");
    } else {
      searchCache.delete(searchKey);
      searchCache.set(searchKey, pagesData);
      trimMap(searchCache, SEARCH_CACHE_MAX);
    }
    const raw = pagesData.first;
    const rawHotels: any[] = pagesData.hotels;
    const pages = pagesData.pages;
    const nextPage = pagesData.nextPage;
    const truncated = !!nextPage;
    if (truncated && !fromCache) {
      console.error("=== OSTRZEZENIE: po " + pages + " stronach (" + rawHotels.length + " obiektow) Booking.com ma " +
        "jeszcze kolejne - lista NIEKOMPLETNA.");
    }
    return this.enrichSearch(raw, rawHotels, pages, nextPage, truncated);
  }

  // Wszystkie strony /accommodations/search (do SEARCH_MAX_PAGES).
  private async fetchSearchPages(request: AccommodationSearchRequest): Promise<SearchPages> {
    const raw = await this.post<any>("/accommodations/search", request);
    const rawHotels: any[] = [];
    const seenIds = new Set<number>();
    const addPage = (resp: any) => {
      for (const h of (resp.data ?? resp.result ?? resp.hotels ?? []) as any[]) {
        const id = h?.hotel_id ?? h?.id;
        if (id == null || seenIds.has(id)) continue;
        seenIds.add(id);
        rawHotels.push(h);
      }
    };
    addPage(raw);

    // Token kolejnej strony - Booking.com zwraca go pod metadata.next_page
    // (v3.1/v3.2), ale sprawdzamy defensywnie też top-level next_page,
    // na wypadek innego kształtu odpowiedzi.
    const tokenOf = (resp: any): string | undefined => resp?.metadata?.next_page ?? resp?.next_page ?? undefined;
    let nextPage: string | undefined = tokenOf(raw);
    let pages = 1;
    console.error("=== DIAG search paging: strona 1 - " + rawHotels.length + " obiektow, next_page=" +
      (nextPage ? "jest" : "brak"));
    while (nextPage && pages < SEARCH_MAX_PAGES) {
      // Przy kolejnej stronie wolno wyslac WYLACZNIE {page} (patrz types.ts).
      const more = await this.post<any>("/accommodations/search", { page: nextPage });
      const before = rawHotels.length;
      addPage(more);
      pages++;
      nextPage = tokenOf(more);
      console.error("=== DIAG search paging: strona " + pages + " - +" + (rawHotels.length - before) +
        " obiektow (lacznie " + rawHotels.length + "), next_page=" + (nextPage ? "jest" : "brak"));
    }
    return { first: raw, hotels: rawHotels, pages, nextPage, at: Date.now() };
  }

  private async enrichSearch(
    raw: any, rawHotels: any[], pages: number, nextPage: string | undefined, truncated: boolean
  ): Promise<SearchResult & { reviews_fetch_failed?: boolean }> {
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
    // GWIAZDKI (2026-10-21): /accommodations/search NIE zwraca gwiazdek (tylko
    // id, price, products, url), wiec star_rating z raw.class bylo zawsze puste,
    // a filtr min_stars w hotelSearch.ts odrzucal WSZYSTKIE hotele - prod:
    // "zaden z 91 obiektow nie ma 4 gwiazdek" przy zapytaniu o 4* z filtrem
    // rating.stars=[4] wyslanym do API. Gwiazdki sa w rating.stars w
    // /accommodations/details, ktore i tak wolamy dla kazdego wyniku.
    // Przy okazji rating.review_score / number_of_reviews jako FALLBACK, gdy
    // /accommodations/reviews/scores nie zwroci oceny dla danego obiektu.
    const detailsRatingById: Record<number, { stars?: number; review_score?: number; review_count?: number }> = {};
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
    // Surowe /details (z facility_details) - hotelSearch liczy z nich parking,
    // zamiast drugi raz pytac /details o te same obiekty (przeglad pkt 7).
    const detailsById = new Map<number, any>();

    if (ids.length > 0) {
      // Z cache tylko brakujace ID; paczki po 100 rownolegle.
      const fetchDetails = async () => {
        const now = Date.now();
        const data: any[] = [];
        const missing: number[] = [];
        for (const id of ids) {
          const c = detailsCache.get(id);
          if (c && now - c.at < DETAILS_CACHE_TTL_MS) data.push(c.d);
          else missing.push(id);
        }
        const parts = await Promise.all(chunk(missing, ID_CHUNK).map((part) =>
          this.post<any>("/accommodations/details", { accommodations: part, extras: ["facilities"] })));
        for (const resp of parts) {
          for (const d of (resp.data ?? resp.result ?? []) as any[]) {
            data.push(d);
            if (d?.id != null) {
              detailsCache.delete(d.id);
              detailsCache.set(d.id, { at: now, d });
            }
          }
        }
        trimMap(detailsCache, DETAILS_CACHE_MAX);
        console.error("=== DIAG details cache: " + (ids.length - missing.length) + " z cache, " + missing.length +
          " z API (" + parts.length + " zapytan).");
        return { data };
      };

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
          if (d?.id != null) detailsById.set(d.id, d);
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
          if (d.id != null && d.rating && typeof d.rating === "object") {
            detailsRatingById[d.id] = {
              stars: typeof d.rating.stars === "number" ? d.rating.stars : undefined,
              review_score: typeof d.rating.review_score === "number" ? d.rating.review_score : undefined,
              review_count: typeof d.rating.number_of_reviews === "number" ? d.rating.number_of_reviews : undefined,
            };
          }
          const breakfastPrice = d.meal_prices?.breakfast;
          // < 1 (np. 0,10 PLN) to smieciowa wartosc w danych Booking.com (test 31.10, Bubble Hostel) - pomijamy.
          if (d.id != null && typeof breakfastPrice === "number" && breakfastPrice >= 1) {
            breakfastPriceById[d.id] = breakfastPrice;
          }
        }
      }

      const withStars = Object.values(detailsRatingById).filter((r) => r.stars != null).length;
      console.error("=== DIAG stars: gwiazdki z /details dla " + withStars + " z " + ids.length + " hoteli.");

      // FALLBACK OCEN (2026-10-21): gdy /accommodations/reviews/scores zawiedzie,
      // a /details przyszlo poprawnie, mamy oceny z rating.review_score - wtedy
      // NIE zglaszamy reviews_fetch_failed. Wczesniej sama awaria endpointu ocen
      // blokowala cale wyszukiwanie z min_review_score ("nie udalo sie pobrac
      // ocen gosci", Krakow 3* ocena 8+), mimo ze dane byly pod reka.
      if (reviewsFetchFailed && details) {
        const withScore = Object.values(detailsRatingById).filter((r) => r.review_score != null).length;
        console.error("=== DIAG reviews: " + (REVIEWS_ENDPOINT_ENABLED ? "endpoint ocen zawiodl" : "endpoint ocen wylaczony (REVIEWS_ENDPOINT)") +
          " - uzywam rating.review_score z /details (" +
          withScore + " z " + ids.length + " hoteli ma ocene).");
        reviewsFetchFailed = false;
      }
    }

    return {
      hotels: rawHotels.map((h: any) =>
        normalizeHotel(h, namesById, coordsById, facilitiesById, accTypeById, breakfastPriceById, reviewById, detailsRatingById)
      ),
      total_count: raw.total_count ?? raw.metadata?.total_results ?? raw.count ?? rawHotels.length,
      currency: raw.currency,
      next_page: nextPage,
      truncated: truncated,
      pages_fetched: pages,
      details_by_id: detailsById,
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
  reviewById: Record<number, { score?: number; count?: number }>,
  detailsRatingById: Record<number, { stars?: number; review_score?: number; review_count?: number }>
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
    // Gwiazdki: rating.stars z /details (search ich nie zwraca); raw.* jako fallback.
    star_rating: detailsRatingById[hotelId]?.stars ?? raw.class ?? raw.star_rating,
    // Ocena: zrodlem prawdy jest /accommodations/reviews/scores; potem
    // rating.review_score z /details; na koncu raw.* (inne ksztalty odpowiedzi).
    review_score: reviewById[hotelId]?.score ?? detailsRatingById[hotelId]?.review_score ?? raw.review_score,
    review_count: reviewById[hotelId]?.count ?? detailsRatingById[hotelId]?.review_count ?? raw.review_nr ?? raw.review_count,
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