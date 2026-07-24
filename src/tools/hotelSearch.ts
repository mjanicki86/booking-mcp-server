import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";

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

function rowsToFetch(usingCoordinates: boolean, resultsLimit: number): number {
  if (usingCoordinates) {
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
      description: "Search for available hotels in ANY city worldwide, or near ANY specific point (landmark, station, address) using Booking.com.\nLOCATION - use ONE of two modes, choose carefully:\n  1. city + country: ONLY for generic 'hotels in [city]' requests with no specific place mentioned. City name must be in ENGLISH.\n  2. latitude + longitude (+ radius_km): MANDATORY whenever the user names a specific place or distance ('near X', 'within Y km of X', 'close to X'), e.g. 'hotels within 2 km of the Palace of Culture' -> latitude 52.2318, longitude 21.0060, radius_km 2. You must supply the REAL coordinates of the named place yourself - never fall back to a plain city search and claim the results are near that place; if you do not know the coordinates, tell the user instead of guessing. Combine with sort_by 'distance' for closest-first results (real calculated distance, not just the API's own ordering).\nDATES are OPTIONAL: if the user did not provide dates, call the tool WITHOUT checkin/checkout instead of asking - sample prices for a weekend about 3 months ahead will be returned.\nPRICE: use max_price_per_night whenever the user gives a price limit ('up to 300 PLN a night'). This is enforced server-side, so results are guaranteed to respect it - always call the tool again with a new max_price_per_night if the user changes their budget, do not just re-describe the previous results.\nOther args: adults, rooms, currency, breakfast_only, free_cancellation_only, min_stars (only if explicitly requested), results_limit (set when user asks for a specific number, up to 100), sort_by (price/review_score/distance/popularity).\nNote: this tool does NOT return hotel amenities (pool, gym, etc.) or addresses - for those, or to check a specific amenity like 'has a pool', call booking_get_hotel_details for each hotel and check its facilities field, not just its text description.\nReturns hotels with prices and booking URLs.",
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
      } else if (params.sort_by === "review_score") {
        sortPart = { by: "review_score", direction: "descending" };
      }

      // Filtr ceny za noc: probujemy przekazac do API (moze nie byc wspierane w 3.1),
      // a NIEZALEZNIE OD TEGO filtrujemy tez sami po stronie serwera nizej -
      // to gwarantuje poprawnosc bez wzgledu na to, czy API respektuje filtr.
      let filtersPart: any = undefined;
      const maxTotalPrice = params.max_price_per_night != null
        ? Math.round(params.max_price_per_night * nights * 100) / 100
        : undefined;
      if (maxTotalPrice != null) {
        filtersPart = { price: { maximum: String(maxTotalPrice) } };
      }

      try {
        const request: any = {
          booker: { country: DEFAULT_BOOKER_COUNTRY, platform: DEFAULT_BOOKER_PLATFORM },
          checkin: checkin,
          checkout: checkout,
          guests: {
            number_of_adults: params.adults,
            number_of_rooms: params.rooms,
          },
          currency: params.currency,
          rows: rowsToFetch(usingCoordinates, params.results_limit),
          ...locationPart,
        };
        if (sortPart) request.sort = sortPart;
        if (filtersPart) request.filters = filtersPart;

        const result = await client.searchAccommodations(request);

        let hotels = result.hotels;

        // Filtr ceny PO STRONIE SERWERA - dziala niezaleznie od tego,
        // czy Booking.com faktycznie respektuje filters.price w tej wersji API.
        if (maxTotalPrice != null) {
          const filtered = hotels.filter(function (h) {
            return h.price != null && h.price.amount <= maxTotalPrice;
          });
          hotels = filtered;
        }

        if (params.breakfast_only) {
          const filtered = hotels.filter(function (h) {
            return h.meal_plans && h.meal_plans.some(function (mp) {
              return mp.code === "breakfast_included" ||
                (mp.name != null && mp.name.toLowerCase().indexOf("breakfast") !== -1);
            });
          });
          if (filtered.length > 0) hotels = filtered;
        }

        if (params.free_cancellation_only) {
          const filtered = hotels.filter(function (h) { return h.free_cancellation === true; });
          if (filtered.length > 0) hotels = filtered;
        }

        if (params.min_stars) {
          const filtered = hotels.filter(function (h) {
            return h.star_rating != null && h.star_rating >= params.min_stars!;
          });
          if (filtered.length > 0) hotels = filtered;
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
          const priceHint = maxTotalPrice != null
            ? " Try a higher price limit (checked up to " + params.max_price_per_night + " " + params.currency + "/night)."
            : "";
          return {
            content: [{
              type: "text",
              text: "No hotels found for " + locationLabel + " between " + checkin + " and " + checkout + " matching your criteria." + priceHint + " Try a larger radius, different dates, or fewer filters.",
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

        if (maxTotalPrice != null) {
          output.price_filter_note = "Results are filtered to a maximum of " + params.max_price_per_night + " " + params.currency + " per night (" + maxTotalPrice + " " + params.currency + " total for " + nights + " night(s)), enforced by the server.";
        }

        if (usingCoordinates) {
          output.radius_km = params.radius_km;
          output.location_note = "Results are limited to " + params.radius_km + " km around the given point" +
            (params.sort_by === "distance"
              ? ", sorted by real calculated distance (closest first). distance_km on each hotel is the actual straight-line distance to the given point."
              : ". Each hotel includes distance_km (straight-line distance to the given point) even though results are not sorted by it.");
        } else {
          output.location_note = "This is a city-wide search. It does NOT filter by distance to any specific landmark. If the user asked about a specific place, redo the search with coordinates instead.";
        }

        if (datesAssumed) {
          output.dates_note = "User did not provide dates. These are SAMPLE prices for an assumed weekend (" + checkin + " to " + checkout + "). Tell the user these dates were assumed and that they can provide their own dates for exact offers.";
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