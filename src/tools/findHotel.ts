import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { z } from "zod";
import { CITY_ID_MAP } from "../constants.js";

const FindHotelInputSchema = z.object({
  hotel_name: z.string().min(2).max(200)
    .describe("Hotel name to search for, e.g. \"ibis Amsterdam Centre\", \"Marriott Warsaw\""),
  city: z.string().min(2).max(100)
    .describe("City where the hotel is located, e.g. \"Amsterdam\", \"Warszawa\""),
});

type FindHotelInput = z.infer<typeof FindHotelInputSchema>;

function normalizeCityName(cityName: string): string {
  return cityName.toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function registerFindHotelTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_find_hotel",
    {
      title: "Find Hotel by Name",
      description: "Find a hotel by name to get its hotel_id, which can then be used with booking_get_hotel_details. Use this when the user asks about a specific hotel by name but has not provided dates. Does NOT require dates. Args: hotel_name (string): name of the hotel, city (string): city where hotel is located.",
      inputSchema: FindHotelInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: FindHotelInput) => {
      const normalized = normalizeCityName(params.city);
      const cityEntry = CITY_ID_MAP[normalized];

      if (!cityEntry) {
        return {
          content: [{
            type: "text",
            text: "City \"" + params.city + "\" not supported. Supported cities: Warszawa, Krakow, Amsterdam.",
          }],
          isError: true,
        };
      }

      try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayAfter = new Date();
        dayAfter.setDate(dayAfter.getDate() + 2);

        const checkin = tomorrow.toISOString().split("T")[0];
        const checkout = dayAfter.toISOString().split("T")[0];

        const result = await client.searchAccommodations({
          booker: { country: "nl", platform: "desktop" },
          checkin: checkin,
          checkout: checkout,
          city: cityEntry.city_id,
          guests: { number_of_adults: 1, number_of_rooms: 1 },
          currency: "PLN",
          rows: 20,
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