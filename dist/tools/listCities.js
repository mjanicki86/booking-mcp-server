"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSearchCitiesTool = registerSearchCitiesTool;
const cityResolver_js_1 = require("../services/cityResolver.js");
const inputSchemas_js_1 = require("../schemas/inputSchemas.js");
function registerSearchCitiesTool(server, apiKey) {
    server.registerTool("booking_search_cities", {
        title: "Search Cities",
        description: `Search for cities on Booking.com by name. Works worldwide in any language.

Use this when:
- You want to verify a city exists before searching for hotels
- A hotel search returned a "city not found" error
- The user types an ambiguous city name

Args:
  - query (string): Full or partial city name, e.g. "War", "Tokyo", "New York"
  - limit (number): Max results to return (default: 10)

Returns list of matching cities with their IDs and countries.`,
        inputSchema: inputSchemas_js_1.SearchCitiesInputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        try {
            const cities = await (0, cityResolver_js_1.searchCities)(params.query, apiKey, params.limit);
            if (cities.length === 0) {
                return {
                    content: [{
                            type: "text",
                            text: `No cities found matching "${params.query}". Try a different spelling or a larger nearby city.`,
                        }],
                };
            }
            const output = { cities, total: cities.length };
            return {
                content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
                structuredContent: output,
            };
        }
        catch (err) {
            return {
                content: [{
                        type: "text",
                        text: `Error searching cities: ${err instanceof Error ? err.message : String(err)}`,
                    }],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=listCities.js.map