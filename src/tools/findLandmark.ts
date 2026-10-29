import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { searchLandmarks, geocodeAddress } from "../services/landmarkResolver.js";
import { FindLandmarkInputSchema, FindLandmarkInput } from "../schemas/inputSchemas.js";
import { RequestContext } from "../services/requestContext.js";
import { normalizeText } from "../services/textNormalize.js";

// === PETLA WYWOLAN (test 2026-10-29, 11:50-11:54) ===
// W jednej turze (ten sam naglowek conversation-id) model wywolal
// booking_find_landmark("Wawel") ponad 120 razy co ~1,7 s, nie przechodzac do
// booking_search_hotels - kazda odpowiedz byla poprawna (HTTP 200, 1 dopasowanie).
// Prawdopodobna przyczyna: zdanie z opisu "wywolaj ponownie w kazdej turze"
// model zastosowal do kazdego kroku wlasnej petli. Obrona po stronie serwera:
// licznik powtorzen tego samego miejsca w tej samej turze; od 2. powtorzenia
// odpowiedz mowi wprost, ze wspolrzedne juz sa i trzeba wywolac wyszukiwanie,
// od REPEAT_HARD_STOP zwracamy blad (z tymi samymi wspolrzednymi), zeby przerwac petle.
const REPEAT_WINDOW_MS = 5 * 60 * 1000;
const REPEAT_WARN_FROM = 2;
const REPEAT_HARD_STOP = 4;
const repeatCounter = new Map<string, { count: number; lastAt: number }>();

function countRepeat(ctx: RequestContext, params: FindLandmarkInput): number {
  if (!ctx.turnId) return 1;
  const now = Date.now();
  for (const [k, v] of repeatCounter) {
    if (now - v.lastAt > REPEAT_WINDOW_MS) repeatCounter.delete(k);
  }
  const key = ctx.turnId + "|" + normalizeText(params.country) + "|" + normalizeText(params.city) + "|" +
    normalizeText(params.landmark_name);
  const e = repeatCounter.get(key);
  const count = e && now - e.lastAt <= REPEAT_WINDOW_MS ? e.count + 1 : 1;
  repeatCounter.set(key, { count, lastAt: now });
  return count;
}

function applyRepeatGuard(count: number, params: FindLandmarkInput, result: any): any {
  if (count < REPEAT_WARN_FROM || result?.isError) return result;
  const out = result?.structuredContent;
  const lm = out?.landmark;
  const lat = lm?.latitude ?? lm?.coordinates?.latitude;
  const lon = lm?.longitude ?? lm?.coordinates?.longitude;
  const coordsText = typeof lat === "number" && typeof lon === "number"
    ? "latitude " + lat + ", longitude " + lon : "the coordinates returned in your first call";
  console.error("=== DIAG findLandmark: " + count + ". wywolanie dla \"" + params.landmark_name +
    "\" w tej samej turze" + (count >= REPEAT_HARD_STOP ? " - zwracam blad, zeby przerwac petle." : " - ostrzegam model."));
  const instruction = "You have ALREADY resolved \"" + params.landmark_name + "\" in this turn (" + count +
    " calls). Do NOT call booking_find_landmark again for it. Call booking_search_hotels NOW with " + coordsText +
    (out?.status === "multiple_matches" ? ", or ask the user which place they mean and stop." : ".");
  if (count >= REPEAT_HARD_STOP) {
    return { content: [{ type: "text", text: "STOP: " + instruction }], isError: true };
  }
  if (out && typeof out === "object") {
    const patched = { repeated_call_warning: instruction, ...out };
    return { content: [{ type: "text", text: JSON.stringify(patched, null, 2) }], structuredContent: patched };
  }
  return result;
}

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

export function registerFindLandmarkTool(server: McpServer, client: BookingApiClient, ctx: RequestContext): void {
  server.registerTool(
    "booking_find_landmark",
    {
      title: "Find Landmark Coordinates",
      description: "Coordinates of a named place in a city (landmark, station, airport, square or street address) from Booking.com's landmark list, with a fallback to general geocoding. Use it whenever the user wants hotels near a place, then pass latitude/longitude to booking_search_hotels. You need the city (in English) - ask if it is unknown.\nCall it ONCE per place per user message - never again for the same place in the same reply. In a later message call it again (results of earlier messages are not visible to you); if the user picked one of several candidates earlier, use the full name of that candidate. Do not choose a radius here - see booking_search_hotels.\nstatus 'single_match': use the coordinates (also when collapsed_duplicates is present - do not ask the user). 'multiple_matches': ask the user which place they mean and STOP - do not search near several candidates and do not list hotels before they answer. 'no_match': say the place was not found and ask for another name. When data_source is external geocoding, mention that the location is approximate.",
      inputSchema: FindLandmarkInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: FindLandmarkInput) => applyRepeatGuard(countRepeat(ctx, params), params, await (async () => {
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
    })()),
  );
}
