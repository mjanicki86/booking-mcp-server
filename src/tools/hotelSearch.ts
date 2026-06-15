import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { HotelSearchOutput } from "../types.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";

export function registerHotelSearchTool(
  server: McpServer,
  client: BookingApiClient,
  apiKey: string
): void {
  server.registerTool(
    "booking_search_hotels",
    {
      title: "Search Hotels on Booking.com",
      description: `Search for available hotels using Booking.com. Works for any city worldwide.
Args: city (any language), checkin (YYYY-MM-DD), checkout (YYYY-MM-DD), adults, rooms,
currency, breakfast_only, free_cancellation_only, min_stars, results_limit, sort_by
(one of: price, review_score, distance, popularity).
Returns list of hotels with prices, ratings, distances, and booking URLs.`,
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
          content: [{ type: "text", text: "Error: checkout date must be after checkin date." }],
          isError: true,
        };
      }

      let cityResult;
      try {
        cityResult = await resolveCityId(params.city, apiKey);
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Error looking up city "${params.city}": ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }

      if (!cityResult) {
        return {
          content: [{
            type: "text",
            text: `City "${params.city}" not found. Try calling booking_search_cities with a partial name to find the correct spelling.`,
          }],
          isError: true,
        };
      }

      const { city_id: cityId, name: resolvedCityName, country } = cityResult;
      const nights = Math.round((checkoutDate.getTime() - checkinDate.getTime()) / 86400000);

      try {
        const result = await client.searchAccommodations({
          booker: { country: DEFAULT_BOOKER_COUNTRY, platform: DEFAULT_BOOKER_PLATFORM },
          checkin: params.checkin,
          checkout: params.checkout,
          city: cityId,
          guests: {
            number_of_adults: params.adults,
            number_of_rooms: params.rooms,
          },
          currency: params.currency,
          extras: ["hotel_info", "price_breakdown", "meal_plan"],
          rows: params.results_limit,
        });

        let hotels = result.hotels;
        if (params.breakfast_only)
          hotels = hotels.filter(h =>
            h.meal_plans?.some(mp =>
              mp.code === "breakfast_included" || mp.name?.toLowerCase().includes("breakfast")
            )
          );
        if (params.free_cancellation_only)
          hotels = hotels.filter(h => h.free_cancellation);
        if (params.min_stars)
          hotels = hotels.filter(h => h.star_rating != null && h.star_rating >= params.min_stars!);

        if (params.sort_by === "price")
          hotels.sort((a, b) => (a.price?.amount ?? 999999) - (b.price?.amount ?? 999999));
        else if (params.sort_by === "review_score")
          hotels.sort((a, b) => (b.review_score ?? 0) - (a.review_score ?? 0));
        else if (params.sort_by === "distance")
          hotels.sort((a, b) =>
            (a.location?.distance_to_center ?? 999) - (b.location?.distance_to_center ?? 999)
          );

        const currency = result.currency ?? params.currency;
        const formatted = hotels.slice(0, params.results_limit).map(h => formatHotel(h, currency));

        if (!formatted.length) {
          return {
            content: [{
              type: "text",
              text: `No hotels found in "${resolvedCityName}, ${country}" for ${params.checkin}–${params.checkout}. Try relaxing your filters.`,
            }],
          };
        }

        const output: HotelSearchOutput = {
          success: true,
          city: resolvedCityName,
          city_id: cityId,
          checkin: params.checkin,
          checkout: params.checkout,
          nights,
          adults: params.adults,
          total_found: result.total_count,
          hotels: formatted,
          currency,
        };

        const text = JSON.stringify(output, null, 2);
        return {
          content: [{
            type: "text",
            text: text.length > CHARACTER_LIMIT
              ? text.slice(0, CHARACTER_LIMIT) + "\n...[truncated]"
              : text,
          }],
          structuredContent: output,
        };

      } catch (err) {
        if (err instanceof BookingApiRequestError) {
          return {
            content: [{
              type: "text",
              text: `Booking.com API error (${err.apiError.status}): ${err.apiError.message}`,
            }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );
}