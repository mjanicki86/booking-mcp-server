import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";

const HOSTEL_ACCOMMODATION_TYPE = 203;

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
  // dokladnie "pets_allowed". Model czasem probowal wyslac samo "pets" -
  // to zostaje odrzucone juz na etapie walidacji Zod, zanim dotrze tutaj.
  // Poprawka opisu w schema (patrz inputSchemas.ts) ma to ograniczyc.
  // ID=4 nadal wymaga weryfikacji - patrz notatka w rozmowie z 2026-08.
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
      description: "Search for available hotels in ANY city worldwide, or near ANY specific point (landmark, station, address) using Booking.com.\nLOCATION - use ONE of two modes: (1) city + country for generic 'hotels in [city]' requests (city name in ENGLISH); (2) latitude + longitude (+ radius_km) MANDATORY whenever the user names a specific place or distance - supply the REAL coordinates yourself, never fall back to a plain city search and claim proximity.\nDATES are OPTIONAL: if not given, call the tool WITHOUT checkin/checkout instead of asking - sample prices ~3 months ahead will be returned.\nPRICE: max_price_per_night / min_price_per_night are enforced server-side - always call the tool again with the new value if the user changes their budget, never just re-describe previous results.\nAMENITIES: use required_facilities (e.g. ['pool','gym']) to filter hotels that must have specific amenities - this is enforced server-side and is far more reliable than checking booking_get_hotel_details on each result yourself.\nQUALITY: min_stars, min_review_score, exclude_hostels (set true for 'a proper hotel, no hostels').\nOther args: adults, rooms, children_count/children_ages, currency, breakfast_only, free_cancellation_only, results_limit (up to 100), sort_by (price/review_score/distance/stars/popularity).\nNote: this tool does not return full amenity lists or addresses in detail - for full details on ONE specific hotel, call booking_get_hotel_details.\nReturns hotels with prices and booking URLs.",
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
          const starsArr: number[] = [];
          for (let s = params.min_stars; s <= 5; s++) starsArr.push(s);
          ratingPart.stars = starsArr;
        }
      }

      const hasStrongFilters = !!(
        maxTotalPrice != null || minTotalPrice != null ||
        params.min_review_score != null ||
        (params.required_facilities && params.required_facilities.length > 0) ||
        params.exclude_hostels
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
          ...locationPart,
        };
        if (sortPart) request.sort = sortPart;
        if (pricePart) request.price = pricePart;
        if (ratingPart) request.rating = ratingPart;

        const result = await client.searchAccommodations(request);

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
            return h.star_rating != null && h.star_rating >= params.min_stars!;
          });
          if (filtered.length > 0) hotels = filtered;
        }

        if (params.exclude_hostels) {
          hotels = hotels.filter(function (h) {
            return h.accommodation_type_id !== HOSTEL_ACCOMMODATION_TYPE;
          });
        }

        if (params.required_facilities && params.required_facilities.length > 0) {
          const beforeCount = hotels.length;
          hotels = hotels.filter(function (h) {
            if (!h.facilities) return false;
            return params.required_facilities!.every(function (amenity) {
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
          });
          console.error("=== DIAG required_facilities=" + params.required_facilities.join(",") +
            " zredukowal wyniki z " + beforeCount + " do " + hotels.length +
            ". Sprawdzane ID: " + JSON.stringify(params.required_facilities.map(a => ({ [a]: AMENITY_FACILITY_IDS[a] }))));
        }

        if (params.breakfast_only) {
          const filtered = hotels.filter(function (h) {
            return h.meal_plans && h.meal_plans.some(function (mp) {
              return mp.code === "breakfast_included" ||
                (mp.name != null && mp.name.toLowerCase().indexOf("breakfast") !== -1);
            });
          });
          if (filtered.length > 0) {
            const dropped = hotels.filter(function (h) { return filtered.indexOf(h) === -1; });
            if (dropped.length > 0) {
              console.error("=== DIAG breakfast_only odrzucil " + dropped.length + " hoteli: " +
                JSON.stringify(dropped.map(function (h) {
                  return { hotel_id: h.hotel_id, name: h.name, meal_plans: h.meal_plans };
                })));
            }
            hotels = filtered;
          }
        }

        if (params.free_cancellation_only) {
          const filtered = hotels.filter(function (h) { return h.free_cancellation === true; });
          if (filtered.length > 0) {
            const dropped = hotels.filter(function (h) { return filtered.indexOf(h) === -1; });
            if (dropped.length > 0) {
              console.error("=== DIAG free_cancellation_only odrzucil " + dropped.length + " hoteli: " +
                JSON.stringify(dropped.map(function (h) {
                  return { hotel_id: h.hotel_id, name: h.name, free_cancellation: h.free_cancellation };
                })));
            }
            hotels = filtered;
          }
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
        if (params.min_stars) appliedFilters.push(params.min_stars + "+ stars");
        if (params.exclude_hostels) appliedFilters.push("hostels excluded");
        if (params.required_facilities && params.required_facilities.length > 0) appliedFilters.push("must have: " + params.required_facilities.join(", "));
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