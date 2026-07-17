import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { z } from "zod";

const FindHotelInputSchema = z.object({
  hotel_name: z.string().min(2).max(200)
    .describe("Hotel name to search for, e.g. \"ibis Amsterdam Centre\", \"Marriott Warsaw\""),
  city: z.string().min(2).max(100)
    .describe('City where the hotel is located, IN ENGLISH, e.g. "Warsaw" (not "Warszawa"), "Amsterdam", "Rome" (not "Roma"). Always translate the city name to English before calling.'),
  country: z.string().min(2).max(2)
    .describe('Two-letter lowercase country code of the city, e.g. "pl", "nl". Infer it from the city name.'),
});

type FindHotelInput = z.infer<typeof FindHotelInputSchema>;

export function registerFindHotelTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_find_hotel",
    {
      title: "Find Hotel by Name",
      description: "Find a hotel by name in any city worldwide to get its hotel_id, which can then be used with booking_get_hotel_details. Use this when the user asks about a specific hotel by name but has not provided dates. Does NOT require dates. Args: hotel_name, city (in English), country (2-letter code).",
      inputSchema: FindHotelInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: FindHotelInput) => {
      const cityResult = await resolveCityId(client, params.city, params.country);

      if (!cityResult) {
        return {
          content: [{
            type: "text",
            text: "City \"" + params.city + "\" not found in country \"" + params.country + "\" on Booking.com. Check the spelling and the country code.",
          }],
          isError: true,
        };
      }

      try {
        // Szukamy w terminie ok. 90 dni do przodu - szeroka dostepnosc hoteli
        const base = new Date();
        base.setDate(base.getDate() + 90);
        const co = new Date(base);
        co.setDate(co.getDate() + 2);

        const checkin = base.toISOString().split("T")[0];
        const checkout = co.toISOString().split("T")[0];

        const result = await client.searchAccommodations({
          booker: { country: "nl", platform: "desktop" },
          checkin: checkin,
          checkout: checkout,
          city: cityResult.city_id,
          guests: { number_of_adults: 1, number_of_rooms: 1 },
          currency: "PLN",
          rows: 100,
        });

        if (result.hotels.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No hotels found in " + params.city + ".",
            }],
          };
        }

        const searchName = params.hotel_name.toLowerCase();
        const matched = result.hotels.filter(function (h) {
          return h.name.toLowerCase().indexOf(searchName) !== -1 ||
            searchName.indexOf(h.name.toLowerCase()) !== -1;
        });

        const hotels = matched.length > 0 ? matched : result.hotels;

        const output = {
          hotels: hotels.slice(0, 5).map(function (h) {
            return {
              hotel_id: h.hotel_id,
              name: h.name,
              booking_url: h.url ?? null,
            };
          }),
          total: hotels.length,
          note: matched.length === 0
            ? "Exact match not found. Showing available hotels in " + params.city + "."
            : "Found " + matched.length + " matching hotel(s).",
          data_source: "Booking.com API",
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API",
          }],
          structuredContent: output,
        };

      } catch (err) {
        return {
          content: [{
            type: "text",
            text: "Error finding hotel: " + (err instanceof Error ? err.message : String(err)),
          }],
          isError: true,
        };
      }
    }
  );
}