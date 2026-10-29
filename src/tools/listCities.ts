import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { searchCities } from "../services/cityResolver.js";
import { SearchCitiesInputSchema, SearchCitiesInput } from "../schemas/inputSchemas.js";

export function registerSearchCitiesTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_search_cities",
    {
      title: "Search Cities on Booking.com",
      description: "Find cities by full or partial name within ONE country (substring match, not phonetic). Use it when you are not sure a city name is spelled right or exists. If the name could belong to cities in different countries (e.g. 'Lublana' - Lublin, Poland or Ljubljana, Slovenia), ask the user for the country first unless the conversation already makes it clear. Zero results: tell the user, do not guess.\nArgs: query (city name or part of it), country (two-letter code, e.g. 'pl'), limit (default 10).",
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