import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { searchCities } from "../services/cityResolver.js";
import { SearchCitiesInputSchema, SearchCitiesInput } from "../schemas/inputSchemas.js";

export function registerSearchCitiesTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_search_cities",
    {
      title: "Search Cities on Booking.com",
      description: "Search for cities on Booking.com by name or partial name within a given country. Works for any country worldwide. Use this to find the exact city name if booking_search_hotels reports the city was not found.\nArgs:\n  - query: city name or partial name\n  - country: two-letter lowercase country code, e.g. \"pl\", \"nl\"\n  - limit: max results (default 10)",
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