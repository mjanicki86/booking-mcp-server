import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";

const HOSTEL_ACCOMMODATION_TYPE = 203;
const APARTMENT_ACCOMMODATION_TYPE = 201;
const VILLA_BB_ACCOMMODATION_TYPE = 208;
// Potwierdzony empirycznie 2026-09-11: kolejny kod dla apartamentow/serviced
// apartments ("Warsaw Apartments - Apartamenty Sadyba", "Mennica Residence -
// City Center Apartments") ktore mimo exclude_hostels=true przechodzily filtr.
const SERVICED_APARTMENT_ACCOMMODATION_TYPE = 219;

const EXCLUDED_ACCOMMODATION_TYPES = new Set([
  HOSTEL_ACCOMMODATION_TYPE,
  APARTMENT_ACCOMMODATION_TYPE,
  VILLA_BB_ACCOMMODATION_TYPE,
  SERVICED_APARTMENT_ACCOMMODATION_TYPE,
]);

const AMENITY_FACILITY_IDS: Record<string, number[]> = {
  pool: [103, 104],
  gym: [11],
  parking: [2],
  wifi: [107],
  air_conditioning: [109],
  spa: [54],
  restaurant: [3],
  sauna: [10],
  pets_allowed: [4],
};

// Okno "ok. 3 miesiace do przodu" potrafi wpasc dokladnie w swieta - dla
// zapytania z 2026-09-22 dawalo checkin 2026-12-25. Ceny z 25-27 grudnia sa
// skrajnie nietypowe, a byly podawane userowi jako orientacyjne. Omijamy wiec
// okres swiateczno-noworoczny, przesuwajac okno o tydzien.
function isInHolidayBlackout(d: Date): boolean {
  const month = d.getMonth();
  const day = d.getDate();
  if (month === 11 && day >= 20) return true;
  if (month === 0 && day <= 3) return true;
  return false;
}

function getDefaultDates(): { checkin: string; checkout: string } {
  const base = new Date();
  base.setDate(base.getDate() + 90);
  const day = base.getDay();
  const toFriday = (5 - day + 7) % 7;
  base.setDate(base.getDate() + toFriday);
  let checkout = new Date(base);
  checkout.setDate(checkout.getDate() + 2);

  let guard = 0;
  while ((isInHolidayBlackout(base) || isInHolidayBlackout(checkout)) && guard < 8) {
    base.setDate(base.getDate() + 7);
    checkout = new Date(base);
    checkout.setDate(checkout.getDate() + 2);
    guard++;
  }

  return {
    checkin: base.toISOString().split("T")[0],
    checkout: checkout.toISOString().split("T")[0],
  };
}

function roundUpToTen(n: number): number {
  return Math.min(100, Math.max(10, Math.ceil(n / 10) * 10));
}

function rowsToFetch(usingCoordinates: boolean, resultsLimit: number, hasStrongFilters: boolean): number {
  const base = (usingCoordinates || hasStrongFilters)
    ? Math.max(resultsLimit, 100)
    : resultsLimit;
  return roundUpToTen(base);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Zabezpieczenie: /accommodations/details zwraca dane posortowane rosnąco po
// ID Booking.com, IGNORUJĄC kolejność żądania - jeśli merge w bookingClient.ts
// (lub samo API przy dużym "rows") zgubi kolejność ustaloną przez "sort" w
// request body, wyniki zwrócone userowi będą pomieszane mimo sort_by=price
// (POTWIERDZONY BUG 2026-09-11: 1990->2680->2960->6960->3028->3071 PLN).
// To jawne, lokalne sortowanie gwarantuje poprawną kolejność niezależnie od
// tego, co się dzieje wyżej w stosie - defense in depth, nie zależy od
// naprawy w bookingClient.ts.
function compareForSort(a: any, b: any, sortBy?: string): number {
  if (sortBy === "price") {
    const pa = a.price != null ? a.price.amount : null;
    const pb = b.price != null ? b.price.amount : null;
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  }
  if (sortBy === "review_score") {
    const ra = a.review_score;
    const rb = b.review_score;
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  }
  if (sortBy === "stars") {
    const sa = a.star_rating;
    const sb = b.star_rating;
    if (sa == null && sb == null) return 0;
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sb - sa;
  }
  return 0;
}

export function registerHotelSearchTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_search_hotels",
    {
      title: "Search Hotels on Booking.com",
      description: "Search for available hotels in ANY city worldwide, or near ANY specific point (landmark, station, address) using Booking.com.\nLOCATION - use ONE of two modes: (1) city + country for generic 'hotels in [city]' requests (city name in ENGLISH); (2) latitude + longitude (+ radius_km) MANDATORY whenever the user names a specific place or distance - get REAL coordinates by calling booking_find_landmark first (do not invent them yourself), then pass them here. Never fall back to a plain city search and claim proximity. When copying latitude/longitude forward from a previous turn's active_search_state, copy the EXACT numeric values (all decimal digits) - do not round or approximate them from memory, since even small coordinate changes shift the search area and can silently change which hotels are returned.\nCITY SPELLING: if you are not 100% certain a city name is correct/exists (unusual spelling, could be a foreign city, could be a typo), do NOT silently substitute the closest city name you happen to know - call booking_search_cities FIRST to see real matches. If the name could plausibly belong to more than one country (e.g. treating 'Lublana' as a typo for 'Lublin' in Poland instead of recognizing it as 'Ljubljana' in Slovenia), ASK THE USER to confirm which one they mean rather than picking one yourself - guessing wrong sends completely the wrong results with no warning.\nDATES are OPTIONAL: if not given, call the tool WITHOUT checkin/checkout instead of asking - sample prices ~3 months ahead will be returned.\nCONTEXT ACROSS TURNS - CRITICAL: every response from this tool includes an 'active_search_state' object listing EVERY parameter used in that search. When the user's next message only changes ONE thing (radius, a filter, star rating, sort order, etc.), you MUST copy ALL other fields from the most recent 'active_search_state' unchanged into your next call - never silently reset location/coordinates, dates, stars, or exclude_hostels to defaults just because several turns have passed or because the user only mentioned one change. Losing a parameter silently produces completely wrong results (e.g. airport hotels instead of city-centre hotels because coordinates were dropped) without any warning to the user - this is a serious, high-priority failure mode to avoid.\nEXPLICITLY NAME CHANGED/REMOVED FILTERS: whenever the user asks you to remove or change ONE filter compared to the previous turn (e.g. 'without the dog now', 'bez psa teraz', 'no breakfast filter now', 'zmień na 3 gwiazdki'), your reply MUST explicitly state which filter changed and that the result set may now be different/larger because of it (e.g. 'Poniżej hotele BEZ filtra pet-friendly - lista jest dłuższa, bo obejmuje też obiekty, które niekoniecznie akceptują zwierzęta'). Do NOT just silently return a different/longer list and let the user infer the change from the hotel count or names alone - a consultant reading the reply must be able to tell at a glance which criterion no longer applies, otherwise they may wrongly assume every listed hotel still satisfies the original (now-removed) requirement. IF THE LIST IS IDENTICAL AFTER REMOVING A FILTER, SAY SO: compare the hotels you just received with the ones from the previous turn. If the set is the same, do not hedge with 'the list may now be longer or different' - state plainly that the results are unchanged and why, e.g. 'Lista jest identyczna - wszystkie te hotele i tak akceptowały zwierzęta, więc zdjęcie filtra nic nie zmieniło'. A vague 'may be different' next to an unchanged list tells the user nothing and hides the real finding.\nPRICE: max_price_per_night / min_price_per_night are enforced server-side - always call the tool again with the new value if the user changes their budget, never just re-describe previous results.\nAMENITIES: use required_facilities (e.g. ['pool','gym']) to filter hotels that must have specific amenities - this is enforced server-side and is far more reliable than checking booking_get_hotel_details on each result yourself.\nQUALITY: min_stars is a MINIMUM threshold by default (e.g. min_stars:3 returns 3-4-5 star hotels) - set exact_stars:true when the user names ONE specific star category rather than a floor (e.g. 'hotel 2-gwiazdkowy' vs 'co najmniej 3 gwiazdki'). min_review_score, exclude_hostels (true by default - excludes hostels, apartment-style listings, serviced apartments, AND villas/B&Bs, keeping only proper hotels; set false only if user explicitly says those are fine too).\nSORTING: sort_by is enforced entirely server-side within this tool using a guaranteed local re-sort (NOT delegated to Booking.com's own sort parameter, which was found to silently drop real hotels from results when combined with other filters) - the order you see in the response always matches the requested sort_by exactly and includes the full, correct set of matching hotels.\nBREAKFAST - CRITICAL RULE: breakfast_only means 'ONLY show hotels where breakfast is bundled FREE in the room price'. Set it to true ONLY when the user explicitly says breakfast must be included/free/bundled/'w cenie' (e.g. 'breakfast included', 'ze śniadaniem w cenie', 'free breakfast'). If the user just says 'with breakfast'/'ze śniadaniem' WITHOUT that qualifier, leave breakfast_only FALSE - a plain mention of breakfast means 'show me hotels regardless of whether breakfast is free or paid, and tell me which is which', NOT 'exclude hotels that charge for it'. Getting this wrong (setting breakfast_only=true for a plain 'ze śniadaniem' mention) is a common, serious mistake: it silently throws away real, bookable hotels that DO serve breakfast (just as a paid add-on) and can produce a false 'no hotels found' in an area that genuinely has hotels. Each result already includes 'breakfast_included' (free) AND 'breakfast_price_paid' (paid add-on price) - use these two fields to describe the breakfast situation instead of filtering it out.\nFILTERS ARE STRICT: breakfast_only and free_cancellation_only are HARD requirements - if no hotel matches, you get zero results (with a message to relax filters), NEVER a hotel that fails the requirement. Do not assume a returned hotel satisfies a filter you didn't set; only trust filters you actually passed.\nZERO RESULTS WITH MULTIPLE FILTERS: if you get zero results while using several filters together (location + price + breakfast_only + exclude_hostels etc.), the response includes a 'zero_results_breakdown' showing how many hotels survived EACH filtering step - use it to tell the user EXACTLY which filter caused the drop to zero (e.g. 'there are hotels nearby, but none have breakfast bundled free - several do offer it as a paid extra') instead of implying no hotels exist in the area at all.\nDISTANCE: in coordinates mode, you MUST mention each hotel's distance_km in your reply to the user - this is usually the whole reason they searched near that point, never omit it.\nRESULTS DISPLAY - SHOW EXACTLY WHAT WAS ASKED: when the user specifies a number of results (via results_limit or by saying e.g. 'show me 50 hotels', 'znajdź 100 hoteli', '13 obiektów'), your reply MUST list ALL of the hotels actually returned, up to that exact number - never silently truncate to a smaller 'sample' or 'example selection' and call it done. If the user asked for 100 and 97 were found, list all 97, not 10. If listing that many would make the reply extremely long, you may say so, but you must still provide the full list rather than quietly showing 10 and describing the rest as 'available on Booking.com'. The number the user gave is a literal instruction, not a suggestion.\nNOTE ON RESULT COUNT: Booking.com's API may internally return slightly fewer raw results than requested even when hotels are genuinely available (an API quirk, not a bug) - this tool compensates internally, but if fewer than results_limit hotels remain after filtering, that reflects genuine availability, not an error.\nOther args: adults, rooms, children_count/children_ages, currency, results_limit (up to 100), sort_by (price/review_score/distance/stars/popularity).\nNote: this tool does not return full amenity lists or addresses in detail - for full details on ONE specific hotel, call booking_get_hotel_details.\nFIELD NAMES ARE INTERNAL: never show raw field names from this response to the user - not distance_km, review_score, breakfast_price_paid, results_limit, exclude_hostels or any other. Write them in natural language ('1,3 km od dworca', 'ocena gości 8,7/10', 'śniadanie dodatkowo 95 PLN'). A reply containing '(distance_km)' or similar reads like a debug dump, not an answer for a travel consultant.\nGUEST RATINGS: review_score (1-10) and review_count come from Booking.com's own review database and are fetched for every search - when a hotel has a score, INCLUDE it in your reply, and never invent, estimate or round a rating that is not in the response. If review_score is null for a hotel, say its rating is unavailable rather than guessing one. min_review_score is a HARD filter enforced on these real scores, and sort_by=review_score orders by them (highest first).\nRESULTS_LIMIT - DO NOT INVENT IT: only pass results_limit when the user actually named a number ('pokaz 20 hoteli', '5 najlepszych'). If they did not, omit it and let the tool decide - do NOT add results_limit:10 on your own, because that silently hides real matching hotels from the user. If the response contains 'truncation_note', the tool returned fewer hotels than it found, and you MUST tell the user how many were found in total.\nBREAKFAST WORDING: breakfast_included and breakfast_price_paid can BOTH be set on the same hotel - that means breakfast IS free in the room rate and the price refers to an optional upgraded/extended breakfast. Never write a self-contradictory phrase like 'breakfast included, extra charge 100 PLN'. When breakfast_included is true, say breakfast is included (you may add that a paid upgrade exists); only when it is false does breakfast_price_paid describe the cost of adding breakfast.\nReturns hotels with prices and booking URLs.",
      inputSchema: HotelSearchInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: HotelSearchInput) => {

      const usingCoordinates = params.latitude != null && params.longitude != null;

      if (!usingCoordinates && (!params.city || !params.country)) {
        return {
          content: [{
            type: "text",
            text: "Error: provide either city + country, or latitude + longitude.",
          }],
          isError: true,
        };
      }

      let checkin = params.checkin;
      let checkout = params.checkout;
      let datesAssumed = false;

      if (!checkin || !checkout) {
        const defaults = getDefaultDates();
        checkin = checkin ?? defaults.checkin;
        checkout = checkout ?? defaults.checkout;
        datesAssumed = true;
      }

      const checkinDate = new Date(checkin);
      const checkoutDate = new Date(checkout);

      if (checkoutDate <= checkinDate) {
        return {
          content: [{ type: "text", text: "Error: checkout must be after checkin." }],
          isError: true,
        };
      }

      const nights = Math.round((checkoutDate.getTime() - checkinDate.getTime()) / 86400000);

      let locationPart: any;
      let locationLabel: string;
      let cityIdForOutput: number | null = null;

      if (usingCoordinates) {
        locationPart = {
          coordinates: {
            latitude: params.latitude,
            longitude: params.longitude,
            radius: params.radius_km,
          },
        };
        locationLabel = "point (" + params.latitude + ", " + params.longitude + "), radius " + params.radius_km + " km";
      } else {
        const cityResult = await resolveCityId(client, params.city!, params.country!);
        if (!cityResult) {
          return {
            content: [{
              type: "text",
              text: "City \"" + params.city + "\" not found in country \"" + params.country + "\" on Booking.com. Check the spelling and the country code, or use booking_search_cities to search.",
            }],
            isError: true,
          };
        }
        locationPart = { city: cityResult.city_id };
        locationLabel = cityResult.name;
        cityIdForOutput = cityResult.city_id;
      }

      // === WAZNE (2026-09-11) - "sort" NIE JEST wysylane do Booking.com API ===
      // Potwierdzono empirycznie: wysylanie "sort":{"by":"price",...} w request
      // body do /accommodations/search powoduje, ze Booking.com API zwraca
      // WEZSZA, INNA pule wynikow niz przy tym samym zapytaniu BEZ "sort" - nie
      // tylko w innej kolejnosci, ale z BRAKUJACYMI prawdziwymi hotelami (np.
      // "Mercure Warszawa Grand", "NYX Hotel Warsaw" znikaly calkowicie z
      // surowej odpowiedzi API, gdy dodano sort=price, mimo identycznej
      // lokalizacji/promienia/ratingu). W polaczeniu z exclude_hostels dawalo
      // to falszywe "0 hoteli" dla lokalizacji, gdzie realnie jest ich kilkanascie.
      // Dlatego NIGDY nie budujemy i nie wysylamy pola "sort" do API - zawsze
      // pobieramy dane w domyslnej kolejnosci (ktora, jak potwierdzono, zwraca
      // pelna, poprawna pule wynikow), a sortowanie wykonujemy WYLACZNIE
      // lokalnie (patrz "local re-sort safeguard" nizej).

      const maxTotalPrice = params.max_price_per_night != null
        ? Math.round(params.max_price_per_night * nights * 100) / 100
        : undefined;
      const minTotalPrice = params.min_price_per_night != null
        ? Math.round(params.min_price_per_night * nights * 100) / 100
        : undefined;
      let pricePart: any = undefined;
      if (maxTotalPrice != null || minTotalPrice != null) {
        pricePart = {};
        if (minTotalPrice != null) pricePart.minimum = minTotalPrice;
        if (maxTotalPrice != null) pricePart.maximum = maxTotalPrice;
      }

      let ratingPart: any = undefined;
      if (params.min_review_score != null || params.min_stars != null) {
        ratingPart = {};
        if (params.min_review_score != null) ratingPart.minimum_review_score = Math.ceil(params.min_review_score);
        if (params.min_stars != null) {
          if (params.exact_stars) {
            ratingPart.stars = [params.min_stars];
          } else {
            const starsArr: number[] = [];
            for (let s = params.min_stars; s <= 5; s++) starsArr.push(s);
            ratingPart.stars = starsArr;
          }
        }
      }

      const hasStrongFilters = !!(
        maxTotalPrice != null || minTotalPrice != null ||
        params.min_review_score != null ||
        (params.required_facilities && params.required_facilities.length > 0) ||
        params.exclude_hostels ||
        params.breakfast_only ||
        params.free_cancellation_only
      );

      try {
        const guestsPart: any = {
          number_of_adults: params.adults,
          number_of_rooms: params.rooms,
        };
        if (params.children_ages != null && params.children_ages.length > 0) {
          guestsPart.children = params.children_ages;
        }

        const request: any = {
          booker: { country: DEFAULT_BOOKER_COUNTRY, platform: DEFAULT_BOOKER_PLATFORM },
          checkin: checkin,
          checkout: checkout,
          guests: guestsPart,
          currency: params.currency,
          rows: rowsToFetch(usingCoordinates, params.results_limit, hasStrongFilters),
          extras: ["products"],
          ...locationPart,
        };
        // "sort" celowo NIE jest dodawane do request - patrz komentarz powyzej.
        if (pricePart) request.price = pricePart;
        if (ratingPart) request.rating = ratingPart;

        const result = await client.searchAccommodations(request);

        if (params.required_facilities?.length && result.facilities_fetch_failed) {
          return {
            content: [{
              type: "text",
              text: "Nie udało się pobrać danych o udogodnieniach z Booking.com API w tej chwili " +
                "(problem techniczny, nie brak takich hoteli), więc nie mogę wiarygodnie przefiltrować " +
                "po: " + params.required_facilities.join(", ") + ". Spróbuj ponownie za chwilę.",
            }],
            isError: true,
          };
        }

        // Analogicznie do facilities: jesli user poprosil o filtr po ocenie, a
        // ocen nie udalo sie pobrac, NIE wolno cicho przepuscic wszystkiego -
        // opis narzedzia obiecuje, ze filtry sa twarde, a model na tym polega.
        if (params.min_review_score != null && result.reviews_fetch_failed) {
          return {
            content: [{
              type: "text",
              text: "Nie udało się pobrać ocen gości z Booking.com API w tej chwili " +
                "(problem techniczny, nie brak takich hoteli), więc nie mogę wiarygodnie " +
                "przefiltrować po min_review_score >= " + params.min_review_score +
                ". Spróbuj ponownie za chwilę.",
            }],
            isError: true,
          };
        }

        console.error("=== CHECKPOINT: dane pobrane, " + result.hotels.length +
          " hoteli, rozpoczynam filtrowanie...");

        const stepBreakdown: { step: string; count: number }[] = [];

        let hotels = result.hotels;
        stepBreakdown.push({ step: "found_in_location", count: hotels.length });

        if (maxTotalPrice != null) {
          hotels = hotels.filter(function (h) { return h.price != null && h.price.amount <= maxTotalPrice; });
          stepBreakdown.push({ step: "after_max_price", count: hotels.length });
        }
        if (minTotalPrice != null) {
          hotels = hotels.filter(function (h) { return h.price != null && h.price.amount >= minTotalPrice; });
          stepBreakdown.push({ step: "after_min_price", count: hotels.length });
        }

        if (params.min_review_score != null) {
          // TWARDY filtr. Wczesniejszy warunek "if (filtered.length > 0 || ...)"
          // powodowal, ze przy braku ocen (a oceny nie byly w ogole pobierane do
          // 2026-09-22) filtr NIE robil nic i zwracal pelna liste, choc opis
          // narzedzia zapewnia model, ze filtry sa wymuszane po stronie serwera.
          // Teraz, gdy oceny sa realnie pobierane, filtr musi byc bezwarunkowy -
          // pusty wynik jest uczciwie wyjasniany przez zero_results_breakdown.
          const beforeReview = hotels.length;
          hotels = hotels.filter(function (h) {
            return h.review_score != null && h.review_score >= params.min_review_score!;
          });
          console.error("=== DIAG min_review_score>=" + params.min_review_score + ": " +
            beforeReview + " -> " + hotels.length + " hoteli.");
          stepBreakdown.push({ step: "after_min_review_score", count: hotels.length });
        }

        if (params.min_stars) {
          // TWARDY filtr. Wczesniejszy warunek "if (filtered.length > 0)" powodowal,
          // ze gdy filtr gwiazdek wyzerowalby liste, byl CICHO POMIJANY i user
          // dostawal hotele niespelniajace kryterium - a filters_applied_note
          // nadal zapewnialo "Filters enforced server-side (guaranteed accurate)".
          // Konsultant prosil o 5 gwiazdek, dostawal 3-gwiazdkowe i potwierdzenie,
          // ze filtr zadzialal. Po tej zmianie WSZYSTKIE filtry w tym pliku sa
          // faktycznie twarde, a pusty wynik wyjasnia zero_results_breakdown.
          const beforeStars = hotels.length;
          hotels = hotels.filter(function (h) {
            if (h.star_rating == null) return false;
            return params.exact_stars
              ? h.star_rating === params.min_stars
              : h.star_rating >= params.min_stars!;
          });
          console.error("=== DIAG min_stars" + (params.exact_stars ? "==" : ">=") +
            params.min_stars + ": " + beforeStars + " -> " + hotels.length + " hoteli.");
          stepBreakdown.push({ step: "after_stars", count: hotels.length });
        }

        if (params.exclude_hostels) {
          const beforeExclusion = hotels.length;
          hotels = hotels.filter(function (h) {
            return h.accommodation_type_id == null || !EXCLUDED_ACCOMMODATION_TYPES.has(h.accommodation_type_id);
          });
          console.error("=== DIAG exclude_hostels: " + beforeExclusion + " -> " + hotels.length +
            " hoteli. Wykluczone typy: hostel(" + HOSTEL_ACCOMMODATION_TYPE + "), apartament(" +
            APARTMENT_ACCOMMODATION_TYPE + "), willa/B&B(" + VILLA_BB_ACCOMMODATION_TYPE +
            "), serviced apartment(" + SERVICED_APARTMENT_ACCOMMODATION_TYPE + ").");
          stepBreakdown.push({ step: "after_exclude_hostels_apartments_villas", count: hotels.length });
        }

        if (params.required_facilities && params.required_facilities.length > 0) {
          const beforeCount = hotels.length;
          const rejectedSample: any[] = [];
          hotels = hotels.filter(function (h) {
            if (!h.facilities) {
              if (rejectedSample.length < 5) rejectedSample.push({ hotel_id: h.hotel_id, name: h.name, facilities: null });
              return false;
            }
            const ok = params.required_facilities!.every(function (amenity) {
              const ids = AMENITY_FACILITY_IDS[amenity];
              if (!ids) {
                console.error("=== OSTRZEZENIE booking_search_hotels: nieznana wartosc " +
                  "required_facilities=\"" + amenity + "\" - brak mapowania w AMENITY_FACILITY_IDS. " +
                  "Sprawdz zgodnosc ze schema (inputSchemas.ts). Dostepne klucze: " +
                  Object.keys(AMENITY_FACILITY_IDS).join(", "));
                return false;
              }
              return ids.some(function (id) { return h.facilities!.includes(id); });
            });
            if (!ok && rejectedSample.length < 5) {
              rejectedSample.push({ hotel_id: h.hotel_id, name: h.name, facilities: h.facilities });
            }
            return ok;
          });
          console.error("=== DIAG required_facilities=" + params.required_facilities.join(",") +
            " zredukowal wyniki z " + beforeCount + " do " + hotels.length +
            ". Sprawdzane ID: " + JSON.stringify(params.required_facilities.map(a => ({ [a]: AMENITY_FACILITY_IDS[a] }))) +
            ". Probka odrzuconych (realne facilities ID z API): " + JSON.stringify(rejectedSample));
          stepBreakdown.push({ step: "after_required_facilities", count: hotels.length });
        }

        if (params.breakfast_only) {
          const beforeBreakfast = hotels.length;
          const filtered = hotels.filter(function (h) {
            return h.meal_plans && h.meal_plans.some(function (mp) {
              return mp.code === "breakfast_included" ||
                (mp.name != null && mp.name.toLowerCase().indexOf("breakfast") !== -1);
            });
          });
          console.error("=== DIAG breakfast_only: " + beforeBreakfast + " -> " + filtered.length +
            " hoteli. Przyklad meal_plans z odrzuconych: " +
            JSON.stringify(hotels.filter(function (h) { return filtered.indexOf(h) === -1; })
              .slice(0, 5)
              .map(function (h) { return { hotel_id: h.hotel_id, name: h.name, meal_plans: h.meal_plans, breakfast_price_paid: h.breakfast_price_paid }; })));
          hotels = filtered;
          stepBreakdown.push({ step: "after_breakfast_only_free", count: hotels.length });
        }

        if (params.free_cancellation_only) {
          const beforeCancellation = hotels.length;
          const filtered = hotels.filter(function (h) { return h.free_cancellation === true; });
          console.error("=== DIAG free_cancellation_only: " + beforeCancellation + " -> " + filtered.length +
            " hoteli. Przyklad free_cancellation z odrzuconych: " +
            JSON.stringify(hotels.filter(function (h) { return filtered.indexOf(h) === -1; })
              .slice(0, 5)
              .map(function (h) { return { hotel_id: h.hotel_id, name: h.name, free_cancellation: h.free_cancellation }; })));
          hotels = filtered;
          stepBreakdown.push({ step: "after_free_cancellation_only", count: hotels.length });
        }

        const distanceById = new Map<number, number>();
        if (usingCoordinates) {
          for (const h of hotels) {
            const lat = h.location?.latitude;
            const lon = h.location?.longitude;
            if (typeof lat === "number" && typeof lon === "number") {
              distanceById.set(h.hotel_id, haversineKm(params.latitude!, params.longitude!, lat, lon));
            }
          }
        }

        // === ZABEZPIECZENIE SORTOWANIA (2026-09-11) ===
        // Skoro "sort" nigdy nie jest wysylane do Booking.com API (patrz
        // komentarz przy budowaniu request wyzej), TO sortowanie jest
        // WYLACZNIE lokalne i jedyne zrodlo prawdy o kolejnosci wynikow.
        const beforeSortOrder = hotels.map((h) => h.hotel_id);
        if (params.sort_by === "distance" && usingCoordinates) {
          hotels = hotels.slice().sort(function (a, b) {
            const da = distanceById.has(a.hotel_id) ? distanceById.get(a.hotel_id)! : Infinity;
            const db = distanceById.has(b.hotel_id) ? distanceById.get(b.hotel_id)! : Infinity;
            return da - db;
          });
        } else if (params.sort_by === "price" || params.sort_by === "review_score" || params.sort_by === "stars") {
          hotels = hotels.slice().sort(function (a, b) {
            return compareForSort(a, b, params.sort_by);
          });
        }
        if (params.sort_by) {
          console.error("=== DIAG local re-sort safeguard (sort_by=" + params.sort_by +
            "): kolejnosc PRZED=" + JSON.stringify(beforeSortOrder) +
            " PO=" + JSON.stringify(hotels.map((h) => h.hotel_id)));
        }

        // Jesli sortujemy po ocenie, a zaden hotel oceny nie ma, kolejnosc jest
        // przypadkowa. Zamiast udawac posortowana liste - powiedzmy to wprost.
        const hotelsWithScore = hotels.filter(function (h) { return h.review_score != null; }).length;
        const reviewSortUnreliable = params.sort_by === "review_score" && hotelsWithScore === 0;
        if (reviewSortUnreliable) {
          console.error("=== OSTRZEZENIE: sort_by=review_score, ale zaden z " + hotels.length +
            " hoteli nie ma oceny (reviews_fetch_failed=" + String(result.reviews_fetch_failed) +
            ") - kolejnosc NIE odzwierciedla ocen.");
        }

        const currency = result.currency ?? params.currency;
        console.error("=== CHECKPOINT: filtrowanie zakonczone, " + hotels.length +
          " hoteli pozostalo, formatuje odpowiedz...");
        const formatted = hotels.slice(0, params.results_limit).map(function (h) {
          const fh = formatHotel(h, currency);
          const d = distanceById.get(h.hotel_id);
          fh.distance_km = d != null ? Math.round(d * 10) / 10 : null;
          return fh;
        });

        // Budujemy active_search_state NIEZALEZNIE od tego, czy wynik jest
        // pusty czy nie - potrzebny w OBU przypadkach, zeby model mial
        // pelny stan do skopiowania przy nastepnym wywolaniu, nawet jesli
        // ta konkretna kombinacja filtrow dala zero wynikow.
        const activeSearchState: any = {
          location: locationLabel,
          search_mode: usingCoordinates ? "coordinates" : "city",
          checkin: checkin,
          checkout: checkout,
          adults: params.adults,
          rooms: params.rooms,
          min_stars: params.min_stars ?? null,
          exact_stars: params.exact_stars ?? false,
          exclude_hostels: params.exclude_hostels,
          breakfast_only: params.breakfast_only,
          free_cancellation_only: params.free_cancellation_only,
          required_facilities: params.required_facilities ?? [],
          max_price_per_night: params.max_price_per_night ?? null,
          min_price_per_night: params.min_price_per_night ?? null,
          currency: params.currency,
        };
        if (usingCoordinates) {
          activeSearchState.latitude = params.latitude;
          activeSearchState.longitude = params.longitude;
          activeSearchState.radius_km = params.radius_km;
        } else {
          activeSearchState.city = params.city;
          activeSearchState.country = params.country;
        }

        const activeSearchStateInstruction =
          "This object reflects EVERY parameter used in THIS search. If the user's next message only " +
          "changes ONE thing, copy ALL other fields from this object unchanged into your next tool " +
          "call - do not silently reset location/coordinates, dates, stars, or exclude_hostels to " +
          "defaults just because several turns have passed. Copy latitude/longitude EXACTLY (all " +
          "decimal digits shown here) - do not round or approximate them from memory. If the field " +
          "you just changed differs from this previous state (e.g. required_facilities went from " +
          "['pets_allowed'] to []), explicitly say so in your reply to the user - do not let them " +
          "infer the change only from a different hotel count or list.";

        if (formatted.length === 0) {
          const breakdownText = stepBreakdown
            .map((s) => s.step + ": " + s.count)
            .join(" -> ");

          let specificHint = "";
          const breakfastStep = stepBreakdown.find((s) => s.step === "after_breakfast_only_free");
          const priorToBreakfast = breakfastStep
            ? stepBreakdown[stepBreakdown.indexOf(breakfastStep) - 1]
            : null;
          if (breakfastStep && breakfastStep.count === 0 && priorToBreakfast && priorToBreakfast.count > 0) {
            specificHint = " IMPORTANT: there WERE " + priorToBreakfast.count + " real hotel(s) matching " +
              "location/price/type before the breakfast filter - they exist and are bookable, they just " +
              "charge for breakfast instead of including it free. Tell the user this explicitly (e.g. name " +
              "the hotels and their paid breakfast price) instead of saying no hotels exist nearby.";
          }

          return {
            content: [{
              type: "text",
              text: "No hotels found for " + locationLabel + " between " + checkin + " and " + checkout +
                " matching ALL filters together. Step-by-step breakdown of how many hotels survived each " +
                "filter (found_in_location -> ... -> final): " + breakdownText + "." + specificHint +
                " Tell the user specifically which filter caused the drop to zero, not just 'try relaxing " +
                "filters' generically.",
            }],
            structuredContent: {
              zero_results_breakdown: stepBreakdown,
              active_search_state: activeSearchState,
              active_search_state_instruction: activeSearchStateInstruction,
            },
          };
        }

        const output: any = {
          success: true,
          location: locationLabel,
          city_id: cityIdForOutput,
          search_mode: usingCoordinates ? "coordinates" : "city",
          checkin: checkin,
          checkout: checkout,
          nights: nights,
          adults: params.adults,
          total_found: result.total_count,
          returned_count: formatted.length,
          hotels: formatted,
          currency: currency,
        };

        const appliedFilters: string[] = [];
        if (maxTotalPrice != null) appliedFilters.push("max " + params.max_price_per_night + " " + params.currency + "/night");
        if (minTotalPrice != null) appliedFilters.push("min " + params.min_price_per_night + " " + params.currency + "/night");
        if (params.min_review_score != null) appliedFilters.push("review score >= " + params.min_review_score);
        if (params.min_stars) appliedFilters.push((params.exact_stars ? "exactly " : "") + params.min_stars + (params.exact_stars ? " stars" : "+ stars"));
        if (params.exclude_hostels) appliedFilters.push("hostels/apartments/serviced apartments/villas/B&Bs excluded");
        if (params.required_facilities && params.required_facilities.length > 0) appliedFilters.push("must have: " + params.required_facilities.join(", "));
        if (params.breakfast_only) appliedFilters.push("breakfast included FREE only (paid-breakfast hotels excluded)");
        if (params.free_cancellation_only) appliedFilters.push("free cancellation only");
        if (appliedFilters.length > 0) {
          output.filters_applied_note = "Filters enforced server-side (guaranteed accurate, not just re-described): " + appliedFilters.join("; ") + ".";
        }

        if (hotels.length > formatted.length) {
          output.truncation_note = "This search matched " + hotels.length + " hotels, but only " +
            formatted.length + " are returned because results_limit was " + params.results_limit +
            ". Tell the user that " + hotels.length + " hotels match in total and that you are " +
            "showing " + formatted.length + " of them - do not present this as the complete list.";
        }

        output.review_score_note = hotelsWithScore === 0
          ? "No hotel in this result set has a guest review score available" +
            (result.reviews_fetch_failed ? " (fetching review scores failed for this request)" : "") +
            ". Tell the user ratings are unavailable for these hotels - do NOT invent, estimate or " +
            "round any rating."
          : hotelsWithScore + " of " + formatted.length + " returned hotels have a real guest review " +
            "score. Quote review_score exactly as given and write 'ocena niedostępna' for hotels " +
            "where it is null - never fill in a plausible-looking number.";

        if (reviewSortUnreliable) {
          output.sort_warning = "sort_by=review_score was requested but no hotel in this set has a " +
            "review score, so the order does NOT reflect guest ratings. Say this explicitly instead " +
            "of presenting the list as sorted by rating.";
        }

        output.display_instruction = "List ALL " + formatted.length + " hotels below in your reply - " +
          "do not silently show only a subset and call it a 'sample', unless the user explicitly " +
          "asked for just a few/some examples rather than a specific count. The order returned here " +
          "is the FINAL, correct order for the requested sort_by - display hotels in this exact order, " +
          "do not re-sort them yourself.";

        if (!params.breakfast_only) {
          output.breakfast_reminder = "breakfast_only was NOT set - for EACH hotel below, check " +
            "breakfast_included and breakfast_price_paid and tell the user which hotels have free " +
            "breakfast vs which charge extra for it. Do not omit hotels just because their breakfast " +
            "is paid. If breakfast_included is true AND breakfast_price_paid is also set, breakfast " +
            "IS free in the room rate and that price is an optional upgrade - write 'śniadanie w " +
            "cenie' (optionally noting the paid upgrade), never the contradictory 'śniadanie w cenie, " +
            "dodatkowo płatne X PLN'.";
        }

        if (usingCoordinates) {
          output.radius_km = params.radius_km;
          output.location_note = "Results are limited to " + params.radius_km + " km around the given point" +
            (params.sort_by === "distance"
              ? ", sorted by real calculated distance (closest first)."
              : ". Each hotel includes distance_km even though results are not sorted by it.");
        } else {
          output.location_note = "This is a city-wide search. It does NOT filter by distance to any specific landmark unless coordinates were used.";
        }

        if (datesAssumed) {
          output.dates_note = "User did not provide dates. These are SAMPLE prices for an assumed weekend (" + checkin + " to " + checkout + "). Tell the user these dates were assumed.";
        }

        output.active_search_state = activeSearchState;
        output.active_search_state_instruction = activeSearchStateInstruction;

        const text = JSON.stringify(output, null, 2);
        return {
          content: [{
            type: "text",
            text: (text.length > CHARACTER_LIMIT ? text.slice(0, CHARACTER_LIMIT) + "\n...[truncated]" : text) + "\n\n---\nSource: Booking.com API"
          }],
          structuredContent: output,
        };

      } catch (err) {
        console.error("=== BLAD w booking_search_hotels: " +
          (err instanceof Error ? (err.stack ?? err.message) : String(err)));
        if (err instanceof BookingApiRequestError) {
          return {
            content: [{
              type: "text",
              text: "Booking.com API error (" + err.apiError.status + "): " + err.apiError.message + " | " + (err.apiError.details || ""),
            }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text",
            text: "Error: " + (err instanceof Error ? err.message : String(err)),
          }],
          isError: true,
        };
      }
    }
  );
}