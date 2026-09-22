import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { searchLandmarks, geocodeAddress } from "../services/landmarkResolver.js";
import { FindLandmarkInputSchema, FindLandmarkInput } from "../schemas/inputSchemas.js";

// Jesli wszystkie dopasowania landmarku leza w tak malej odleglosci od siebie, to
// w praktyce jest to JEDEN punkt w bazie Booking.com zdublowany pod dwiema nazwami
// (np. "Palace of Culture and Science" 52.231827/21.006646 oraz "Palace of Culture
// Warsaw" 52.231532/21.006031 - roznica 53 metry). Pytanie usera o doprecyzowanie
// w takim przypadku jest bezuzyteczne: przy promieniu wyszukiwania liczonym w
// kilometrach oba warianty daja identyczny zestaw hoteli. Co wazniejsze, kazde
// takie pytanie to okazja dla agenta nadrzednego, zeby zamiast czekac na odpowiedz
// usera dokonczyc watek samodzielnie i zmyslic wyniki (potwierdzony przypadek z
// produkcji 2026-09-22). Dlatego takie klastry rozstrzygamy sami.
const LANDMARK_CLUSTER_DIAMETER_KM = 0.5;

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// searchLandmarks moze zwracac wspolrzedne na dwa sposoby - splaszczone
// (latitude/longitude na obiekcie) albo zagniezdzone w "coordinates", jak przychodza
// z Booking.com. Czytamy oba, a gdy nie da sie odczytac - zwracamy null i wtedy
// swiadomie NIE sklejamy klastra, tylko zostawiamy pytanie o doprecyzowanie.
function getCoords(m: any): { lat: number; lon: number } | null {
  if (!m) return null;
  const lat =
    typeof m.latitude === "number"
      ? m.latitude
      : m.coordinates && typeof m.coordinates.latitude === "number"
        ? m.coordinates.latitude
        : null;
  const lon =
    typeof m.longitude === "number"
      ? m.longitude
      : m.coordinates && typeof m.coordinates.longitude === "number"
        ? m.coordinates.longitude
        : null;
  if (lat === null || lon === null) return null;
  return { lat: lat, lon: lon };
}

function landmarkLabel(m: any): string {
  if (!m) return "?";
  if (typeof m.name === "string") return m.name;
  if (m.name && typeof m.name === "object") {
    return m.name["en-gb"] || m.name.pl || m.name.en || JSON.stringify(m.name);
  }
  return String(m.id != null ? m.id : "?");
}

// Zwraca srednice zbioru (najwieksza odleglosc miedzy dowolna para kandydatow)
// albo null, jesli ktorykolwiek kandydat nie ma czytelnych wspolrzednych.
function clusterDiameterKm(matches: any[]): number | null {
  const pts: Array<{ lat: number; lon: number }> = [];
  for (const m of matches) {
    const c = getCoords(m);
    if (!c) return null;
    pts.push(c);
  }
  let max = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = haversineKm(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon);
      if (d > max) max = d;
    }
  }
  return max;
}

export function registerFindLandmarkTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_find_landmark",
    {
      title: "Find Landmark Coordinates",
      description:
        "Find the real coordinates (latitude/longitude) of a landmark, station, airport or point of " +
        "interest within a city, using Booking.com's own landmark database (with a fallback to " +
        "general geocoding for addresses/squares not in that database). " +
        "USE THIS whenever the user wants hotels near a specific named place or wants a distance-based " +
        "search (e.g. 'within 1km of Fontanna Neptuna', 'near the central station', 'close to the " +
        "Eiffel Tower', or a plain address/square like 'plac Artura Zawiszy') - do NOT invent or guess " +
        "coordinates yourself. " +
        "REUSE ACROSS TURNS: once you have resolved a landmark to coordinates in this conversation, " +
        "REMEMBER those coordinates and reuse them directly in booking_search_hotels for follow-up " +
        "requests about the same place (e.g. changing radius, price, breakfast, or removing a filter) " +
        "- do NOT call this tool again for the same landmark and force the user to re-disambiguate " +
        "something they already clarified earlier in the conversation. Only call this tool again if " +
        "the user names a genuinely different place. " +
        "After getting the result, pass the returned latitude/longitude (and a sensible radius_km) " +
        "into booking_search_hotels instead of a plain city search. " +
        "If status is 'no_match', tell the user the landmark could not be found by that name in that " +
        "city (even via general geocoding) and ask them to clarify or try a nearby well-known landmark " +
        "instead. " +
        "If status is 'single_match' but 'collapsed_duplicates' is present, the tool found several " +
        "near-identical entries for the same physical place and already picked one for you - just " +
        "continue with the returned coordinates and do NOT ask the user to choose. " +
        "If status is 'multiple_matches', you MUST ask the user which one they mean and WAIT for " +
        "their reply before calling booking_search_hotels. Do NOT guess one, and do NOT search near " +
        "every candidate 'to be thorough' - checking multiple locations means multiple expensive " +
        "searches and a long, overwhelming answer instead of a quick, cheap, single one. Asking first " +
        "is always faster and cheaper than searching around several guesses. ASKING MEANS ENDING YOUR " +
        "TURN: after you ask the disambiguation question, stop and wait for the user's actual answer. " +
        "Never answer your own question, never pick a candidate on the user's behalf, and never " +
        "produce hotel names, prices, guest ratings, distances or booking links that did not come " +
        "from a booking_search_hotels response - inventing them is a serious failure. " +
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
        const matches = await searchLandmarks(
          client,
          cityResult.city_id,
          params.landmark_name,
          10,
          cityResult.name,
          cityResult.name_variants
        );

        if (matches.length === 0) {
          const geocoded = await geocodeAddress(params.landmark_name, cityResult.name);
          if (geocoded) {
            console.error("=== DIAG findLandmark: brak dopasowan w Booking.com dla \"" +
              params.landmark_name + "\" - uzyto geokodowania zewnetrznego.");
            const output = {
              status: "single_match",
              landmark: geocoded,
              city: cityResult.name,
              data_source: "External geocoding (OpenStreetMap Nominatim) - not in Booking.com's own landmark list",
              note: "This place is not one of Booking.com's curated landmarks, so coordinates come " +
                "from external geocoding instead - tell the user this location was resolved via " +
                "general geocoding, slightly less precise than a Booking.com-listed point of interest.",
            };
            return {
              content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          }

          console.error("=== DIAG findLandmark: brak dopasowan dla \"" + params.landmark_name +
            "\" w " + cityResult.name + " (takze przez geokodowanie).");
          const output = {
            status: "no_match",
            message: "No landmark matching \"" + params.landmark_name + "\" found in " +
              cityResult.name + " (checked both Booking.com's landmark database and general " +
              "geocoding). Ask the user to clarify the name or try another well-known landmark.",
            data_source: "Booking.com API",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        if (matches.length === 1) {
          console.error("=== DIAG findLandmark: 1 dopasowanie dla \"" + params.landmark_name +
            "\" -> " + landmarkLabel(matches[0]));
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

        // Kilka dopasowan, ale moga opisywac ten sam fizyczny punkt pod roznymi nazwami.
        const diameterKm = clusterDiameterKm(matches);

        if (diameterKm !== null && diameterKm <= LANDMARK_CLUSTER_DIAMETER_KM) {
          const meters = Math.round(diameterKm * 1000);
          console.error("=== DIAG findLandmark: " + matches.length + " dopasowan dla \"" +
            params.landmark_name + "\" w promieniu " + meters +
            " m - traktuje jako JEDEN punkt, NIE pytam o doprecyzowanie. Wybrano: " +
            landmarkLabel(matches[0]) + ". Odrzucone duplikaty: " +
            JSON.stringify(matches.slice(1).map(landmarkLabel)));

          const output = {
            status: "single_match",
            landmark: matches[0],
            city: cityResult.name,
            collapsed_duplicates: {
              count: matches.length,
              max_distance_between_candidates_m: meters,
              other_names: matches.slice(1).map(landmarkLabel),
              explanation: "Booking.com lists this physical place under several near-identical " +
                "names. All candidates are within " + meters + " m of each other, which is the " +
                "same point for any kilometre-scale radius search, so one was selected " +
                "automatically. Do NOT ask the user to disambiguate - just proceed with these " +
                "coordinates.",
            },
            data_source: "Booking.com API",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        console.error("=== DIAG findLandmark: " + matches.length + " dopasowan dla \"" +
          params.landmark_name + "\", srednica zbioru " +
          (diameterKm === null ? "nieznana (brak wspolrzednych)" : Math.round(diameterKm * 1000) + " m") +
          " - pytam usera o doprecyzowanie: " + JSON.stringify(matches.map(landmarkLabel)));

        const output = {
          status: "multiple_matches",
          message: "Found " + matches.length + " landmarks matching \"" + params.landmark_name +
            "\" in " + cityResult.name + ". Ask the user which one they mean, then STOP and wait " +
            "for their reply - do not pick one yourself and do not produce any hotel results " +
            "until they answer.",
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