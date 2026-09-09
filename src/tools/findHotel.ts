import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { resolveCityId, searchCities } from "../services/cityResolver.js";
import { normalizeText } from "../services/textNormalize.js";
import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const FindHotelInputSchema = z.object({
  hotel_name: z.string().min(2).max(200)
    .describe("Hotel name to search for, e.g. \"ibis Amsterdam Centre\", \"Marriott Warsaw\""),
  city: z.string().min(2).max(100)
    .describe('City where the hotel is located, IN ENGLISH, e.g. "Warsaw" (not "Warszawa"), "Amsterdam", "Rome" (not "Roma"). Always translate the city name to English before calling.'),
  country: z.string().min(2).max(2)
    .describe('Two-letter lowercase country code of the city, e.g. "pl", "nl". Infer it from the city name.'),
  checkin: z.string().regex(dateRegex).optional()
    .describe("Check-in date in YYYY-MM-DD format. OPTIONAL, but if the user already mentioned " +
      "dates anywhere in the conversation (for this hotel or an earlier search in the same city), " +
      "PASS THEM HERE - some hotels are seasonal or have limited availability, so searching with " +
      "the wrong (default, arbitrary ~90-days-ahead) dates can cause a false 'not found' for a hotel " +
      "that is actually available on the user's real dates. Omit only if truly no dates were " +
      "mentioned yet."),
  checkout: z.string().regex(dateRegex).optional()
    .describe("Check-out date in YYYY-MM-DD format. Must be provided together with checkin."),
  address_hint: z.string().min(2).max(200).optional()
    .describe("Optional street name, address fragment, or neighbourhood the user mentioned to help " +
      "distinguish between multiple hotels with similar names (e.g. user says 'Novotel at " +
      "Wielkopolska street'). When there are multiple name matches, this is used automatically to " +
      "narrow down to the right one - you don't need to ask the user again if you already have this " +
      "information from their message."),
});

type FindHotelInput = z.infer<typeof FindHotelInputSchema>;

interface HotelCandidate {
  hotel_id: number;
  name: string;
  booking_url: string | null;
}

interface HotelCandidateWithAddress extends HotelCandidate {
  address: string | null;
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const GENERIC_QUERY_STOPWORDS = new Set(["hotel", "hotels"]);

function tokenizeQuery(text: string): string[] {
  const tokens = tokenize(text);
  const filtered = tokens.filter((t) => !GENERIC_QUERY_STOPWORDS.has(t));
  return filtered.length > 0 ? filtered : tokens;
}

// Slowa ktore sa NAJEZYKOWO SPOKREWNIONE (dzielą ten sam lacinski rdzen)
// ale oznaczaja co innego - "central" i "centre"/"centrum"/"center" dziela
// identyczny 4-znakowy rdzen "cent", przez co stemsMatch falszywie je
// utozsamial. POTWIERDZONY BUG (landmarkResolver.ts, 2026-09-09):
// zapytanie o landmark z "Central" falszywie dopasowalo sie do miejsca
// z "Centre" w nazwie. TA SAMA funkcja stemsMatch istnieje tutaj
// (dopasowanie nazw HOTELI), z tym samym ryzykiem - fix musi byc
// zastosowany w obu miejscach jednoczesnie, bo to zduplikowany kod.
const STEM_COLLISION_DENYLIST = new Set([
  "central", "centre", "center", "centrum", "centralny", "centralna", "century",
  "station", "statistical", "static", "state",
]);

const STEM_MIN_LENGTH = 4;

function stemsMatch(a: string, b: string): boolean {
  if (a.length < STEM_MIN_LENGTH || b.length < STEM_MIN_LENGTH) return false;
  if (a !== b && (STEM_COLLISION_DENYLIST.has(a) || STEM_COLLISION_DENYLIST.has(b))) {
    return false;
  }
  const stemLen = Math.min(STEM_MIN_LENGTH, a.length, b.length);
  return a.slice(0, stemLen) === b.slice(0, stemLen);
}

function tokensMatch(hotelToken: string, searchToken: string): boolean {
  const minLen = Math.min(hotelToken.length, searchToken.length);
  if (minLen <= 3) {
    return hotelToken === searchToken;
  }
  if (hotelToken.indexOf(searchToken) !== -1 || searchToken.indexOf(hotelToken) !== -1) {
    return true;
  }
  return stemsMatch(hotelToken, searchToken);
}

function isMatch(hotelName: string, searchName: string): boolean {
  const hotelTokens = tokenize(hotelName);
  const searchTokens = tokenizeQuery(searchName);
  if (searchTokens.length === 0 || hotelTokens.length === 0) return false;

  return searchTokens.every((st) =>
    hotelTokens.some((ht) => tokensMatch(ht, st))
  );
}

function partialMatch(hotelName: string, searchName: string, cityExclusions: Set<string>): boolean {
  const hotelTokens = tokenize(hotelName);
  const rawSearchTokens = tokenizeQuery(searchName);
  const searchTokens = rawSearchTokens.filter((t) => !cityExclusions.has(t));
  const effectiveTokens = searchTokens.length > 0 ? searchTokens : rawSearchTokens;
  if (effectiveTokens.length === 0 || hotelTokens.length === 0) return false;

  return effectiveTokens.some((st) =>
    hotelTokens.some((ht) => tokensMatch(ht, st))
  );
}

// Sprawdza, czy fragment adresu podany przez usera (address_hint) pasuje
// do rzeczywistego adresu hotelu - dopasowanie tokenowe, tolerancyjne na
// odmiane (np. "Wielkopolska"/"Wielkopolskiej") dzieki stemsMatch.
function addressMatches(hotelAddress: string, addressHint: string): boolean {
  const addressTokens = tokenize(hotelAddress);
  const hintTokens = tokenizeQuery(addressHint);
  if (hintTokens.length === 0 || addressTokens.length === 0) return false;

  return hintTokens.some((ht) =>
    addressTokens.some((at) => tokensMatch(at, ht))
  );
}

// Doclaga adresy dla listy kandydatow JEDNYM zapytaniem do API (nie osobno
// na kazdego), zeby umozliwic zawezenie multiple_matches po adresie/ulicy
// podanej przez usera - bez tego address_hint nie mialby jak zadzialac,
// bo HotelCandidate z wyszukiwania nie zawiera adresu. Uzywamy lekkiego
// zapytania (bez extras: facilities/description/rooms), bo potrzebujemy
// tylko pola adresowego, nie pelnych szczegolow hotelu.
async function fetchAddressesForCandidates(
  client: BookingApiClient,
  candidates: HotelCandidate[]
): Promise<HotelCandidateWithAddress[]> {
  if (candidates.length === 0) return [];
  try {
    const raw = await client.post<any>("/accommodations/details", {
      accommodations: candidates.map((c) => c.hotel_id),
    });
    const data: any[] = raw.data ?? raw.result ?? [];
    const addressById = new Map<number, string>();
    for (const d of data) {
      if (d.id == null) continue;
      const addr = d.location?.address;
      const addressText = typeof addr === "string"
        ? addr
        : (addr && typeof addr === "object" ? (addr["en-gb"] ?? Object.values(addr)[0]) : null);
      if (typeof addressText === "string") {
        addressById.set(d.id, addressText);
      }
    }
    return candidates.map((c) => ({ ...c, address: addressById.get(c.hotel_id) ?? null }));
  } catch (err) {
    console.error("=== Blad przy pobieraniu adresow kandydatow (pomijam zawezanie po adresie): " +
      (err instanceof Error ? err.message : String(err)));
    return candidates.map((c) => ({ ...c, address: null }));
  }
}

const MAX_PAGES = 8;
const MAX_ALTERNATIVE_CITIES = 5;

export function registerFindHotelTool(server: McpServer, client: BookingApiClient): void {
  server.registerTool(
    "booking_find_hotel",
    {
      title: "Find Hotel by Name",
      description:
        "Find a hotel by name in any city worldwide to get its hotel_id, which can then be used " +
        "with booking_get_hotel_details. Args: hotel_name, city (in English), country (2-letter code). " +
        "DATES: checkin/checkout are OPTIONAL (a default ~90-days-ahead window is used if omitted), " +
        "BUT if the user has already given or mentioned dates anywhere in this conversation - for " +
        "this search or an earlier one in the same city/trip - you MUST pass them here too. Some " +
        "hotels are seasonal, close for part of the year, or have very limited availability, so " +
        "using the arbitrary default date window instead of the user's real dates can cause a false " +
        "'not found' for a hotel that genuinely exists and is available on the dates the user " +
        "actually cares about. Always carry known dates forward into every tool call in the same " +
        "conversation, not just booking_search_hotels. " +
        "ADDRESS DISAMBIGUATION: if the user mentions a street name, neighbourhood, or address " +
        "fragment along with the hotel name (e.g. 'Novotel at Wielkopolska street'), ALWAYS pass it " +
        "as address_hint - this is used automatically server-side to narrow down which hotel they " +
        "mean when there are multiple name matches, so you do NOT need to ask the user again if you " +
        "already have this information. Never silently ignore an address the user already gave you. " +
        "CITY SPELLING: if you are not 100% certain a city name is correct/exists (unusual spelling, " +
        "could be a foreign city, could be a typo), do NOT silently substitute the closest city name " +
        "you happen to know - call booking_search_cities FIRST to see real matches. If the name could " +
        "plausibly belong to more than one country (e.g. treating 'Lublana' as a typo for 'Lublin' in " +
        "Poland instead of recognizing it as 'Ljubljana' in Slovenia), ASK THE USER to confirm which " +
        "one they mean rather than picking one yourself - guessing wrong sends completely the wrong " +
        "results with no warning. " +
        "AIRPORT HOTELS - CITY MISMATCH WARNING: hotels with 'Airport' in their name are frequently " +
        "registered on Booking.com under a SEPARATE nearby town that is a DIFFERENT WORD ENTIRELY " +
        "from the city in the hotel's marketing name - not just a different spelling of it (e.g. " +
        "hotels for 'Trondheim Airport' are registered under 'Stjørdal', hotels for 'Stavanger " +
        "Airport' under 'Sola', hotels near Frankfurt sometimes under 'Seeheim-Jugenheim' rather than " +
        "the city named in the marketing name - text similarity between city names will NOT help " +
        "here, since these are unrelated words). This is a CONFIRMED, REPEATED pattern (3+ " +
        "independent cases) - if a hotel name contains 'Airport' and the search returns no_match or " +
        "partial_match, USE YOUR OWN GEOGRAPHIC KNOWLEDGE to identify the actual town/municipality " +
        "where that airport is physically located (not just the city it's named after), call " +
        "booking_search_cities to confirm the spelling exists in Booking.com's database, and retry " +
        "booking_find_hotel with that city BEFORE telling the user the hotel doesn't exist. Do not " +
        "rely only on the 'alternative_cities_note' field for this case - that field only catches " +
        "spelling variants of the SAME city name, not geographically distinct nearby towns. " +
        "IMPORTANT - response contract: the response has a 'status' field. " +
        "If status is 'no_match', tell the user the hotel was not found - but if " +
        "'alternative_cities_note' is present, try those alternative cities first, and for airport " +
        "hotels also try your own geographic knowledge as described above, before giving up. " +
        "If status is 'single_match', proceed directly using the returned hotel_id. " +
        "If status is 'multiple_matches', DO NOT GUESS or pick one automatically - you MUST end your " +
        "reply with a question asking which hotel the user means (listing each candidate's name and " +
        "booking_url so they can tell them apart), and then WAIT for their reply. Do NOT describe, " +
        "compare, summarize, or fetch details for ANY candidate in the same turn - not even 'just to " +
        "be helpful'. Only after the user explicitly picks one, call the next tool using that " +
        "specific hotel_id. Note: if you provided address_hint and it narrowed the candidates down to " +
        "one, you will get 'single_match' instead - this manual disambiguation step is only needed " +
        "when address_hint was absent or didn't uniquely resolve it. " +
        "If status is 'partial_match', these are NOT confirmed matches (e.g. only part of the name " +
        "matched) - clearly tell the user this is not a guaranteed match (the property might have " +
        "been renamed, or these might be unrelated hotels that just share a word), list the " +
        "candidates, and ask the user to confirm before proceeding - never silently treat a " +
        "partial_match candidate as if it were the hotel the user asked for.",
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

      const cityExclusions = new Set<string>([
        ...tokenize(params.city),
        ...cityResult.name_variants.flatMap((v) => tokenize(v)),
      ]);

      try {
        let checkin = params.checkin;
        let checkout = params.checkout;
        if (!checkin || !checkout) {
          const base = new Date();
          base.setDate(base.getDate() + 90);
          const co = new Date(base);
          co.setDate(co.getDate() + 2);
          checkin = checkin ?? base.toISOString().split("T")[0];
          checkout = checkout ?? co.toISOString().split("T")[0];
        }

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
        const allChecked: HotelCandidate[] = [];
        let allHotelsCount = 0;
        let nextPageToken: string | undefined = undefined;
        let pagesFetched = 0;

        do {
          const requestBody = nextPageToken
            ? { page: nextPageToken }
            : baseRequest;

          let result;
          try {
            result = await client.searchAccommodations(requestBody);
          } catch (pageErr) {
            console.error(
              "=== Blad przy pobieraniu strony paginacji (pomijam dalsze strony): " +
                (pageErr instanceof Error ? pageErr.message : String(pageErr))
            );
            break;
          }
          pagesFetched++;

          allHotelsCount += result.hotels.length;

          for (const h of result.hotels) {
            const candidate: HotelCandidate = {
              hotel_id: h.hotel_id,
              name: h.name,
              booking_url: h.url ?? null,
            };
            allChecked.push(candidate);
            if (isMatch(h.name, searchName)) {
              matched.push(candidate);
            }
          }

          nextPageToken = result.next_page;

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

        if (matched.length > 1 && params.address_hint) {
          const withAddresses = await fetchAddressesForCandidates(client, matched);
          const addressFiltered = withAddresses.filter((c) =>
            c.address != null && addressMatches(c.address, params.address_hint!)
          );

          console.error("=== DIAG booking_find_hotel: address_hint=\"" + params.address_hint +
            "\" zawezil " + matched.length + " dopasowan do " + addressFiltered.length + ": " +
            JSON.stringify(addressFiltered.map((c) => ({ name: c.name, address: c.address }))));

          if (addressFiltered.length === 1) {
            const chosen = addressFiltered[0];
            const output = {
              status: "single_match",
              hotel: { hotel_id: chosen.hotel_id, name: chosen.name, booking_url: chosen.booking_url },
              data_source: "Booking.com API",
              note: "Narrowed down from " + matched.length + " name matches using the provided address_hint.",
            };
            return {
              content: [{ type: "text", text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API" }],
              structuredContent: output,
            };
          }
        }

        if (matched.length === 0) {
          console.error("=== DIAG booking_find_hotel: brak pelnego dopasowania dla \"" + searchName +
            "\" wsrod " + allHotelsCount + " sprawdzonych hoteli (" + pagesFetched + " stron).");

          const partial = allChecked.filter((h) => partialMatch(h.name, searchName, cityExclusions));

          let alternativeCitiesNote: string | undefined;
          try {
            const alternativeCities = await searchCities(
              client, params.city, params.country, MAX_ALTERNATIVE_CITIES + 1
            );
            const otherCities = alternativeCities.filter((c) => c.city_id !== cityResult.city_id);
            if (otherCities.length > 0) {
              alternativeCitiesNote =
                "Booking.com has other similarly-named city entries that were NOT checked in this " +
                "search (each may have a completely different, non-overlapping hotel inventory): " +
                otherCities.slice(0, MAX_ALTERNATIVE_CITIES).map((c) => "\"" + c.name + "\"").join(", ") +
                ". If this is an airport hotel or the city name could be ambiguous, RETRY this tool " +
                "with one of these city names before concluding the hotel does not exist.";
            }
          } catch (altErr) {
            console.error("=== Blad przy szukaniu alternatywnych miast (pomijam): " +
              (altErr instanceof Error ? altErr.message : String(altErr)));
          }

          const usedDefaultDates = !params.checkin || !params.checkout;
          const datesNote = usedDefaultDates
            ? "This search used a DEFAULT date window (" + checkin + " to " + checkout + ") because " +
              "no dates were provided. If the user has mentioned real travel dates anywhere in this " +
              "conversation, RETRY with those exact dates (checkin/checkout params) before concluding " +
              "the hotel doesn't exist - some hotels are seasonal or have very limited availability " +
              "and may not appear in this default window even though they exist and are bookable on " +
              "the user's actual dates."
            : undefined;

          if (partial.length > 0) {
            const output: any = {
              status: "partial_match",
              message: "No hotel exactly matches \"" + params.hotel_name + "\" in " + params.city +
                ". However, found " + partial.length + " object(s) that partially match (e.g. share " +
                "a brand name or word) - this is NOT a confirmed exact match. Tell the user clearly " +
                "these are not guaranteed to be the hotel they meant (the name might have changed, " +
                "or these might be unrelated properties), list the candidates by name, and ask the " +
                "user to confirm or clarify before proceeding.",
              candidates: partial.slice(0, 10),
              data_source: "Booking.com API",
            };
            if (alternativeCitiesNote) output.alternative_cities_note = alternativeCitiesNote;
            if (datesNote) output.dates_note = datesNote;
            return {
              content: [{ type: "text", text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API" }],
              structuredContent: output,
            };
          }

          const output: any = {
            status: "no_match",
            message: "No hotel matching \"" + params.hotel_name + "\" found in " + params.city +
              " (checked " + allHotelsCount + " properties across " + pagesFetched + " page(s)).",
            data_source: "Booking.com API",
          };
          if (alternativeCitiesNote) output.alternative_cities_note = alternativeCitiesNote;
          if (datesNote) output.dates_note = datesNote;
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

        console.error("=== DIAG booking_find_hotel: " + matched.length + " dopasowan dla \"" +
          searchName + "\": " + JSON.stringify(matched.map(m => m.name)));
        const output: any = {
          status: "multiple_matches",
          message: "Found " + matched.length + " hotels matching \"" + params.hotel_name + "\" in " +
            params.city + ". Ask the user which one they mean before proceeding.",
          candidates: matched.slice(0, 10),
          data_source: "Booking.com API",
        };
        if (params.address_hint) {
          output.address_hint_note = "address_hint=\"" + params.address_hint + "\" was provided but " +
            "did not uniquely identify one hotel (either no address matched, or more than one did). " +
            "You still need to ask the user to confirm.";
        }

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