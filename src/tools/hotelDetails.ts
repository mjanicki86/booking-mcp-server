import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";

const HotelDetailsInputSchema = z.object({
  hotel_id: z.number().int()
    .describe("Hotel ID from booking_search_hotels or booking_find_hotel results"),
});

type HotelDetailsInput = z.infer<typeof HotelDetailsInputSchema>;

function extractText(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    return field["en-gb"] ?? field["pl"] ?? field["en"] ?? Object.values(field)[0] as string ?? null;
  }
  return null;
}

export function registerHotelDetailsTool(
  server: McpServer,
  apiKey: string,
  affiliateId: string
): void {
  server.registerTool(
    "booking_get_hotel_details",
    {
      title: "Get Hotel Details",
      description: "Get detailed information about a specific hotel including facilities (parking, pool, gym, WiFi, restaurant), room types, check-in/out policies, and payment options. Requires hotel_id from booking_search_hotels or booking_find_hotel results. Args: hotel_id (number): Hotel ID from search results.",
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
        const url = config.bookingApiBaseUrl + endpoint;
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
        console.error("=== Hotel details body: " + responseText.slice(0, 2000));

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

        const name = extractText(hotel.name) ?? "Unknown";
        const description = extractText(hotel.description?.text) ?? extractText(hotel.description) ?? null;
        const importantInfo = extractText(hotel.description?.important_information) ?? null;
        const checkinFrom = hotel.checkin_checkout_times?.checkin_from ?? null;
        const checkoutTo = hotel.checkin_checkout_times?.checkout_to ?? null;

        const facilities: string[] = [];
        if (Array.isArray(hotel.facilities)) {
          for (const f of hotel.facilities) {
            const fname = extractText(f.name) ?? extractText(f.facility_name);
            if (fname) facilities.push(fname);
          }
        }

        const rooms: any[] = [];
        if (Array.isArray(hotel.rooms)) {
          for (const room of hotel.rooms) {
            const roomFacilities: string[] = [];
            if (Array.isArray(room.facilities)) {
              for (const f of room.facilities) {
                const fname = extractText(f.name) ?? extractText(f.facility_name);
                if (fname) roomFacilities.push(fname);
              }
            }
            rooms.push({
              name: extractText(room.name) ?? "Room",
              max_occupancy: room.max_occupancy ?? null,
              facilities: roomFacilities,
            });
          }
        }

        const paymentMethods: string[] = [];
        if (Array.isArray(hotel.payment_methods)) {
          for (const p of hotel.payment_methods) {
            const pname = extractText(p.name);
            if (pname) paymentMethods.push(pname);
          }
        }

        const address = hotel.address
          ? ((hotel.address.street ?? "") + " " + (hotel.address.city ?? "") + " " + (hotel.address.country ?? "")).trim()
          : null;

        const output = {
          hotel_id: params.hotel_id,
          name: name,
          address: address || null,
          stars: hotel.class ?? hotel.star_rating ?? null,
          checkin_from: checkinFrom,
          checkout_until: checkoutTo,
          description: description ? description.slice(0, 500) : null,
          important_information: importantInfo ? importantInfo.slice(0, 500) : null,
          facilities: facilities,
          rooms: rooms,
          payment_methods: paymentMethods,
          parking: hotel.parking ?? null,
          pets_allowed: hotel.pets ?? hotel.pet_policy ?? null,
          url: hotel.url ?? null,
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
            text: "Error getting hotel details: " + (err instanceof Error ? err.message : String(err)),
          }],
          isError: true,
        };
      }
    }
  );
}