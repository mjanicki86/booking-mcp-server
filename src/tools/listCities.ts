import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { searchCities } from "../services/cityResolver.js";
import { SearchCitiesInputSchema, SearchCitiesInput } from "../schemas/inputSchemas.js";

export function registerSearchCitiesTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_search_cities",
    {
      title: "Search Cities on Booking.com",
      description: "Search for cities on Booking.com by name or partial name within a given country. " +
        "Works for any country worldwide. Use this PROACTIVELY whenever you are not 100% certain a " +
        "city name is correct or exists - unusual spelling, possible typo, or a name that could " +
        "belong to more than one country - not just after booking_search_hotels already failed.\n" +
        "LIMITATION: this searches WITHIN ONE country only. If you are unsure which country the " +
        "city is in (e.g. a name that could be a misspelling of cities in different countries, " +
        "like 'Lublana' which could be meant as 'Lublin' in Poland OR 'Ljubljana' in Slovenia), " +
        "ASK THE USER to confirm the country before searching. Do not guess a country and search " +
        "silently, and do not just state your assumption and proceed anyway - stop and ask, unless " +
        "the user's own message already makes the country unambiguous (e.g. they mentioned Poland " +
        "elsewhere in the conversation).\n" +
        "Matching is substring-based on the normalized name, not phonetic - a very different " +
        "spelling (e.g. 'Lublana' vs 'Ljubljana') may return zero results even in the right country. " +
        "If you get zero results, tell the user plainly rather than falling back to a guess.\n" +
        "Args:\n  - query: city name or partial name\n  - country: two-letter lowercase country code, e.g. \"pl\", \"nl\"\n  - limit: max results (default 10)",
      inputSchema: SearchCitiesInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchCitiesInput) => {
      try {
        const cities = await searchCities(client, params.query, params.country, params.limit);
        if (cities.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No cities found matching \"" + params.query + "\" in country \"" + params.country + "\". Check the spelling and the country code.",
            }],
          };
        }
        const output = { cities: cities, total: cities.length };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: "Error searching cities: " + (err instanceof Error ? err.message : String(err)),
          }],
          isError: true,
        };
      }
    }
  );
}