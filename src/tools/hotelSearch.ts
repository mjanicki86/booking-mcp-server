import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";

// Domyslne daty przy braku dat od uzytkownika:
// checkin = najblizszy piatek okolo 90 dni od dzis, checkout = +2 noce (weekend)
function getDefaultDates(): { checkin: string; checkout: string } {
  const base = new Date();
  base.setDate(base.getDate() + 90);
  const day = base.getDay(); // 0=niedziela ... 5=piatek
  const toFriday = (5 - day + 7) % 7;
  base.setDate(base.getDate() + toFriday);
  const checkout = new Date(base);
  checkout.setDate(checkout.getDate() + 2);
  return {
    checkin: base.toISOString().split("T")[0],
    checkout: checkout.toISOString().split("T")[0],
  };
}

export function registerHotelSearchTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_search_hotels",
    {
      title: "Search Hotels on Booking.com",
      description: "Search for available hotels in ANY city worldwide using Booking.com. Dates are OPTIONAL: if the user did not provide dates, call this tool WITHOUT checkin/checkout instead of asking the user - sample prices for a weekend about 3 months ahead will be returned.\nArgs: city, country (2-letter code, infer from city), checkin (YYYY-MM-DD, optional), checkout (optional), adults, rooms, currency, breakfast_only, free_cancellation_only, min_stars (only if user explicitly requests it), results_limit (set when user asks for a specific number, up to 100), sort_by (price/review_score/distance/popularity).\nReturns hotels with prices and booking URLs.",
      inputSchema: HotelSearchInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: HotelSearchInput) => {

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

      const cityResult = await resolveCityId(client, params.city, params.country);
      if (!cityResult) {
        return {
          content: [{
            type: "text",
            text: "City \"" + params.city + "\" not found in country \"" + params.country + "\" on Booking.com. Check the spelling and the country code, or use booking_search_cities to search.",
          }],
          isError: true,
        };
      }

      const nights = Math.round((checkoutDate.getTime() - checkinDate.getTime()) / 86400000);

      try {
        const result = await client.searchAccommodations({
          booker: { country: DEFAULT_BOOKER_COUNTRY, platform: DEFAULT_BOOKER_PLATFORM },
          checkin: checkin,
          checkout: checkout,
          city: cityResult.city_id,
          guests: {
            number_of_adults: params.adults,
            number_of_rooms: params.rooms,
          },
          currency: params.currency,
          rows: params.results_limit,
        });

        let hotels = result.hotels;

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

        if (params.sort_by === "price") {
          hotels.sort(function (a, b) {
            return (a.price ? a.price.amount : 999999) - (b.price ? b.price.amount : 999999);
          });
        } else if (params.sort_by === "review_score") {
          hotels.sort(function (a, b) { return (b.review_score ?? 0) - (a.review_score ?? 0); });
        } else if (params.sort_by === "distance") {
          hotels.sort(function (a, b) {
            const da = a.location && a.location.distance_to_center != null ? a.location.distance_to_center : 999;
            const db = b.location && b.location.distance_to_center != null ? b.location.distance_to_center : 999;
            return da - db;
          });
        }

        const currency = result.currency ?? params.currency;
        const formatted = hotels.slice(0, params.results_limit).map(function (h) {
          return formatHotel(h, currency);
        });

        if (formatted.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No hotels found in " + cityResult.name + " for " + checkin + " to " + checkout + ". Try without filters or different dates.",
            }],
          };
        }

        const output: any = {
          success: true,
          city: cityResult.name,
          city_id: cityResult.city_id,
          checkin: checkin,
          checkout: checkout,
          nights: nights,
          adults: params.adults,
          total_found: result.total_count,
          hotels: formatted,
          currency: currency,
        };

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