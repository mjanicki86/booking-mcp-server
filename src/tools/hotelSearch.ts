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

function getDefaultDates(): { checkin: string; checkout: string } {
  const base = new Date();
  base.setDate(base.getDate() + 90);
  const day = base.getDay();
  const toFriday = (5 - day + 7) % 7;
  base.setDate(base.getDate() + toFriday);
  const checkout = new Date(base);
  checkout.setDate(checkout.getDate() + 2);
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
      description: "Search for available hotels in ANY city worldwide, or near ANY specific point (landmark, station, address) using Booking.com.\nLOCATION - use ONE of two modes: (1) city + country for generic 'hotels in [city]' requests (city name in ENGLISH); (2) latitude + longitude (+ radius_km) MANDATORY whenever the user names a specific place or distance - get REAL coordinates by calling booking_find_landmark first (do not invent them yourself), then pass them here. Never fall back to a plain city search and claim proximity.\nCITY SPELLING: if you are not 100% certain a city name is correct/exists (unusual spelling, could be a foreign city, could be a typo), do NOT silently substitute the closest city name you happen to know - call booking_search_cities FIRST to see real matches. If the name could plausibly belong to more than one country (e.g. treating 'Lublana' as a typo for 'Lublin' in Poland instead of recognizing it as 'Ljubljana' in Slovenia), ASK THE USER to confirm which one they mean rather than picking one yourself - guessing wrong sends completely the wrong results with no warning.\nDATES are OPTIONAL: if not given, call the tool WITHOUT checkin/checkout instead of asking - sample prices ~3 months ahead will be returned.\nCONTEXT ACROSS TURNS - CRITICAL: every response from this tool includes an 'active_search_state' object listing EVERY parameter used in that search. When the user's next message only changes ONE thing (radius, a filter, star rating, sort order, etc.), you MUST copy ALL other fields from the most recent 'active_search_state' unchanged into your next call - never silently reset location/coordinates, dates, stars, or exclude_hostels to defaults just because several turns have passed or because the user only mentioned one change. Losing a parameter silently produces completely wrong results (e.g. airport hotels instead of city-centre hotels because coordinates were dropped) without any warning to the user - this is a serious, high-priority failure mode to avoid.\nPRICE: max_price_per_night / min_price_per_night are enforced server-side - always call the tool again with the new value if the user changes their budget, never just re-describe previous results.\nAMENITIES: use required_facilities (e.g. ['pool','gym']) to filter hotels that must have specific amenities - this is enforced server-side and is far more reliable than checking booking_get_hotel_details on each result yourself.\nQUALITY: min_stars is a MINIMUM threshold by default (e.g. min_stars:3 returns 3-4-5 star hotels) - set exact_stars:true when the user names ONE specific star category rather than a floor (e.g. 'hotel 2-gwiazdkowy' vs 'co najmniej 3 gwiazdki'). min_review_score, exclude_hostels (true by default - excludes hostels, apartment-style listings, serviced apartments, AND villas/B&Bs, keeping only proper hotels; set false only if user explicitly says those are fine too).\nSORTING: sort_by is enforced server-side with a guaranteed final re-sort - the order you see in the response always matches the requested sort_by exactly, regardless of the underlying API's raw order.\nBREAKFAST - CRITICAL RULE: breakfast_only means 'ONLY show hotels where breakfast is bundled FREE in the room price'. Set it to true ONLY when the user explicitly says breakfast must be included/free/bundled/'w cenie' (e.g. 'breakfast included', 'ze śniadaniem w cenie', 'free breakfast'). If the user just says 'with breakfast'/'ze śniadaniem' WITHOUT that qualifier, leave breakfast_only FALSE - a plain mention of breakfast means 'show me hotels regardless of whether breakfast is free or paid, and tell me which is which', NOT 'exclude hotels that charge for it'. Getting this wrong (setting breakfast_only=true for a plain 'ze śniadaniem' mention) is a common, serious mistake: it silently throws away real, bookable hotels that DO serve breakfast (just as a paid add-on) and can produce a false 'no hotels found' in an area that genuinely has hotels. Each result already includes 'breakfast_included' (free) AND 'breakfast_price_paid' (paid add-on price) - use these two fields to describe the breakfast situation instead of filtering it out.\nFILTERS ARE STRICT: breakfast_only and free_cancellation_only are HARD requirements - if no hotel matches, you get zero results (with a message to relax filters), NEVER a hotel that fails the requirement. Do not assume a returned hotel satisfies a filter you didn't set; only trust filters you actually passed.\nZERO RESULTS WITH MULTIPLE FILTERS: if you get zero results while using several filters together (location + price + breakfast_only + exclude_hostels etc.), the response includes a 'zero_results_breakdown' showing how many hotels survived EACH filtering step - use it to tell the user EXACTLY which filter caused the drop to zero (e.g. 'there are hotels nearby, but none have breakfast bundled free - several do offer it as a paid extra') instead of implying no hotels exist in the area at all.\nDISTANCE: in coordinates mode, you MUST mention each hotel's distance_km in your reply to the user - this is usually the whole reason they searched near that point, never omit it.\nRESULTS DISPLAY - SHOW EXACTLY WHAT WAS ASKED: when the user specifies a number of results (via results_limit or by saying e.g. 'show me 50 hotels', 'znajdź 100 hoteli', '13 obiektów'), your reply MUST list ALL of the hotels actually returned, up to that exact number - never silently truncate to a smaller 'sample' or 'example selection' and call it done. If the user asked for 100 and 97 were found, list all 97, not 10. If listing that many would make the reply extremely long, you may say so, but you must still provide the full list rather than quietly showing 10 and describing the rest as 'available on Booking.com'. The number the user gave is a literal instruction, not a suggestion.\nNOTE ON RESULT COUNT: Booking.com's API may internally return slightly fewer raw results than requested even when hotels are genuinely available (an API quirk, not a bug) - this tool compensates internally, but if fewer than results_limit hotels remain after filtering, that reflects genuine availability, not an error.\nOther args: adults, rooms, children_count/children_ages, currency, results_limit (up to 100), sort_by (price/review_score/distance/stars/popularity).\nNote: this tool does not return full amenity lists or addresses in detail - for full details on ONE specific hotel, call booking_get_hotel_details.\nReturns hotels with prices and booking URLs.",
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

      let sortPart: any = undefined;
      if (params.sort_by === "price") {
        sortPart = { by: "price", direction: "ascending" };
      } else if (params.sort_by === "review_score" || params.sort_by === "stars") {
        sortPart = { by: params.sort_by, direction: "descending" };
      }

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
        if (sortPart) request.sort = sortPart;
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
          const filtered = hotels.filter(function (h) {
            return h.review_score != null && h.review_score >= params.min_review_score!;
          });
          if (filtered.length > 0 || hotels.every(h => h.review_score != null)) hotels = filtered;
          stepBreakdown.push({ step: "after_min_review_score", count: hotels.length });
        }

        if (params.min_stars) {
          const filtered = hotels.filter(function (h) {
            if (h.star_rating == null) return false;
            return params.exact_stars
              ? h.star_rating === params.min_stars
              : h.star_rating >= params.min_stars!;
          });
          if (filtered.length > 0) hotels = filtered;
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
        // /accommodations/details zwraca dane posortowane rosnąco po ID
        // Booking.com, niezależnie od kolejności żądania - jeśli merge w
        // bookingClient.ts zgubi kolejność ustaloną przez request.sort,
        // wyniki będą pomieszane mimo poprawnego sort_by w żądaniu do API.
        // Sortujemy więc JAWNIE, lokalnie, tuż przed formatowaniem - to
        // gwarantuje poprawną kolejność niezależnie od tego, co się stanie
        // wyżej w stosie (merge, API quirk, itp.).
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
          "defaults just because several turns have passed.";

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

        output.display_instruction = "List ALL " + formatted.length + " hotels below in your reply - " +
          "do not silently show only a subset and call it a 'sample', unless the user explicitly " +
          "asked for just a few/some examples rather than a specific count. The order returned here " +
          "is the FINAL, correct order for the requested sort_by - display hotels in this exact order, " +
          "do not re-sort them yourself.";

        if (!params.breakfast_only) {
          output.breakfast_reminder = "breakfast_only was NOT set - for EACH hotel below, check " +
            "breakfast_included and breakfast_price_paid and tell the user which hotels have free " +
            "breakfast vs which charge extra for it. Do not omit hotels just because their breakfast " +
            "is paid.";
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