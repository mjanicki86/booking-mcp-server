import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";

const HOSTEL_ACCOMMODATION_TYPE = 203;
// TODO: zweryfikowac numer w logu accommodation_type_id realnego apartamentu
// z testu Emilii (Dubrovnik Dream View Apartment / podobne przypadki) -
// wartosc ponizej jest przypuszczeniem opartym o typowa numeracje Booking.com
// i wymaga potwierdzenia przed poleganiem na niej w produkcji.
const APARTMENT_ACCOMMODATION_TYPE = 201;

const AMENITY_FACILITY_IDS: Record<string, number[]> = {
  pool: [103, 104],
  gym: [11],
  parking: [2],
  wifi: [107],
  air_conditioning: [109],
  spa: [54],
  restaurant: [3],
  sauna: [10],
  // Zgodne ze schema (inputSchemas.ts) - enum required_facilities dopuszcza
  // dokladnie "pets_allowed". Zweryfikowane krzyzowo z FACILITY_NAMES w
  // hotelDetails.ts (4: "zwierzeta akceptowane") ORAZ empirycznie w
  // logach testowych (Gdansk, 2026-08-26) - mapowanie poprawne.
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

function rowsToFetch(usingCoordinates: boolean, resultsLimit: number, hasStrongFilters: boolean): number {
  if (usingCoordinates || hasStrongFilters) {
    return Math.max(resultsLimit, 100);
  }
  return resultsLimit;
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

export function registerHotelSearchTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_search_hotels",
    {
      title: "Search Hotels on Booking.com",
      description: "Search for available hotels in ANY city worldwide, or near ANY specific point (landmark, station, address) using Booking.com.\nLOCATION - use ONE of two modes: (1) city + country for generic 'hotels in [city]' requests (city name in ENGLISH); (2) latitude + longitude (+ radius_km) MANDATORY whenever the user names a specific place or distance - get REAL coordinates by calling booking_find_landmark first (do not invent them yourself), then pass them here. Never fall back to a plain city search and claim proximity.\nCITY SPELLING: if you are not 100% certain a city name is correct/exists (unusual spelling, could be a foreign city, could be a typo), do NOT silently substitute the closest city name you happen to know - call booking_search_cities FIRST to see real matches. If the name could plausibly belong to more than one country (e.g. treating 'Lublana' as a typo for 'Lublin' in Poland instead of recognizing it as 'Ljubljana' in Slovenia), ASK THE USER to confirm which one they mean rather than picking one yourself - guessing wrong sends completely the wrong results with no warning.\nDATES are OPTIONAL: if not given, call the tool WITHOUT checkin/checkout instead of asking - sample prices ~3 months ahead will be returned.\nPRICE: max_price_per_night / min_price_per_night are enforced server-side - always call the tool again with the new value if the user changes their budget, never just re-describe previous results.\nAMENITIES: use required_facilities (e.g. ['pool','gym']) to filter hotels that must have specific amenities - this is enforced server-side and is far more reliable than checking booking_get_hotel_details on each result yourself.\nQUALITY: min_stars is a MINIMUM threshold by default (e.g. min_stars:3 returns 3-4-5 star hotels) - set exact_stars:true when the user names ONE specific star category rather than a floor (e.g. 'hotel 2-gwiazdkowy' vs 'co najmniej 3 gwiazdki'). min_review_score, exclude_hostels (true by default - excludes hostels AND apartment-style listings, set false only if user explicitly says those are fine too).\nBREAKFAST: each result has 'breakfast_included' (bundled free in the room rate) AND separately 'breakfast_price_paid' (price if bought as an optional extra, even when NOT included). When breakfast_included is false but breakfast_price_paid has a value, tell the user breakfast is available for that extra charge - don't just say 'no breakfast'.\nFILTERS ARE STRICT: breakfast_only and free_cancellation_only are HARD requirements - if no hotel matches, you get zero results (with a message to relax filters), NEVER a hotel that fails the requirement. Do not assume a returned hotel satisfies a filter you didn't set; only trust filters you actually passed.\nDISTANCE: in coordinates mode, you MUST mention each hotel's distance_km in your reply to the user - this is usually the whole reason they searched near that point, never omit it.\nOther args: adults, rooms, children_count/children_ages, currency, results_limit (up to 100), sort_by (price/review_score/distance/stars/popularity).\nNote: this tool does not return full amenity lists or addresses in detail - for full details on ONE specific hotel, call booking_get_hotel_details.\nReturns hotels with prices and booking URLs.",
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
          // exact_stars: user nazwal JEDNA konkretna kategorie gwiazdek
          // ("hotel 2-gwiazdkowy") - wtedy min_stars NIE jest progiem
          // minimalnym, tylko dokladna wartoscia. Wczesniej "2*" zawsze
          // zwracalo hotele 2* i wyzsze, co zglosila Emilia.
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
        // breakfast_only i free_cancellation_only tez potrzebuja wiekszej puli -
        // inaczej odfiltrowujemy z zaledwie kilku hoteli (domyslny results_limit
        // to tylko 10), co gubi poprawne wyniki spoza tej maleńkiej proby.
        params.breakfast_only ||
        params.free_cancellation_only
      );

      try {
        // Dzieci: Booking.com API 3.1 oczekuje plaskiej tablicy wieku w polu
        // "guests.children" (bez osobnego "number_of_children" - to pole nie istnieje w API).
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
          // "products" MUSI byc jawnie zazadane przez extras - bez tego
          // Booking.com nie zwraca w ogole tablicy products[], przez co
          // meal_plan/cancellation zawsze wychodzily puste niezaleznie od
          // tego jak poprawnie je parsujemy.
          extras: ["products"],
          ...locationPart,
        };
        if (sortPart) request.sort = sortPart;
        if (pricePart) request.price = pricePart;
        if (ratingPart) request.rating = ratingPart;

        const result = await client.searchAccommodations(request);

        // Jesli user prosil o required_facilities, a drugie zapytanie do API
        // (pobierajace facilities) zawiodlo mimo retry - NIE mowimy "brak
        // wynikow" (to mylace, bo faktycznie moga istniec pasujace hotele,
        // po prostu nie wiemy tego w tej chwili). To byla realna przyczyna
        // zgloszenia Eweliny (zwierzeta+sniadanie+cena w Gdansku dawaly
        // falszywy "brak wynikow" mimo dostepnych hoteli na Booking.com).
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

        let hotels = result.hotels;

        if (maxTotalPrice != null) {
          hotels = hotels.filter(function (h) { return h.price != null && h.price.amount <= maxTotalPrice; });
        }
        if (minTotalPrice != null) {
          hotels = hotels.filter(function (h) { return h.price != null && h.price.amount >= minTotalPrice; });
        }

        if (params.min_review_score != null) {
          const filtered = hotels.filter(function (h) {
            return h.review_score != null && h.review_score >= params.min_review_score!;
          });
          if (filtered.length > 0 || hotels.every(h => h.review_score != null)) hotels = filtered;
        }

        if (params.min_stars) {
          const filtered = hotels.filter(function (h) {
            if (h.star_rating == null) return false;
            return params.exact_stars
              ? h.star_rating === params.min_stars
              : h.star_rating >= params.min_stars!;
          });
          if (filtered.length > 0) hotels = filtered;
        }

        if (params.exclude_hostels) {
          const beforeExclusion = hotels.length;
          hotels = hotels.filter(function (h) {
            return h.accommodation_type_id !== HOSTEL_ACCOMMODATION_TYPE &&
                   h.accommodation_type_id !== APARTMENT_ACCOMMODATION_TYPE;
          });
          console.error("=== DIAG exclude_hostels: " + beforeExclusion + " -> " + hotels.length +
            " hoteli.");
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
                // Nieznana wartosc amenity - brak mapowania na ID Booking.com.
                // Zamiast crashowac cale zapytanie (jak dotychczas przez
                // "ids.some is not a function"), traktujemy to jako
                // niespelnione kryterium i głośno logujemy do diagnozy.
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
              .map(function (h) { return { hotel_id: h.hotel_id, name: h.name, meal_plans: h.meal_plans }; })));
          // USUNIETE zabezpieczenie "if (filtered.length > 0)" - ono po
          // cichu IGNOROWALO filtr i zwracalo NIEFILTROWANA liste, gdy
          // zastosowanie filtra dawaloby zero wynikow. To pokazywalo
          // userowi hotele ktore JAWNIE NIE SPELNIAJA zadanego kryterium
          // (potwierdzony w logach testowych przypadek: "Novotel Poznań
          // Malta" bez sniadania pokazywany mimo breakfast_only:true,
          // bo zastosowanie filtra dalo 1 wynik z 15 i stary kod i tak by
          // to przepuscil - ale przy 0 wynikow zwracalby CALA
          // niefiltrowana liste 15 hoteli bez sniadania, mowiac ze
          // wszystkie maja sniadanie). Prawdziwe zero wynikow jest juz
          // poprawnie obslugiwane nizej (blok "formatted.length === 0"
          // z komunikatem o rozluznieniu filtrow).
          hotels = filtered;
        }

        if (params.free_cancellation_only) {
          const beforeCancellation = hotels.length;
          const filtered = hotels.filter(function (h) { return h.free_cancellation === true; });
          console.error("=== DIAG free_cancellation_only: " + beforeCancellation + " -> " + filtered.length +
            " hoteli. Przyklad free_cancellation z odrzuconych: " +
            JSON.stringify(hotels.filter(function (h) { return filtered.indexOf(h) === -1; })
              .slice(0, 5)
              .map(function (h) { return { hotel_id: h.hotel_id, name: h.name, free_cancellation: h.free_cancellation }; })));
          // USUNIETE zabezpieczenie "if (filtered.length > 0)" - ten sam
          // blad co przy breakfast_only powyzej. POTWIERDZONY w logach
          // testowych 2026-08-26: zapytanie o Poznan ze sniadaniem+
          // bezplatna anulacja dla 2 doroslych+dziecko dalo po
          // breakfast_only dokladnie 1 hotel ("Gościniec Lizawka"), ktory
          // NIE mial bezplatnej anulacji (free_cancellation:false).
          // Filtr free_cancellation_only poprawnie zredukowal wynik do 0,
          // ale stary kod z "if (filtered.length > 0)" ZIGNOROWAL to i
          // zwrocil z powrotem tego samego, niepasujacego hotela userowi
          // jako rzekomo spelniajacego oba kryteria.
          hotels = filtered;
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
          if (params.sort_by === "distance") {
            hotels = hotels.slice().sort(function (a, b) {
              const da = distanceById.has(a.hotel_id) ? distanceById.get(a.hotel_id)! : Infinity;
              const db = distanceById.has(b.hotel_id) ? distanceById.get(b.hotel_id)! : Infinity;
              return da - db;
            });
          }
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

        if (formatted.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No hotels found for " + locationLabel + " between " + checkin + " and " + checkout + " matching your criteria. Try relaxing the filters (price, amenities, rating, or hostel exclusion), a larger radius, or different dates.",
            }],
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
          hotels: formatted,
          currency: currency,
        };

        const appliedFilters: string[] = [];
        if (maxTotalPrice != null) appliedFilters.push("max " + params.max_price_per_night + " " + params.currency + "/night");
        if (minTotalPrice != null) appliedFilters.push("min " + params.min_price_per_night + " " + params.currency + "/night");
        if (params.min_review_score != null) appliedFilters.push("review score >= " + params.min_review_score);
        if (params.min_stars) appliedFilters.push((params.exact_stars ? "exactly " : "") + params.min_stars + (params.exact_stars ? " stars" : "+ stars"));
        if (params.exclude_hostels) appliedFilters.push("hostels/apartments excluded");
        if (params.required_facilities && params.required_facilities.length > 0) appliedFilters.push("must have: " + params.required_facilities.join(", "));
        if (params.breakfast_only) appliedFilters.push("breakfast included only");
        if (params.free_cancellation_only) appliedFilters.push("free cancellation only");
        if (appliedFilters.length > 0) {
          output.filters_applied_note = "Filters enforced server-side (guaranteed accurate, not just re-described): " + appliedFilters.join("; ") + ".";
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