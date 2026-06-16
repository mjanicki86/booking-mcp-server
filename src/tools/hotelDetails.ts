import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError } from "../services/bookingClient.js";
import { z } from "zod";
import { BOOKING_API_BASE_URL } from "../constants.js";

const HotelDetailsInputSchema = z.object({
  hotel_id: z.number().int()
    .describe("Hotel ID from booking_search_hotels results"),
  language: z.string().default("pl")
    .describe('Language for results, e.g. "pl", "en". Default: pl'),
});

type HotelDetailsInput = z.infer<typeof HotelDetailsInputSchema>;

export function registerHotelDetailsTool(server: McpServer, apiKey: string, affiliateId: string): void {
  server.registerTool(
    "booking_get_hotel_details",
    {
      title: "Get Hotel Details",
      description: "Get detailed information about a specific hotel including facilities (parking, pool, gym, WiFi, restaurant), room types, check-in/out policies, payment options, and pet policy.\nRequires hotel_id from booking_search_hotels results.\nArgs:\n  - hotel_id (number): Hotel ID from search results\n  - language (string): Language code, default 'pl'",
      inputSchema: HotelDetailsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: HotelDetailsInput) => {
      try {
        const url = BOOKING_API_BASE_URL + "/accommodations/details";
        console.error("=== Calling hotel details: " + url + " for hotel " + params.hotel_id);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Affiliate-Id": affiliateId,
            "Authorization": "Bearer " + apiKey,
          },
          body: JSON.stringify({
            accommodations: [params.hotel_id],
            extras: ["facilities", "description", "payment", "policies", "rooms"],
            language: params.language,
          }),
          signal: AbortSignal.timeout(30000),
        });

        const responseText = await response.text();
        console.error("=== Hotel details response status: " + response.status);
        console.error("=== Hotel details response: " + responseText.slice(0, 1000));

        if (!response.ok) {
          return {
            content: [{
              type: "text",
              text: "Booking.com API error (" + response.status + "): " + responseText,
            }],
            isError: true,
          };
        }

        const raw = JSON.parse(responseText);
        const hotels = raw.data ?? raw.result ?? raw.accommodations ?? [];

        if (!hotels || hotels.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No details found for hotel ID " + params.hotel_id + ". Make sure the ID comes from a booking_search_hotels result.",
            }],
          };
        }

        const hotel = hotels[0];

        // Extract facilities
        const facilities: string[] = [];
        if (hotel.facilities) {
          for (const f of hotel.facilities) {
            if (f.name) facilities.push(f.name);
          }
        }

        // Extract room info
        const rooms: any[] = [];
        if (hotel.rooms) {
          for (const room of hotel.rooms) {
            rooms.push({
              name: room.name ?? "Room",
              max_occupancy: room.max_occupancy,
              facilities: room.facilities ? room.facilities.map((f: any) => f.name).filter(Boolean) : [],
            });
          }
        }

        const output = {
          hotel_id: params.hotel_id,
          name: hotel.name ?? "Unknown",
          address: hotel.address ?? null,
          stars: hotel.class ?? hotel.star_rating ?? null,
          description: hotel.description ?? hotel.hotel_description ?? null,
          checkin_time: hotel.checkin?.from ?? hotel.check_in_time ?? null,
          checkout_time: hotel.checkout?.until ?? hotel.check_out_time ?? null,
          facilities: facilities,
          rooms: rooms,
          payment_methods: hotel.payment_methods ? hotel.payment_methods.map((p: any) => p.name).filter(Boolean) : [],
          pets_allowed: hotel.pets ?? hotel.pet_policy ?? null,
          parking: hotel.parking ?? null,
          url: hotel.url ?? null,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };

      } catch (err) {
        return {
          content: [{
            type: "text",
            text: "Error getting hotel details: " + (err instanceof Error ? err.message : String(err)),
          }],
          isError: true,
        };
      }
    }
  );
}