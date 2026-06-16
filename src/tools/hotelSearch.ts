import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { HotelSearchOutput } from "../types.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";

export function registerHotelSearchTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_search_hotels",
    {
      title: "Search Hotels on Booking.com",
      description: "Search for available hotels using Booking.com. Supported cities: Warszawa, Krakow, Amsterdam.\nArgs: city, checkin (YYYY-MM-DD), checkout (YYYY-MM-DD), adults, rooms, currency, breakfast_only, free_cancellation_only, min_stars (only if user explicitly requests it), results_limit, sort_by (price/review_score/distance/popularity).\nReturns hotels with prices and booking URLs.",
      inputSchema: HotelSearchInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: HotelSearchInput) => {

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(params.checkin) || !dateRegex.test(params.checkout)) {
        return {
          content: [{ type: "text", text: "Error: checkin and checkout must be in YYYY-MM-DD format." }],
          isError: true,
        };
      }

      const checkinDate = new Date(params.checkin);
      const checkoutDate = new Date(params.checkout);

      if (checkoutDate <= checkinDate) {
        return {
          content: [{ type: "text", text: "Error: checkout must be after checkin." }],
          isError: true,
        };
      }

      const cityResult = resolveCityId(params.city);
      if (!cityResult) {
        return {
          content: [{
            type: "text",
            text: "City \"" + params.city + "\" not supported. Supported cities: Warszawa, Krakow, Amsterdam. Call booking_search_cities to check.",
          }],
          isError: true,
        };
      }

      const nights = Math.round((checkoutDate.getTime() - checkinDate.getTime()) / 86400000);

      try {
        const result = await client.searchAccommodations({
          booker: { country: DEFAULT_BOOKER_COUNTRY, platform: DEFAULT_BOOKER_PLATFORM },
          checkin: params.checkin,
          checkout: params.checkout,
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
              text: "No hotels found in " + cityResult.name + " for " + params.checkin + " to " + params.checkout + ". Try without filters.",
            }],
          };
        }

        const output: HotelSearchOutput = {
          success: true,
          city: cityResult.name,
          city_id: cityResult.city_id,
          checkin: params.checkin,
          checkout: params.checkout,
          nights: nights,
          adults: params.adults,
          total_found: result.total_count,
          hotels: formatted,
          currency: currency,
        };

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