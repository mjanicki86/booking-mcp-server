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

interface HotelCandidate {
  hotel_id: number;
  name: string;
  booking_url: string | null;
}

// Usuwa znaki diakrytyczne, żeby "Lodz" pasowało do "Łódź" itp.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokenize(text: string): string[] {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Dopasowanie tokenowe zamiast prostego substring: każde słowo z zapytania
// musi wystąpić gdzieś w nazwie hotelu, niezależnie od kolejności i słów
// dodatkowych. Dzięki temu "Focus Premium Warszawa" znajdzie hotel
// "Focus Hotel Premium Warszawa" (słowo "Hotel" pomiędzy nie przeszkadza).
function isMatch(hotelName: string, searchName: string): boolean {
  const hotelTokens = tokenize(hotelName);
  const searchTokens = tokenize(searchName);
  if (searchTokens.length === 0 || hotelTokens.length === 0) return false;

  return searchTokens.every((st) =>
    hotelTokens.some((ht) => ht.indexOf(st) !== -1 || st.indexOf(ht) !== -1)
  );
}

const MAX_PAGES = 8; // zabezpieczenie przed nieskończoną pętlą / nadmiarem requestów

export function registerFindHotelTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_find_hotel",
    {
      title: "Find Hotel by Name",
      description:
        "Find a hotel by name in any city worldwide to get its hotel_id, which can then be used " +
        "with booking_get_hotel_details. Use this when the user asks about a specific hotel by name " +
        "but has not provided dates. Does NOT require dates. Args: hotel_name, city (in English), " +
        "country (2-letter code). " +
        "IMPORTANT - response contract: the response has a 'status' field. " +
        "If status is 'no_match', tell the user the hotel was not found. " +
        "If status is 'single_match', proceed directly using the returned hotel_id. " +
        "If status is 'multiple_matches', DO NOT GUESS or pick one automatically - you MUST ask the " +
        "user to clarify which hotel they mean, listing each candidate's name and booking_url so " +
        "they can tell them apart. Only after the user picks one, call the next tool using that " +
        "specific hotel_id.",
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

        const baseRequest = {
          booker: { country: "nl", platform: "desktop" },
          checkin: checkin,
          checkout: checkout,
          city: cityResult.city_id,
          guests: { number_of_adults: 1, number_of_rooms: 1 },
          currency: "PLN",
          rows: 100,
        };

        const searchName = params.hotel_name;
        const matched: HotelCandidate[] = [];
        let allHotelsCount = 0;
        let nextPageToken: string | undefined = undefined;
        let pagesFetched = 0;

        // Przechodzimy przez wszystkie strony wyników (next_page), dopóki:
        // - nie znajdziemy dopasowania, albo
        // - nie skończą się strony, albo
        // - nie osiągniemy limitu bezpieczeństwa MAX_PAGES
        do {
          // WAŻNE: przy paginacji trzeba wysłać WYŁĄCZNIE { page: token },
          // bez żadnych innych pól - Booking.com odrzuca zapytanie błędem
          // 400 "conflicting_parameters", jeśli 'page' występuje razem
          // z czymkolwiek innym. Token sam koduje oryginalne parametry.
          const requestBody = nextPageToken
            ? { page: nextPageToken }
            : baseRequest;

          let result;
          try {
            result = await client.searchAccommodations(requestBody);
          } catch (pageErr) {
            // Awaria pojedynczej strony (np. wygasły/niepoprawny token) nie
            // powinna wysadzać całego zapytania - traktujemy to jak koniec
            // dostępnych wyników i pracujemy z tym, co już mamy.
            console.error(
              "=== Blad przy pobieraniu strony paginacji (pomijam dalsze strony): " +
                (pageErr instanceof Error ? pageErr.message : String(pageErr))
            );
            break;
          }
          pagesFetched++;

          allHotelsCount += result.hotels.length;

          for (const h of result.hotels) {
            if (isMatch(h.name, searchName)) {
              matched.push({
                hotel_id: h.hotel_id,
                name: h.name,
                booking_url: h.url ?? null,
              });
            }
          }

          nextPageToken = result.next_page; // undefined jeśli to ostatnia strona

          // Jeśli już mamy dopasowania, nie ma sensu ciągnąć kolejnych stron -
          // rzadko zdarza się, żeby ten sam hotel (po nazwie) występował dalej,
          // a oszczędza to czas i requesty.
          if (matched.length > 0) {
            break;
          }
        } while (nextPageToken && pagesFetched < MAX_PAGES);

        if (allHotelsCount === 0) {
          return {
            content: [{
              type: "text",
              text: "No hotels found in " + params.city + ".",
            }],
          };
        }

        if (matched.length === 0) {
          console.error("=== DIAG booking_find_hotel: brak dopasowania dla \"" + searchName +
            "\" wsrod " + allHotelsCount + " sprawdzonych hoteli (" + pagesFetched + " stron).");
          const output = {
            status: "no_match",
            message: "No hotel matching \"" + params.hotel_name + "\" found in " + params.city +
              " (checked " + allHotelsCount + " properties across " + pagesFetched + " page(s)).",
            data_source: "Booking.com API",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API" }],
            structuredContent: output,
          };
        }

        if (matched.length === 1) {
          console.error("=== DIAG booking_find_hotel: jedno dopasowanie dla \"" + searchName +
            "\": " + JSON.stringify(matched[0]));
          const output = {
            status: "single_match",
            hotel: matched[0],
            data_source: "Booking.com API",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API" }],
            structuredContent: output,
          };
        }

        // Wiecej niz jedno dopasowanie - model MUSI dopytac uzytkownika (patrz opis narzedzia)
        console.error("=== DIAG booking_find_hotel: " + matched.length + " dopasowan dla \"" +
          searchName + "\": " + JSON.stringify(matched.map(m => m.name)));
        const output = {
          status: "multiple_matches",
          message: "Found " + matched.length + " hotels matching \"" + params.hotel_name + "\" in " +
            params.city + ". Ask the user which one they mean before proceeding.",
          candidates: matched.slice(0, 10),
          data_source: "Booking.com API",
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API" }],
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