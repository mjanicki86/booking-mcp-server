import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { searchLandmarks } from "../services/landmarkResolver.js";
import { FindLandmarkInputSchema, FindLandmarkInput } from "../schemas/inputSchemas.js";

export function registerFindLandmarkTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_find_landmark",
    {
      title: "Find Landmark Coordinates",
      description:
        "Find the real coordinates (latitude/longitude) of a landmark, station, airport or point of " +
        "interest within a city, using Booking.com's own landmark database. " +
        "USE THIS whenever the user wants hotels near a specific named place or wants a distance-based " +
        "search (e.g. 'within 1km of Fontanna Neptuna', 'near the central station', 'close to the " +
        "Eiffel Tower') - do NOT invent or guess coordinates yourself. " +
        "After getting the result, pass the returned latitude/longitude (and a sensible radius_km) " +
        "into booking_search_hotels instead of a plain city search. " +
        "If status is 'no_match', tell the user the landmark could not be found by that name in that " +
        "city and ask them to clarify or try a nearby well-known landmark instead. " +
        "If status is 'multiple_matches', you MUST ask the user which one they mean and WAIT for " +
        "their reply before calling booking_search_hotels. Do NOT guess one, and do NOT search near " +
        "every candidate 'to be thorough' - checking multiple locations means multiple expensive " +
        "searches and a long, overwhelming answer instead of a quick, cheap, single one. Asking first " +
        "is always faster and cheaper than searching around several guesses. " +
        "Note: this only searches within ONE city at a time - you must know (or ask for) the city " +
        "first.",
      inputSchema: FindLandmarkInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: FindLandmarkInput) => {
      const cityResult = await resolveCityId(client, params.city, params.country);
      if (!cityResult) {
        return {
          content: [{
            type: "text",
            text: "City \"" + params.city + "\" not found in country \"" + params.country +
              "\" on Booking.com. Check the spelling and the country code, or use booking_search_cities.",
          }],
          isError: true,
        };
      }

      try {
        const matches = await searchLandmarks(client, cityResult.city_id, params.landmark_name, 10);

        if (matches.length === 0) {
          const output = {
            status: "no_match",
            message: "No landmark matching \"" + params.landmark_name + "\" found in " +
              cityResult.name + ". Ask the user to clarify the name or try another well-known landmark.",
            data_source: "Booking.com API",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        if (matches.length === 1) {
          const output = {
            status: "single_match",
            landmark: matches[0],
            city: cityResult.name,
            data_source: "Booking.com API",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        const output = {
          status: "multiple_matches",
          message: "Found " + matches.length + " landmarks matching \"" + params.landmark_name +
            "\" in " + cityResult.name + ". Ask the user which one they mean before proceeding.",
          candidates: matches,
          city: cityResult.name,
          data_source: "Booking.com API",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };

      } catch (err) {
        console.error("=== BLAD w booking_find_landmark: " +
          (err instanceof Error ? (err.stack ?? err.message) : String(err)));
        return {
          content: [{
            type: "text",
            text: "Error finding landmark: " + (err instanceof Error ? err.message : String(err)),
          }],
          isError: true,
        };
      }
    }
  );
}