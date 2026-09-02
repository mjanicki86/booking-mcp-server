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
});

type FindHotelInput = z.infer<typeof FindHotelInputSchema>;

interface HotelCandidate {
  hotel_id: number;
  name: string;
  booking_url: string | null;
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Generyczne słowa typu "hotel" czy "hotels" pojawiają się w zapytaniach
// użytkownika ("Warsaw Marriott Hotel"), ale rzadko w oficjalnych nazwach
// na Booking.com (np. "Courtyard by Marriott Warsaw Airport" nie zawiera
// nigdzie słowa "hotel"). Wymaganie ich jako obowiązkowego tokenu
// niepotrzebnie blokuje trafne dopasowania - usuwamy je z zapytania,
// zachowując fallback na wypadek gdyby usera zapytanie składało się
// WYŁĄCZNIE z takiego słowa (żeby nie dopasować przypadkiem wszystkiego).
const GENERIC_QUERY_STOPWORDS = new Set(["hotel", "hotels"]);

function tokenizeQuery(text: string): string[] {
  const tokens = tokenize(text);
  const filtered = tokens.filter((t) => !GENERIC_QUERY_STOPWORDS.has(t));
  return filtered.length > 0 ? filtered : tokens;
}

// Dla krótkich tokenów (do 3 znaków włącznie, np. "o" ze "P&O", "art" z
// "Art Hotel Dubrovnik") substring jest niebezpieczny - słowa te potrafią
// wystąpić jako PODCIĄG zupełnie niepowiązanego, dłuższego słowa
// (np. "art" wewnątrz "apartment" - to realny przypadek, który sprawił,
// że zapytanie o "Art Hotel Dubrovnik" fałszywie dopasowało się do
// "Dubrovnik Dream View APARTment"). Próg podniesiony z <=2 na <=3:
// dla tokenów do 3 znaków wymagamy DOKŁADNEJ równości; substring
// stosujemy tylko dla dłuższych, gdzie ryzyko przypadkowego trafienia
// wewnątrz innego słowa jest dużo mniejsze.
//
// Dodatkowo: fallback dla polskiej fleksji (odmiana przez przypadki) -
// "targi"/"targach", "hotel"/"hotelu" itp. czesto roznia sie tylko
// koncowka. Pelna lematyzacja wymagalaby slownika NLP - zamiast tego
// porownujemy "rdzen" (pierwsze min. 4 znaki), co lapie wiekszosc
// przypadkow bez nadmiernego ryzyka falszywych trafien.
const STEM_MIN_LENGTH = 4;

function stemsMatch(a: string, b: string): boolean {
  if (a.length < STEM_MIN_LENGTH || b.length < STEM_MIN_LENGTH) return false;
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

// Dopasowanie tokenowe zamiast prostego substring: każde słowo z zapytania
// musi wystąpić gdzieś w nazwie hotelu, niezależnie od kolejności i słów
// dodatkowych. Dzięki temu "Focus Premium Warszawa" znajdzie hotel
// "Focus Hotel Premium Warszawa" (słowo "Hotel" pomiędzy nie przeszkadza).
function isMatch(hotelName: string, searchName: string): boolean {
  const hotelTokens = tokenize(hotelName);
  const searchTokens = tokenizeQuery(searchName);
  if (searchTokens.length === 0 || hotelTokens.length === 0) return false;

  return searchTokens.every((st) =>
    hotelTokens.some((ht) => tokensMatch(ht, st))
  );
}

// Dopasowanie CZĘŚCIOWE: przynajmniej jeden (nie wszystkie) ZNACZĄCY token
// z zapytania pasuje do nazwy hotelu. Używane jako fallback, gdy pełne
// dopasowanie nic nie znajdzie. Tokeny odpowiadające nazwie miasta są
// pomijane jako kryterium - skoro wszystkie sprawdzane hotele i tak są
// już w tym mieście, samo "Warszawa" w nazwie hotelu to prawie żaden
// sygnał i tylko zaśmieca listę propozycji niepowiązanymi obiektami.
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

const MAX_PAGES = 8; // zabezpieczenie przed nieskończoną pętlą / nadmiarem requestów

// Ile alternatywnych miast o podobnej nazwie sugerowac przy no_match/partial_match.
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
        "specific hotel_id. " +
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

      // Nazwa miasta (we wszystkich wariantach jezykowych zwroconych przez
      // Booking.com, np. "Warsaw" i "Warszawa" naraz) jest zbyt slabym
      // sygnalem dla dopasowania czesciowego - wszystkie sprawdzane hotele
      // juz sa w tym miescie, wiec wykluczamy jej tokeny z kryteriow
      // partialMatch, niezaleznie w jakim jezyku user ja wpisal.
      const cityExclusions = new Set<string>([
        ...tokenize(params.city),
        ...cityResult.name_variants.flatMap((v) => tokenize(v)),
      ]);

      try {
        // Daty: jesli user juz podal checkin/checkout (przekazane przez
        // model z konwersacji), UZYWAMY ICH - inaczej hotel sezonowy lub
        // o ograniczonej dostepnosci moze falszywie wyjsc jako "no_match"
        // na sztywnym, arbitralnym oknie +90 dni, mimo ze realnie jest
        // dostepny na daty, o ktore userowi chodzi (potwierdzony przypadek:
        // "Villa Toscania" w Poznaniu - obecna w wynikach dla 17-19.09,
        // nieobecna w domyslnym oknie grudniowym).
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

        // Przechodzimy przez wszystkie strony wyników (next_page), dopóki:
        // - nie znajdziemy dopasowania, albo
        // - nie skończą się strony, albo
        // - nie osiągniemy limitu bezpieczeństwa MAX_PAGES
        do {
          // WAŻNE: przy paginacji trzeba wysłać WYŁĄCZNIE { page: token },
          // bez żadnych innych pól - Booking.com odrzuca zapytanie błędem
          // 400 "conflicting_parameters", jeśli 'page' występuje razem
          // z czymkolwiek innym. Token sam koduje oryginalne parametry.
          const requestBody = nextPageToken
            ? { page: nextPageToken }
            : baseRequest;

          let result;
          try {
            result = await client.searchAccommodations(requestBody);
          } catch (pageErr) {
            // Awaria pojedynczej strony (np. wygasły/niepoprawny token) nie
            // powinna wysadzać całego zapytania - traktujemy to jak koniec
            // dostępnych wyników i pracujemy z tym, co już mamy.
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

          nextPageToken = result.next_page; // undefined jeśli to ostatnia strona

          // Jeśli już mamy dopasowania, nie ma sensu ciągnąć kolejnych stron -
          // rzadko zdarza się, żeby ten sam hotel (po nazwie) występował dalej,
          // a oszczędza to czas i requesty.
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

        if (matched.length === 0) {
          console.error("=== DIAG booking_find_hotel: brak pelnego dopasowania dla \"" + searchName +
            "\" wsrod " + allHotelsCount + " sprawdzonych hoteli (" + pagesFetched + " stron).");

          // Zanim poddamy sie calkowicie, sprawdzamy dopasowanie CZESCIOWE
          // (choc jeden token pasuje) wsrod wszystkich sprawdzonych hoteli -
          // pomaga np. gdy hotel zmienil nazwe marki (jak Warsaw Marriott ->
          // Warsaw Presidential) albo user popelnil literowke w jednym slowie.
          const partial = allChecked.filter((h) => partialMatch(h.name, searchName, cityExclusions));

          // Sprawdzamy rowniez czy Booking.com ma INNE miasta o PODOBNEJ
          // (tekstowo) nazwie do podanej przez usera - pomaga przy
          // literowkach/wariantach pisowni TEJ SAMEJ nazwy (np. "Stjoerdal"
          // vs "Stjørdalshalsen"). NIE pomaga to przy hotelach lotniskowych
          // zarejestrowanych pod geograficznie odrebna miejscowoscia o
          // zupelnie innej nazwie (np. "Trondheim" vs "Stjørdal") - ten
          // przypadek jest obslugiwany przez wiedze geograficzna modelu,
          // patrz opis narzedzia (AIRPORT HOTELS - CITY MISMATCH WARNING).
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
              console.error("=== DIAG booking_find_hotel: alternatywne miasta dla \"" + params.city +
                "\": " + JSON.stringify(otherCities.map((c) => c.name)));
            }
          } catch (altErr) {
            // Blad przy szukaniu alternatywnych miast nie powinien wysadzac
            // calego zapytania - to tylko dodatkowa podpowiedz, nie krytyczna sciezka.
            console.error("=== Blad przy szukaniu alternatywnych miast (pomijam): " +
              (altErr instanceof Error ? altErr.message : String(altErr)));
          }

          // Informacja diagnostyczna: jesli user NIE podal dat, a hotel
          // moze byc sezonowy - warto to zaznaczyc, zeby model wiedzial
          // ze warto sprobowac ponownie z konkretnymi datami zamiast
          // od razu twierdzic ze hotel nie istnieje.
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
            console.error("=== DIAG booking_find_hotel: " + partial.length +
              " czesciowych dopasowan dla \"" + searchName + "\": " +
              JSON.stringify(partial.slice(0, 10).map((h) => h.name)));

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

        // Wiecej niz jedno dopasowanie - model MUSI dopytac uzytkownika (patrz opis narzedzia)
        console.error("=== DIAG booking_find_hotel: " + matched.length + " dopasowan dla \"" +
          searchName + "\": " + JSON.stringify(matched.map(m => m.name)));
        const output = {
          status: "multiple_matches",
          message: "Found " + matched.length + " hotels matching \"" + params.hotel_name + "\" in " +
            params.city + ". Ask the user which one they mean before proceeding.",
          candidates: matched.slice(0, 10),
          data_source: "Booking.com API",
        };

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