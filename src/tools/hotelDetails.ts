import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";

const HotelDetailsInputSchema = z.object({
  hotel_id: z.number().int()
    .describe("Hotel ID from booking_search_hotels or booking_find_hotel results"),
});

type HotelDetailsInput = z.infer<typeof HotelDetailsInputSchema>;

// Slownik udogodnien Booking.com: numer ID -> polska nazwa.
// API 3.1 zwraca same numery, wiec tlumaczymy je tutaj.
const FACILITY_NAMES: Record<number, string> = {
  2: "parking",
  3: "restauracja",
  4: "zwierzeta akceptowane",
  5: "room service",
  6: "sale konferencyjne",
  7: "bar",
  8: "recepcja 24h",
  10: "sauna",
  11: "silownia / fitness",
  14: "ogrod",
  15: "taras",
  16: "pokoje dla niepalacych",
  17: "transfer lotniskowy",
  20: "centrum biznesowe",
  21: "opieka nad dziecmi",
  22: "pralnia",
  23: "pranie chemiczne",
  25: "udogodnienia dla niepelnosprawnych",
  28: "pokoje rodzinne",
  47: "sejf",
  48: "winda",
  51: "kantor wymiany walut",
  54: "spa i centrum wellness",
  55: "masaze",
  56: "plac zabaw dla dzieci",
  63: "jacuzzi",
  64: "pokoje dzwiekoszczelne",
  72: "miejsce na grilla",
  73: "suchy prowiant",
  75: "wypozyczalnia samochodow",
  76: "wypozyczalnia rowerow",
  80: "ogrzewanie",
  91: "przechowalnia bagazu",
  103: "basen kryty",
  104: "basen odkryty",
  107: "darmowe WiFi",
  108: "obiekt calkowicie dla niepalacych",
  109: "klimatyzacja",
  110: "wyznaczone miejsce dla palacych",
  124: "concierge",
  158: "codzienne sprzatanie",
};

// Tlumaczenie atrybutow udogodnien
const ATTRIBUTE_NAMES: Record<string, string> = {
  paid: "platne",
  free: "bezplatne",
  private: "prywatne",
  on_site: "na miejscu",
  reservation_needed: "wymagana rezerwacja",
};

function extractText(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    return field["en-gb"] ?? field["pl"] ?? field["en"] ?? Object.values(field)[0] as string ?? null;
  }
  return null;
}

// Zamienia wpis udogodnienia (numer + atrybuty) na czytelny tekst,
// np. {id: 2, attributes: ["paid"]} -> "parking (platne)"
function facilityToText(f: any): string | null {
  // Najpierw sprobuj nazwy wprost z API (niektore wersje ja zwracaja)
  const directName = extractText(f.name) ?? extractText(f.facility_name);
  const baseName = directName ?? FACILITY_NAMES[f.id] ?? null;
  if (!baseName) {
    // Nieznany numer - pokaz go, zeby dalo sie latwo uzupelnic slownik
    return f.id != null ? "udogodnienie #" + f.id : null;
  }

  const attrs: string[] = [];
  if (Array.isArray(f.attributes)) {
    for (const a of f.attributes) {
      if (typeof a === "string") {
        attrs.push(ATTRIBUTE_NAMES[a] ?? a);
      }
    }
  }

  return attrs.length > 0 ? baseName + " (" + attrs.join(", ") + ")" : baseName;
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
      description: "Get detailed information about a specific hotel including facilities (parking, pool, gym, WiFi, restaurant, air conditioning, spa), room types, check-in/out policies, payment options, and important information such as parking fees and pet policies. Use this tool whenever the user asks about a hotel's amenities, facilities, parking, prices of extras, or policies. Requires hotel_id from booking_search_hotels or booking_find_hotel results. Args: hotel_id (number): Hotel ID from search results.",
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
            const ftext = facilityToText(f);
            if (ftext) facilities.push(ftext);
          }
        }

        const rooms: any[] = [];
        if (Array.isArray(hotel.rooms)) {
          for (const room of hotel.rooms) {
            const roomFacilities: string[] = [];
            if (Array.isArray(room.facilities)) {
              for (const f of room.facilities) {
                const ftext = facilityToText(f);
                if (ftext) roomFacilities.push(ftext);
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
          description: description ? description.slice(0, 1500) : null,
          // Wazne informacje zawieraja m.in. ceny parkingu i zasady dot. zwierzat
          // - nie ucinamy ich, zeby agent mogl odpowiadac na pytania o oplaty
          important_information: importantInfo ?? null,
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