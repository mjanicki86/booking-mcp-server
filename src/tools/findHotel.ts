import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient } from "../services/bookingClient.js";
import { resolveCityId, searchCities, cityNotFoundMessage } from "../services/cityResolver.js";
import { normalizeText } from "../services/textNormalize.js";
import { RequestContext } from "../services/requestContext.js";
import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const FindHotelInputSchema = z.object({
  hotel_name: z.string().min(2).max(200)
    .describe("Hotel name to search for, e.g. \"ibis Amsterdam Centre\", \"Arche Hotel Geologiczna\". " +
      "Pass the name exactly as the user wrote it (Polish names are fine - Polish property names are " +
      "matched too)."),
  city: z.string().min(2).max(100)
    .describe('City where the hotel is located, IN ENGLISH, e.g. "Warsaw" (not "Warszawa"), "Amsterdam", "Rome" (not "Roma"). Always translate the city name to English before calling.'),
  country: z.string().min(2).max(2)
    .describe('Two-letter lowercase country code of the city, e.g. "pl", "nl". Infer it from the city name.'),
  checkin: z.string().regex(dateRegex).optional()
    .describe("OPTIONAL and NOT required. Hotel lookup by name no longer depends on dates or availability. " +
      "Accepted only for backward compatibility; dates matter only for booking_search_hotels."),
  checkout: z.string().regex(dateRegex).optional()
    .describe("OPTIONAL and NOT required - see checkin."),
  address_hint: z.string().min(2).max(200).optional()
    .describe("Optional street name, address fragment, or neighbourhood the user mentioned (e.g. " +
      "'ul. Geologiczna 4', 'Hurtowa'). Used server-side to pick the right hotel when several names " +
      "match, and to rank partial matches. ALWAYS pass it when the user gave an address."),
});

type FindHotelInput = z.infer<typeof FindHotelInputSchema>;

interface InventoryEntry {
  hotel_id: number;
  name: string;          // nazwa do pokazania (en-gb, a jesli brak - pierwsza dostepna)
  names: string[];       // wszystkie warianty jezykowe nazwy (en-gb, pl, ...)
  address: string | null;
  booking_url: string | null;
  accommodation_type?: number | null;
}

interface HotelCandidate {
  hotel_id: number;
  name: string;
  address: string | null;
  booking_url: string | null;
  address_matches_hint?: boolean;
}

// ---------------------------------------------------------------------------
// INWENTARZ MIASTA (statyczny, NIEZALEZNY od dostepnosci)
//
// POPRZEDNIA WERSJA szukala hotelu po nazwie przez /accommodations/search,
// czyli wsrod obiektow DOSTEPNYCH dla 1 osoby w domyslnym terminie. Dla
// Warszawy zwracalo to ok. 300 obiektow z kilku tysiecy - stad zgloszenia
// Damiana (2026-10-16): "Arche Hotel Geologiczna", "Arche Hotel Krakowska",
// "Zamek w Baranowie Sandomierskim" -> "nie znaleziono", choc wszystkie sa
// na Booking.com. Hotel wyprzedany / zamkniety w danym terminie albo po
// prostu spoza "top ~300" byl dla nas niewidoczny.
//
// TERAZ: /accommodations/details z filtrem `city` zwraca CALY statyczny
// inwentarz miasta (bez cen i dostepnosci). Pobieramy nazwy w en-gb i pl
// (polskie nazwy typu "Zamek w Baranowie..." czesto roznia sie od
// angielskich) oraz adresy (address_hint dziala bez dodatkowego zapytania).
//
// Cache: tylko KOMPLETNY inwentarz (paginacja doszla do konca), kluczem
// jest city_id. Nigdy nie cache'ujemy wyniku czesciowego - lekcja z bledu
// "incidental cache poisoning" w cityResolver.
// ---------------------------------------------------------------------------

const INVENTORY_TTL_MS = 12 * 60 * 60 * 1000;
const INVENTORY_ROWS = 1000;
const INVENTORY_ROWS_FALLBACK = 100;
const INVENTORY_MAX_PAGES = 40;
const INVENTORY_LANGUAGES = ["en-gb", "pl"];

const inventoryCache = new Map<number, { fetchedAt: number; entries: InventoryEntry[] }>();
const inventoryInFlight = new Map<number, Promise<InventoryEntry[]>>();

function pickText(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    const v = field["en-gb"] ?? field["pl"] ?? Object.values(field)[0];
    return typeof v === "string" ? v : null;
  }
  return null;
}

function allTexts(field: any): string[] {
  if (!field) return [];
  if (typeof field === "string") return [field];
  if (typeof field === "object") {
    return Array.from(new Set(Object.values(field).filter((v): v is string => typeof v === "string")));
  }
  return [];
}

function toInventoryEntry(d: any): InventoryEntry | null {
  if (d?.id == null) return null;
  const names = allTexts(d.name);
  if (names.length === 0) return null;
  const addr = d.location?.address;
  const address = pickText(addr);
  const city = pickText(d.location?.city);
  return {
    hotel_id: d.id,
    name: pickText(d.name) ?? names[0],
    names,
    address: address ? (city ? address + ", " + city : address) : null,
    booking_url: typeof d.url === "string" ? d.url : null,
    accommodation_type: typeof d.accommodation_type === "number" ? d.accommodation_type : null,
  };
}

async function fetchInventoryPages(
  client: BookingApiClient,
  cityId: number,
  rows: number
): Promise<{ entries: InventoryEntry[]; complete: boolean; pages: number }> {
  const entries: InventoryEntry[] = [];
  let nextPage: string | undefined = undefined;
  let pages = 0;

  do {
    const body: any = nextPage
      ? { page: nextPage }
      : { city: cityId, languages: INVENTORY_LANGUAGES, rows };
    let raw: any;
    try {
      raw = await client.post<any>("/accommodations/details", body);
    } catch (err) {
      // Pierwsza strona - rzucamy dalej (wywolujacy sprobuje mniejszego rows).
      if (pages === 0) throw err;
      console.error("=== find_hotel inventory: blad na stronie " + (pages + 1) +
        " (wynik NIEKOMPLETNY, nie cache'uje): " + (err instanceof Error ? err.message : String(err)));
      return { entries, complete: false, pages };
    }
    pages++;
    const data: any[] = raw.data ?? raw.result ?? [];
    for (const d of data) {
      const e = toInventoryEntry(d);
      if (e) entries.push(e);
    }
    nextPage = raw.next_page ?? raw.metadata?.next_page ?? undefined;
  } while (nextPage && pages < INVENTORY_MAX_PAGES);

  return { entries, complete: !nextPage, pages };
}

async function loadCityInventory(client: BookingApiClient, cityId: number): Promise<InventoryEntry[]> {
  const cached = inventoryCache.get(cityId);
  if (cached && Date.now() - cached.fetchedAt < INVENTORY_TTL_MS) {
    console.error("=== find_hotel inventory z cache: city=" + cityId + ", " + cached.entries.length + " obiektow");
    return cached.entries;
  }
  const pending = inventoryInFlight.get(cityId);
  if (pending) return pending;

  const p = (async () => {
    const started = Date.now();
    let result;
    try {
      result = await fetchInventoryPages(client, cityId, INVENTORY_ROWS);
    } catch (err) {
      console.error("=== find_hotel inventory: rows=" + INVENTORY_ROWS + " odrzucone (" +
        (err instanceof Error ? err.message : String(err)) + "), ponawiam z rows=" + INVENTORY_ROWS_FALLBACK);
      result = await fetchInventoryPages(client, cityId, INVENTORY_ROWS_FALLBACK);
    }
    console.error("=== find_hotel inventory: city=" + cityId + ", " + result.entries.length +
      " obiektow, " + result.pages + " stron, kompletny=" + result.complete + ", " + (Date.now() - started) + " ms");
    if (result.complete && result.entries.length > 0) {
      inventoryCache.set(cityId, { fetchedAt: Date.now(), entries: result.entries });
    }
    return result.entries;
  })();

  inventoryInFlight.set(cityId, p);
  try {
    return await p;
  } finally {
    inventoryInFlight.delete(cityId);
  }
}

// Wstepne zaladowanie miasta (cache miasta w cityResolver + inwentarz hoteli)
// - wolane przy starcie serwera dla najczesciej uzywanych miast, zeby
// pierwszy konsultant po deployu/restarcie nie czekal kilku sekund.
export async function prewarmCity(client: BookingApiClient, city: string, country: string): Promise<void> {
  const started = Date.now();
  try {
    const cityResult = await resolveCityId(client, city, country);
    if (!cityResult) {
      console.error("=== PREWARM: nie znaleziono miasta " + city + " (" + country + ")");
      return;
    }
    const entries = await loadCityInventory(client, cityResult.city_id);
    console.error("=== PREWARM: " + city + " gotowe (" + entries.length + " obiektow, " +
      (Date.now() - started) + " ms)");
  } catch (err) {
    console.error("=== PREWARM: blad dla " + city + " (pomijam): " +
      (err instanceof Error ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------------------
// DOPASOWANIE NAZW (bez zmian w logice tokenow - patrz historia stemsMatch)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return normalizeText(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Slowa, ktore nie identyfikuja obiektu: "hotel" oraz krotkie przyimki
// (PL/EN/DE) - "Zamek W Baranowie" nie moze odpasc przez samo "w".
const GENERIC_QUERY_STOPWORDS = new Set([
  "hotel", "hotels", "hotelu", "obiekt", "obiektu",
  "w", "we", "na", "przy", "pod", "i", "in", "at", "the", "of", "and", "im", "am", "an",
]);

function tokenizeQuery(text: string): string[] {
  const tokens = tokenize(text);
  const filtered = tokens.filter((t) => !GENERIC_QUERY_STOPWORDS.has(t));
  return filtered.length > 0 ? filtered : tokens;
}

// "central" i "centre"/"centrum" dziela rdzen "cent" - patrz bug z 2026-09-09.
// Ta sama lista jest w landmarkResolver.ts - zmieniac w obu miejscach.
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
  return searchTokens.every((st) => hotelTokens.some((ht) => tokensMatch(ht, st)));
}

function partialMatch(hotelName: string, searchName: string, cityExclusions: Set<string>): boolean {
  const hotelTokens = tokenize(hotelName);
  const rawSearchTokens = tokenizeQuery(searchName);
  const searchTokens = rawSearchTokens.filter((t) => !cityExclusions.has(t));
  const effectiveTokens = searchTokens.length > 0 ? searchTokens : rawSearchTokens;
  if (effectiveTokens.length === 0 || hotelTokens.length === 0) return false;
  return effectiveTokens.some((st) => hotelTokens.some((ht) => tokensMatch(ht, st)));
}

// Liczba trafionych tokenow - do sortowania czesciowych dopasowan
// (wiecej wspolnych slow = wyzej na liscie).
function partialScore(hotelName: string, searchName: string, cityExclusions: Set<string>): number {
  const hotelTokens = tokenize(hotelName);
  const searchTokens = tokenizeQuery(searchName).filter((t) => !cityExclusions.has(t));
  return searchTokens.filter((st) => hotelTokens.some((ht) => tokensMatch(ht, st))).length;
}

function addressMatches(hotelAddress: string | null, addressHint: string): boolean {
  if (!hotelAddress) return false;
  const addressTokens = tokenize(hotelAddress);
  const hintTokens = tokenizeQuery(addressHint).filter((t) => !/^\d+$/.test(t) && t !== "ul" && t !== "al");
  if (hintTokens.length === 0 || addressTokens.length === 0) return false;
  return hintTokens.some((ht) => addressTokens.some((at) => tokensMatch(at, ht)));
}

// Klucz porownania "identycznej" nazwy: bez wielkosci liter, znakow diakrytycznych i interpunkcji.
function exactNameKey(name: string): string {
  return tokenize(name).join(" ");
}
const HOTEL_LIKE_TYPES = new Set([204, 205, 206, 218, 231]);

function entryMatches(e: InventoryEntry, searchName: string): boolean {
  return e.names.some((n) => isMatch(n, searchName));
}

function toCandidate(e: InventoryEntry, addressHint?: string): HotelCandidate {
  const c: HotelCandidate = {
    hotel_id: e.hotel_id,
    name: e.name,
    address: e.address,
    booking_url: e.booking_url,
  };
  if (addressHint) c.address_matches_hint = addressMatches(e.address, addressHint);
  return c;
}

const MAX_ALTERNATIVE_CITIES = 5;
const MAX_CANDIDATES = 10;

function reply(output: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API" }],
    structuredContent: output,
  };
}

export function registerFindHotelTool(server: McpServer, client: BookingApiClient, ctx?: RequestContext): void {
  server.registerTool(
    "booking_find_hotel",
    {
      title: "Find Hotel by Name",
      description:
        "Find a hotel by name in a city to get its hotel_id (then use booking_get_hotel_details). " +
        "Searches the FULL Booking.com property list of the city (not only available hotels), " +
        "matching English and Polish property names. Dates are NOT needed. " +
        "Args: hotel_name, city (English), country (2-letter code), optional address_hint. " +
        "ADDRESS: if the user gave a street/address, ALWAYS pass it as address_hint. " +
        "CITY SPELLING: if unsure the city name is right, call booking_search_cities first; if the " +
        "name could belong to more than one country, ask the user. " +
        "AIRPORT HOTELS: often registered under a neighbouring municipality with a different name " +
        "(Trondheim Airport -> Stjørdal, Stavanger Airport -> Sola). On no_match/partial_match for an " +
        "'Airport' hotel, use your geographic knowledge to find that municipality, confirm it with " +
        "booking_search_cities and retry before saying the hotel does not exist. " +
        "RESPONSE CONTRACT ('status'): " +
        "'single_match' -> proceed with the returned hotel_id. " +
        "'multiple_matches' -> list candidates (name + address) and ASK which one; do NOT fetch " +
        "details or describe any candidate in the same turn. " +
        "'partial_match' -> NOT confirmed. Say clearly the exact name was not found, list candidates " +
        "(name + address) and ask the user to confirm. NEVER answer the user's question (parking, " +
        "reception hours, prices...) for a partial candidate before the user confirms it. " +
        "'no_match' -> try alternative_cities_note cities if present; then tell the user the property " +
        "was not found in Booking.com API data for that city (which does not prove it does not exist).",
      inputSchema: FindHotelInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: FindHotelInput) => {
      const started = Date.now();
      const cityResult = await resolveCityId(client, params.city, params.country, ctx?.chatId ?? "");

      if (!cityResult) {
        return {
          content: [{
            type: "text",
            text: await cityNotFoundMessage(client, params.city, params.country),
          }],
          isError: true,
        };
      }

      const cityExclusions = new Set<string>([
        ...tokenize(params.city),
        ...cityResult.name_variants.flatMap((v) => tokenize(v)),
      ]);

      try {
        const inventory = await loadCityInventory(client, cityResult.city_id);

        if (inventory.length === 0) {
          return reply({
            status: "no_match",
            message: "Could not load the property list for " + params.city + " from Booking.com API.",
            data_source: "Booking.com API",
          });
        }

        const searchName = params.hotel_name;
        const hint = params.address_hint;
        let matchedEntries = inventory.filter((e) => entryMatches(e, searchName));

        // Druga proba: user czesto dokleja miasto do nazwy ("Trio Bialystok",
        // "Arche Warszawa"), a w nazwie na Booking.com miasta nie ma. Jesli
        // pelne dopasowanie nic nie dalo, usuwamy tokeny miasta z zapytania.
        if (matchedEntries.length === 0) {
          const withoutCity = tokenizeQuery(searchName).filter((t) => !cityExclusions.has(t));
          if (withoutCity.length > 0 && withoutCity.length < tokenizeQuery(searchName).length) {
            const reduced = withoutCity.join(" ");
            matchedEntries = inventory.filter((e) => entryMatches(e, reduced));
            console.error("=== DIAG booking_find_hotel: druga proba bez nazwy miasta \"" + reduced +
              "\": " + matchedEntries.length + " dopasowan");
          }
        }

        console.error("=== DIAG booking_find_hotel: \"" + searchName + "\" w city=" + cityResult.city_id +
          " (" + inventory.length + " obiektow): " + matchedEntries.length + " pelnych dopasowan, " +
          (Date.now() - started) + " ms");

        // --- Identyczna nazwa ma pierwszenstwo (31.10) ----------------------
        // "Hotel Wawel" mialo 45 "pelnych dopasowan" (Wawel w nazwach apartamentow) -
        // agent dopytywal, choc obiekt o dokladnie tej nazwie byl jeden.
        const exactKey = exactNameKey(searchName);
        const exactEntries = matchedEntries.filter((e) => e.names.some((n) => exactNameKey(n) === exactKey));
        if (exactEntries.length === 1 && matchedEntries.length > 1) {
          console.error("=== DIAG booking_find_hotel: identyczna nazwa \"" + exactEntries[0].name + "\" - wybieram ja z " +
            matchedEntries.length + " dopasowan.");
          return reply({
            status: "single_match",
            hotel: toCandidate(exactEntries[0], hint),
            data_source: "Booking.com API",
            note: "Exact name match. " + (matchedEntries.length - 1) + " other properties have similar names - " +
              "if the user meant another one, they can give the address.",
          });
        }
        // Kolejnosc kandydatow: identyczna nazwa, potem hotele, potem reszta.
        const rank = (e: InventoryEntry): number =>
          (e.names.some((n) => exactNameKey(n) === exactKey) ? 0 : 2) +
          (e.accommodation_type != null && HOTEL_LIKE_TYPES.has(e.accommodation_type) ? 0 : 1);
        matchedEntries = matchedEntries.slice().sort((a, b) => rank(a) - rank(b));

        // --- Pelne dopasowania -------------------------------------------
        if (matchedEntries.length === 1) {
          return reply({
            status: "single_match",
            hotel: toCandidate(matchedEntries[0], hint),
            data_source: "Booking.com API",
          });
        }

        if (matchedEntries.length > 1) {
          if (hint) {
            const byAddress = matchedEntries.filter((e) => addressMatches(e.address, hint));
            console.error("=== DIAG booking_find_hotel: address_hint=\"" + hint + "\" zawezil " +
              matchedEntries.length + " -> " + byAddress.length);
            if (byAddress.length === 1) {
              return reply({
                status: "single_match",
                hotel: toCandidate(byAddress[0], hint),
                data_source: "Booking.com API",
                note: "Narrowed down from " + matchedEntries.length + " name matches using address_hint.",
              });
            }
          }
          const output: any = {
            status: "multiple_matches",
            message: "Found " + matchedEntries.length + " properties matching \"" + searchName + "\" in " +
              params.city + ". Ask the user which one they mean (show name and address).",
            candidates: matchedEntries.slice(0, MAX_CANDIDATES).map((e) => toCandidate(e, hint)),
            data_source: "Booking.com API",
          };
          if (hint) {
            output.address_hint_note = "address_hint=\"" + hint + "\" did not identify exactly one property.";
          }
          return reply(output);
        }

        // --- Brak pelnego dopasowania ------------------------------------
        const partial = inventory
          .filter((e) => e.names.some((n) => partialMatch(n, searchName, cityExclusions)))
          .map((e) => ({
            e,
            score: Math.max(...e.names.map((n) => partialScore(n, searchName, cityExclusions))) +
              (hint && addressMatches(e.address, hint) ? 10 : 0),
          }))
          .sort((a, b) => b.score - a.score)
          .map((x) => x.e);

        // Kandydaci z adresem zgodnym z address_hint sa na gorze listy
        // (+10 do wyniku) i maja address_matches_hint=true - ale to nadal
        // NIE jest pewne dopasowanie, model ma dopytac.
        let alternativeCitiesNote: string | undefined;
        try {
          const alternativeCities = await searchCities(
            client, params.city, params.country, MAX_ALTERNATIVE_CITIES + 1
          );
          const otherCities = alternativeCities.filter((c) => c.city_id !== cityResult.city_id);
          if (otherCities.length > 0) {
            alternativeCitiesNote =
              "Booking.com has other similarly-named city entries that were NOT checked: " +
              otherCities.slice(0, MAX_ALTERNATIVE_CITIES).map((c) => "\"" + c.name + "\"").join(", ") +
              ". RETRY with one of them before concluding the property does not exist.";
          }
        } catch (altErr) {
          console.error("=== Blad przy szukaniu alternatywnych miast (pomijam): " +
            (altErr instanceof Error ? altErr.message : String(altErr)));
        }

        if (partial.length > 0) {
          const output: any = {
            status: "partial_match",
            message: "No property exactly matches \"" + searchName + "\" in " + params.city +
              ". Found " + partial.length + " property(ies) sharing part of the name - NOT confirmed. " +
              "List them (name + address) and ask the user to confirm. Do not answer questions about " +
              "any of them until the user confirms.",
            candidates: partial.slice(0, MAX_CANDIDATES).map((e) => toCandidate(e, hint)),
            data_source: "Booking.com API",
          };
          if (alternativeCitiesNote) output.alternative_cities_note = alternativeCitiesNote;
          return reply(output);
        }

        const output: any = {
          status: "no_match",
          message: "No property matching \"" + searchName + "\" in the Booking.com API property list for " +
            params.city + " (" + inventory.length + " properties checked). This does not prove the " +
            "property does not exist - it may be listed under a neighbouring town.",
          data_source: "Booking.com API",
        };
        if (alternativeCitiesNote) output.alternative_cities_note = alternativeCitiesNote;
        return reply(output);

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