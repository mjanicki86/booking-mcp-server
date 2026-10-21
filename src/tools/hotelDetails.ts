import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { sanitizeForOrchestrator } from "../utils/sanitizeForOrchestrator.js";

const HotelDetailsInputSchema = z.object({
  hotel_id: z.number().int()
    .describe("Hotel ID from booking_search_hotels or booking_find_hotel results"),
});

type HotelDetailsInput = z.infer<typeof HotelDetailsInputSchema>;

// ---------------------------------------------------------------------------
// NAZWY UDOGODNIEN
//
// API 3.1 zwraca w `facilities` same numery ID. Wczesniej tlumaczylismy je
// recznym slownikiem (ponizej) - kazde ID spoza slownika trafialo do modelu
// jako "udogodnienie #160" itp., ktorego model nie umial zinterpretowac.
// Zgloszenie Damiana (Hotel Trio Bialystok, 2026-10-16): Booking.com
// pokazuje "Bezplatny parking prywatny na miejscu", a asystent odpowiedzial
// "brak informacji o parkingu".
//
// TERAZ: pelna lista nazw z /accommodations/constants (pl + en-gb),
// pobierana raz i trzymana 24h. Reczny slownik zostaje tylko jako fallback,
// gdy constants sie nie zaladuja.
// ---------------------------------------------------------------------------

const CONSTANTS_TTL_MS = 24 * 60 * 60 * 1000;
let facilityNamesCache: { fetchedAt: number; names: Map<number, string> } | null = null;
let facilityNamesInFlight: Promise<Map<number, string> | null> | null = null;

async function loadFacilityNames(apiKey: string, affiliateId: string): Promise<Map<number, string> | null> {
  if (facilityNamesCache && Date.now() - facilityNamesCache.fetchedAt < CONSTANTS_TTL_MS) {
    return facilityNamesCache.names;
  }
  if (facilityNamesInFlight) return facilityNamesInFlight;

  facilityNamesInFlight = (async () => {
    try {
      const response = await fetch(config.bookingApiBaseUrl + "/accommodations/constants", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Affiliate-Id": affiliateId,
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify({ languages: ["pl", "en-gb"] }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      if (!response.ok) {
        console.error("=== constants: blad " + response.status + " (uzywam recznego slownika): " + text.slice(0, 500));
        return null;
      }
      const raw = JSON.parse(text);
      const data = raw.data ?? {};
      const names = new Map<number, string>();
      for (const list of [data.accommodation_facilities, data.room_facilities]) {
        if (!Array.isArray(list)) continue;
        for (const f of list) {
          const n = f?.name?.["pl"] ?? f?.name?.["en-gb"] ?? null;
          // Pierwsze wystapienie wygrywa (accommodation_facilities przed room_facilities)
          if (f?.id != null && typeof n === "string" && !names.has(f.id)) names.set(f.id, n);
        }
      }
      console.error("=== constants: zaladowano " + names.size + " nazw udogodnien");
      if (names.size > 0) {
        facilityNamesCache = { fetchedAt: Date.now(), names };
        return names;
      }
      return null;
    } catch (err) {
      console.error("=== constants: wyjatek (uzywam recznego slownika): " +
        (err instanceof Error ? err.message : String(err)));
      return null;
    } finally {
      facilityNamesInFlight = null;
    }
  })();
  return facilityNamesInFlight;
}

// FALLBACK: reczny slownik, uzywany tylko gdy constants nie sa dostepne.
const FACILITY_NAMES: Record<number, string> = {
  2: "parking",
  3: "restauracja",
  4: "zwierzeta akceptowane",
  5: "room service",
  6: "sale konferencyjne",
  7: "bar",
  8: "recepcja 24h",
  10: "sauna",
  11: "silownia / fitness",
  14: "ogrod",
  15: "taras",
  16: "pokoje dla niepalacych",
  17: "transfer lotniskowy",
  20: "centrum biznesowe",
  21: "opieka nad dziecmi",
  22: "pralnia",
  23: "pranie chemiczne",
  25: "udogodnienia dla niepelnosprawnych",
  28: "pokoje rodzinne",
  47: "sejf",
  48: "winda",
  51: "kantor wymiany walut",
  54: "spa i centrum wellness",
  55: "masaze",
  56: "plac zabaw dla dzieci",
  63: "jacuzzi",
  64: "pokoje dzwiekoszczelne",
  72: "miejsce na grilla",
  73: "suchy prowiant",
  75: "wypozyczalnia samochodow",
  76: "wypozyczalnia rowerow",
  80: "ogrzewanie",
  91: "przechowalnia bagazu",
  103: "basen kryty",
  104: "basen odkryty",
  107: "darmowe WiFi",
  108: "obiekt calkowicie dla niepalacych",
  109: "klimatyzacja",
  110: "wyznaczone miejsce dla palacych",
  124: "concierge",
  158: "codzienne sprzatanie",
};

// Tlumaczenie atrybutow udogodnien
const ATTRIBUTE_NAMES: Record<string, string> = {
  paid: "platne",
  free: "bezplatne",
  private: "prywatne",
  on_site: "na miejscu",
  offsite: "poza obiektem",
  reservation_needed: "wymagana rezerwacja",
};

// Tlumaczenie pol facility_details (wartosci wg dokumentacji Demand API 3.1)
const CHARGE_MODE_NAMES: Record<string, string> = {
  free: "bezplatny",
  paid: "platny",
  charges_are_applicable: "platny",
  charges_may_apply: "moga obowiazywac oplaty",
  per_hour: "platny za godzine",
  per_day: "platny za dobe",
  per_week: "platny za tydzien",
  per_stay: "platny za caly pobyt",
};

const PARKING_TYPE_NAMES: Record<string, string> = {
  private: "prywatny",
  public: "publiczny",
};

const PARKING_LOCATION_NAMES: Record<string, string> = {
  on_site: "na miejscu",
  nearby: "w poblizu",
};

const PARKING_RESERVATION_NAMES: Record<string, string> = {
  needed: "rezerwacja wymagana",
  not_needed: "rezerwacja niepotrzebna",
  not_possible: "rezerwacja niemozliwa",
};

// Zdanie po polsku, ktore model moze przekazac 1:1 - zamiast kazac mu
// skladac odpowiedz z surowych pol (tu wlasnie gubil informacje).
function buildParkingSummary(fd: any, currency: string | null, facilityTexts: string[]): string {
  const list = Array.isArray(fd?.parking_facilities) ? fd.parking_facilities : [];
  if (list.length > 0) {
    return list.map((p: any) => {
      const parts: string[] = ["Parking"];
      if (p.type && PARKING_TYPE_NAMES[p.type]) parts.push(PARKING_TYPE_NAMES[p.type]);
      if (p.location && PARKING_LOCATION_NAMES[p.location]) parts.push(PARKING_LOCATION_NAMES[p.location]);
      let s = parts.join(" ");
      const mode = p.charge_mode ? (CHARGE_MODE_NAMES[p.charge_mode] ?? p.charge_mode) : null;
      if (mode) s += ", " + mode;
      if (typeof p.price === "number" && p.price > 0) s += " (" + p.price + (currency ? " " + currency : "") + ")";
      if (p.reservation && PARKING_RESERVATION_NAMES[p.reservation]) s += ", " + PARKING_RESERVATION_NAMES[p.reservation];
      return s + ".";
    }).join(" ");
  }
  const parkingFacilities = facilityTexts.filter((t) => /parking|garaz|garage/i.test(t));
  if (parkingFacilities.length > 0) {
    return "Booking.com API nie podaje szczegolow parkingu (cena/typ), ale lista udogodnien zawiera: " +
      parkingFacilities.join("; ") + ".";
  }
  return "Booking.com API nie zwraca dla tego obiektu zadnych informacji o parkingu.";
}

function extractText(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    return field["en-gb"] ?? field["pl"] ?? field["en"] ?? Object.values(field)[0] as string ?? null;
  }
  return null;
}

// Zamienia wpis udogodnienia (numer + atrybuty) na czytelny tekst,
// np. {id: 2, attributes: ["paid"]} -> "Parking (platne)"
function facilityToText(f: any, names: Map<number, string> | null): string | null {
  const directName = extractText(f.name) ?? extractText(f.facility_name);
  const baseName = directName ?? (f.id != null ? names?.get(f.id) : undefined) ?? FACILITY_NAMES[f.id] ?? null;
  if (!baseName) {
    return f.id != null ? "udogodnienie #" + f.id : null;
  }

  const attrs: string[] = [];
  if (Array.isArray(f.attributes)) {
    for (const a of f.attributes) {
      if (typeof a === "string") {
        attrs.push(ATTRIBUTE_NAMES[a] ?? a);
      }
    }
  }

  return attrs.length > 0 ? baseName + " (" + attrs.join(", ") + ")" : baseName;
}

// Odczyt strukturalnych szczegolow parkingu z facility_details (jesli API je zwraca)
function parseParkingDetails(fd: any, currency: string | null): any[] | null {
  if (!fd || !Array.isArray(fd.parking_facilities) || fd.parking_facilities.length === 0) {
    return null;
  }
  return fd.parking_facilities.map(function (p: any) {
    const entry: any = {};
    if (p.type != null) entry.type = p.type;
    if (p.price != null) entry.price = p.price;
    if (currency && p.price != null && p.price > 0) entry.currency = currency;
    if (p.charge_mode != null) entry.charge_mode = CHARGE_MODE_NAMES[p.charge_mode] ?? p.charge_mode;
    if (p.location != null) entry.location = p.location;
    if (p.reservation != null) entry.reservation = p.reservation;
    return entry;
  });
}

// Odczyt strukturalnych szczegolow internetu z facility_details (jesli sa)
function parseWifiDetails(fd: any, currency: string | null): any | null {
  const w = fd?.internet_facility;
  if (!w) return null;
  const entry: any = {};
  if (w.connection_type != null) entry.connection_type = w.connection_type;
  if (w.price != null) entry.price = w.price;
  if (currency && w.price != null && w.price > 0) entry.currency = currency;
  if (w.charge_mode != null) entry.charge_mode = CHARGE_MODE_NAMES[w.charge_mode] ?? w.charge_mode;
  if (w.coverage != null) entry.coverage = w.coverage;
  return entry;
}

export function registerHotelDetailsTool(
  server: McpServer,
  apiKey: string,
  affiliateId: string
): void {
  server.registerTool(
    "booking_get_hotel_details",
    {
      title: "Get Hotel Details",
      description: "Get detailed information about a specific hotel, including its FULL list of facilities/amenities (parking, pool, gym/fitness, WiFi, restaurant, air conditioning, spa, sauna, pets allowed, elevator, etc.), meal prices (breakfast/lunch/dinner), room types, check-in/out policies, payment options, and important information such as fees and pet policies. CRITICAL: this is the ONLY reliable source for checking whether a hotel has a specific amenity (pool, gym, parking, spa, air conditioning, pets, etc.) - always check the structured 'facilities' field in the response, NOT the free-text description, which is often incomplete. PARKING: answer parking questions from 'parking_summary' (a ready Polish sentence: type, location, free/paid, price, reservation) - pass it to the user; never say 'no information about parking' if parking_summary or facilities mention parking. If the user asks 'does hotel X have a pool/gym/parking/etc.' or wants a list of hotels filtered by an amenity, call this tool for each candidate hotel and check its facilities field. Requires hotel_id from booking_search_hotels or booking_find_hotel results. Args: hotel_id (number): Hotel ID from search results.",
      inputSchema: HotelDetailsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: HotelDetailsInput) => {
      try {
        const endpoint = "/accommodations/details";
        const url = config.bookingApiBaseUrl + endpoint;
        console.error("=== Calling hotel details for hotel " + params.hotel_id);

        const requestBody = {
          accommodations: [params.hotel_id],
          extras: ["facilities", "description", "payment", "policies", "rooms"],
        };

        // Rownolegle z pobraniem szczegolow (z cache - zwykle natychmiast).
        const facilityNamesPromise = loadFacilityNames(apiKey, affiliateId);

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Affiliate-Id": affiliateId,
            "Authorization": "Bearer " + apiKey,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(30000),
        });

        const responseText = await response.text();
        console.error("=== Hotel details status: " + response.status);
        console.error("=== Hotel details body: " + responseText.slice(0, 6000));

        if (!response.ok) {
          return {
            content: [{
              type: "text",
              text: "Booking.com API error (" + response.status + "): " + responseText,
            }],
            isError: true,
          };
        }

        const raw = JSON.parse(responseText);
        const hotels: any[] = raw.data ?? raw.result ?? raw.accommodations ?? [];

        if (hotels.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No details found for hotel ID " + params.hotel_id,
            }],
          };
        }

        const hotel = hotels[0];
        const hotelCurrency: string | null = typeof hotel.currency === "string" ? hotel.currency : null;

        const name = extractText(hotel.name) ?? "Unknown";
        const rawDescription = extractText(hotel.description?.text) ?? extractText(hotel.description) ?? null;
        // Opis z API jest przycinany i normalizowany PRZED przekazaniem dalej -
        // dlugie, nieprzetworzone bloki tekstu marketingowego byly
        // najbardziej prawdopodobnym wyzwalaczem falszywych trafien filtra
        // tresci warstwy orkiestracji (blad "ContentFiltered" zglaszany
        // przez Emilie przy zwyklym wyszukiwaniu hoteli).
        const description = rawDescription ? sanitizeForOrchestrator(rawDescription, 800) : null;
        const importantInfo = extractText(hotel.description?.important_information) ?? null;
        const checkinFrom = hotel.checkin_checkout_times?.checkin_from ?? null;
        const checkoutTo = hotel.checkin_checkout_times?.checkout_to ?? null;

        const facilityNames = await facilityNamesPromise;

        const facilities: string[] = [];
        if (Array.isArray(hotel.facilities)) {
          for (const f of hotel.facilities) {
            const ftext = facilityToText(f, facilityNames);
            if (ftext) facilities.push(ftext);
          }
        }

        const parkingDetails = parseParkingDetails(hotel.facility_details, hotelCurrency);
        const parkingSummary = buildParkingSummary(hotel.facility_details, hotelCurrency, facilities);
        console.error("=== DIAG hotel_details " + params.hotel_id + ": parking_summary=\"" + parkingSummary +
          "\", nazwy udogodnien z constants=" + (facilityNames ? "tak" : "NIE (fallback)"));
        const wifiDetails = parseWifiDetails(hotel.facility_details, hotelCurrency);

        let mealPrices: any = null;
        if (hotel.meal_prices && typeof hotel.meal_prices === "object") {
          const mp: any = {};
          if (hotel.meal_prices.breakfast != null) mp.breakfast = hotel.meal_prices.breakfast;
          if (hotel.meal_prices.lunch != null) mp.lunch = hotel.meal_prices.lunch;
          if (hotel.meal_prices.dinner != null) mp.dinner = hotel.meal_prices.dinner;
          if (Object.keys(mp).length > 0) {
            if (hotelCurrency) mp.currency = hotelCurrency;
            mealPrices = mp;
          }
        }

        const rooms: any[] = [];
        if (Array.isArray(hotel.rooms)) {
          for (const room of hotel.rooms) {
            const roomFacilities: string[] = [];
            if (Array.isArray(room.facilities)) {
              for (const f of room.facilities) {
                const ftext = facilityToText(f, facilityNames);
                if (ftext) roomFacilities.push(ftext);
              }
            }
            rooms.push({
              name: extractText(room.name) ?? "Room",
              max_occupancy: room.max_occupancy ?? null,
              facilities: roomFacilities,
            });
          }
        }

        const paymentMethods: string[] = [];
        if (Array.isArray(hotel.payment_methods)) {
          for (const p of hotel.payment_methods) {
            const pname = extractText(p.name);
            if (pname) paymentMethods.push(pname);
          }
        }

        const address = hotel.address
          ? ((hotel.address.street ?? "") + " " + (hotel.address.city ?? "") + " " + (hotel.address.country ?? "")).trim()
          : (extractText(hotel.location?.address) ?? null);

        const output: any = {
          hotel_id: params.hotel_id,
          name: name,
          address: address || null,
          stars: hotel.class ?? hotel.star_rating ?? hotel.rating?.stars ?? null,
          review_score: hotel.rating?.review_score ?? null,
          review_count: hotel.rating?.number_of_reviews ?? null,
          checkin_from: checkinFrom,
          checkout_until: checkoutTo,
          description: description,
          important_information: importantInfo ?? null,
          facilities: facilities,
          parking_summary: parkingSummary,
          parking_details: parkingDetails,
          wifi_details: wifiDetails,
          meal_prices: mealPrices,
          rooms: rooms,
          payment_methods: paymentMethods,
          pets_allowed: hotel.pets ?? hotel.pet_policy ?? null,
          url: hotel.url ?? null,
          data_source: "Booking.com API",
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API",
          }],
          structuredContent: output,
        };

      } catch (err) {
        return {
          content: [{
            type: "text",
            text: "Error getting hotel details: " + (err instanceof Error ? err.message : String(err)),
          }],
          isError: true,
        };
      }
    }
  );
}