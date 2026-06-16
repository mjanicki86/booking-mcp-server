import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BOOKING_API_BASE_URL } from "../constants.js";

const HotelDetailsInputSchema = z.object({
  hotel_id: z.number().int()
    .describe("Hotel ID from booking_search_hotels results"),
});

type HotelDetailsInput = z.infer<typeof HotelDetailsInputSchema>;

export function registerHotelDetailsTool(
  server: McpServer,
  apiKey: string,
  affiliateId: string
): void {
  server.registerTool(
    "booking_get_hotel_details",
    {
      title: "Get Hotel Details",
      description: "Get detailed information about a specific hotel including facilities (parking, pool, gym, WiFi, restaurant), room types, check-in/out policies, and payment options. Requires hotel_id from booking_search_hotels results. Args: hotel_id (number): Hotel ID from search results.",
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
        const endpoint = "/accommodations/details";
        const url = BOOKING_API_BASE_URL + endpoint;
        console.error("=== Calling hotel details for hotel " + params.hotel_id);

        const requestBody = {
          accommodations: [params.hotel_id],
          extras: ["facilities", "description", "payment", "policies", "rooms"],
        };

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Affiliate-Id": affiliateId,
            "Authorization": "Bearer " + apiKey,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(30000),
        });

        const responseText = await response.text();
        console.error("=== Hotel details status: " + response.status);
        console.error("=== Hotel details body: " + responseText.slice(0, 1000));

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
        const hotels: any[] = raw.data ?? raw.result ?? raw.accommodations ?? [];

        if (hotels.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No details found for hotel ID " + params.hotel_id,
            }],
          };
        }

        const hotel = hotels[0];

        const facilities: string[] = [];
        if (Array.isArray(hotel.facilities)) {
          for (const f of hotel.facilities) {
            if (f.name) facilities.push(String(f.name));
          }
        }

        const rooms: any[] = [];
        if (Array.isArray(hotel.rooms)) {
          for (const room of hotel.rooms) {
            const roomFacilities: string[] = [];
            if (Array.isArray(room.facilities)) {
              for (const f of room.facilities) {
                if (f.name) roomFacilities.push(String(f.name));
              }
            }
            rooms.push({
              name: room.name ?? "Room",
              max_occupancy: room.max_occupancy ?? null,
              facilities: roomFacilities,
            });
          }
        }

        const paymentMethods: string[] = [];
        if (Array.isArray(hotel.payment_methods)) {
          for (const p of hotel.payment_methods) {
            if (p.name) paymentMethods.push(String(p.name));
          }
        }

        const output = {
          hotel_id: params.hotel_id,
          name: hotel.name ?? "Unknown",
          address: hotel.address ?? null,
          stars: hotel.class ?? hotel.star_rating ?? null,
          description: hotel.description ?? hotel.hotel_description ?? null,
          checkin_time: hotel.checkin ? hotel.checkin.from ?? null : null,
          checkout_time: hotel.checkout ? hotel.checkout.until ?? null : null,
          facilities: facilities,
          rooms: rooms,
          payment_methods: paymentMethods,
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