import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchCities } from "../services/cityResolver.js";
import { SearchCitiesInputSchema, SearchCitiesInput } from "../schemas/inputSchemas.js";

export function registerSearchCitiesTool(server: McpServer, apiKey: string, affiliateId: string): void {
  server.registerTool(
    "booking_search_cities",
    {
      title: "Search Cities",
      description: "Search for cities on Booking.com by name. Works worldwide in any language.\nUse this when a hotel search returns \"city not found\" error.\nArgs:\n  - query (string): Full or partial city name, e.g. \"War\", \"Tokyo\", \"New York\"\n  - limit (number): Max results to return (default: 10)\nReturns list of matching cities with their IDs and countries.",
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
        const cities = await searchCities(params.query, apiKey, affiliateId, params.limit);

        if (cities.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No cities found matching \"" + params.query + "\". Try a different spelling or a larger nearby city.",
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