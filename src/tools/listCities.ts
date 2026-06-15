import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchCities } from "../services/cityResolver.js";
import { SearchCitiesInputSchema, SearchCitiesInput } from "../schemas/inputSchemas.js";

export function registerSearchCitiesTool(server: McpServer): void {
  server.registerTool(
    "booking_search_cities",
    {
      title: "Search Cities",
      description: "Search for cities supported by this server.\nArgs:\n  - query (string): Full or partial city name, e.g. \"War\", \"Krak\"\n  - limit (number): Max results to return (default: 10)\nReturns list of matching cities with their IDs and countries.",
      inputSchema: SearchCitiesInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: SearchCitiesInput) => {
      const cities = searchCities(params.query, params.limit);

      if (cities.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No supported cities found matching \"" + params.query + "\". Currently supported: Warszawa, Krakow, Amsterdam.",
          }],
        };
      }

      const output = { cities: cities, total: cities.length };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );
}