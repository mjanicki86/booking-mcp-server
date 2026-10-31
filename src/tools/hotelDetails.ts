import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { sanitizeForOrchestrator } from "../utils/sanitizeForOrchestrator.js";
import { LOG_DEBUG } from "../services/bookingClient.js";

const HotelDetailsInputSchema = z.object({
  hotel_id: z.number().int()
    .describe("hotel_id from booking_search_hotels or booking_find_hotel in this message"),
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
// Udogodnienia OBIEKTU i POKOJU maja osobne, nakladajace sie numeracje
// (id 1 obiektu != id 1 pokoju) - dlatego dwie osobne mapy.
interface FacilityNames {
  accommodation: Map<number, string>;
  room: Map<number, string>;
}

let facilityNamesCache: { fetchedAt: number; names: FacilityNames } | null = null;
let facilityNamesInFlight: Promise<FacilityNames | null> | null = null;

// Wywolywane tez przy starcie serwera (index.ts), zeby pierwsze zapytanie
// konsultanta nie czekalo na pobranie slownika.
export async function loadFacilityNames(apiKey: string, affiliateId: string): Promise<FacilityNames | null> {
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
      const toMap = (list: any): Map<number, string> => {
        const m = new Map<number, string>();
        if (!Array.isArray(list)) return m;
        for (const f of list) {
          const n = f?.name?.["pl"] ?? f?.name?.["en-gb"] ?? null;
          if (f?.id != null && typeof n === "string") m.set(f.id, n);
        }
        return m;
      };
      const names: FacilityNames = {
        accommodation: toMap(data.accommodation_facilities),
        room: toMap(data.room_facilities),
      };
      console.error("=== constants: zaladowano " + names.accommodation.size + " nazw udogodnien obiektu, " +
        names.room.size + " nazw udogodnien pokoi");
      if (names.accommodation.size > 0) {
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

const PAYMENT_TIMING_NAMES: Record<string, string> = {
  pay_at_the_property: "platnosc na miejscu",
  pay_online_later: "platnosc online pozniej",
  pay_online_now: "platnosc online od razu",
};

const PETS_ALLOWED_NAMES: Record<string, string> = {
  yes: "tak",
  no: "nie",
  upon_request: "na zapytanie",
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

// Rodzaj parkingu dla konsultanta (2026-10-29, decyzja: parking zawsze w
// wynikach + wyrazne oznaczenie, gdy obiekt ma TYLKO parking publiczny -
// filtr "parking" przepuszcza tez takie obiekty, np. Hotel Columbus Krakow).
export type ParkingKind = "private" | "public_only" | "mixed" | "unknown" | "none";

function parkingKind(fd: any, facilityTexts: string[]): ParkingKind {
  const list = Array.isArray(fd?.parking_facilities) ? fd.parking_facilities : [];
  if (list.length > 0) {
    const hasPublic = list.some((p: any) => p?.type === "public");
    const hasPrivate = list.some((p: any) => p?.type === "private");
    if (hasPublic && hasPrivate) return "mixed";
    if (hasPublic) return "public_only";
    if (hasPrivate) return "private";
    return "unknown";
  }
  return facilityTexts.some((t) => /parking|garaz|garage/i.test(t)) ? "unknown" : "none";
}

// Zdanie po polsku, ktore model moze przekazac 1:1 - zamiast kazac mu
// skladac odpowiedz z surowych pol (tu wlasnie gubil informacje).
function buildParkingSummary(fd: any, currency: string | null, facilityTexts: string[]): string {
  const list = Array.isArray(fd?.parking_facilities) ? fd.parking_facilities : [];
  if (list.length > 0) {
    const prefix = parkingKind(fd, facilityTexts) === "public_only"
      ? "Obiekt nie ma własnego parkingu, tylko parking publiczny. "
      : "";
    return prefix + list.map((p: any) => {
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
    return "Booking.com nie podaje szczegółów parkingu (cena/typ), ale lista udogodnień zawiera: " +
      parkingFacilities.join("; ") + ".";
  }
  return "Brak informacji o parkingu w Booking.com.";
}

function extractText(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    return field["en-gb"] ?? field["pl"] ?? field["en"] ?? Object.values(field)[0] as string ?? null;
  }
  return null;
}

// Zamienia wpis udogodnienia na czytelny tekst. Obiekt: {id: 2, attributes:
// ["paid"]} -> "Parking (platne)". Pokoje: API zwraca SAME LICZBY
// ("facilities":[1,4,6,...]) - wczesniej dawalo to pusta liste udogodnien pokoju.
// fallbackNames: reczny slownik - tylko dla udogodnien obiektu.
function facilityToText(
  rawF: any,
  names: Map<number, string> | null,
  fallbackNames: Record<number, string> | null
): string | null {
  const f = typeof rawF === "number" ? { id: rawF } : rawF;
  if (!f) return null;
  const directName = extractText(f.name) ?? extractText(f.facility_name);
  const baseName = directName ??
    (f.id != null ? names?.get(f.id) : undefined) ??
    (fallbackNames && f.id != null ? fallbackNames[f.id] : undefined) ??
    null;
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

// ---------------------------------------------------------------------------
// PARKING DLA LISTY HOTELI (2026-10-29)
//
// Zgloszenie Julii Galki (2026-10-28, hotele 3* przy Wawelu "z parkingiem"):
// booking_search_hotels z required_facilities=parking zwracal hotele BEZ
// zadnej informacji o parkingu. Przy dopytaniu o cene parkingu model wywolal
// booking_get_hotel_details z WYMYSLONYMI hotel_id (1098571..1098577 -
// kolejne liczby, zadne z wynikow wyszukiwania: 332612, 258759, 87070, ...),
// /details zwrocil data:[] dla kazdego, a model oglosil "zaden obiekt nie
// udostepnil danych o parkingu".
//
// Przyczyna: Copilot Studio nie przekazuje modelowi wynikow narzedzi z
// poprzednich tur (patrz komentarz w hotelSearch.ts), wiec hotel_id z listy
// nie przezywaja do kolejnej tury. Dlatego parking dla listy liczymy po
// stronie serwera - JEDNYM zapytaniem /details dla wszystkich ID listy - i
// dokladamy parking_summary do kazdej pozycji wyniku wyszukiwania.
//
// Dane dostepowe zapamietujemy przy rejestracji narzedzia szczegolow, zeby
// nie zmieniac sygnatury registerHotelSearchTool ani index.ts.
// ---------------------------------------------------------------------------
let parkingApiCreds: { apiKey: string; affiliateId: string } | null = null;
const DETAILS_MAX_IDS_PER_REQUEST = 100;

export interface ParkingInfo {
  summary: string;
  kind: ParkingKind;
  details: any[] | null;
}

function parkingInfoFromDetails(h: any, names: FacilityNames | null): ParkingInfo {
  const currency: string | null = typeof h.currency === "string" ? h.currency : null;
  const texts: string[] = [];
  if (Array.isArray(h.facilities)) {
    for (const f of h.facilities) {
      const t = facilityToText(f, names?.accommodation ?? null, FACILITY_NAMES);
      if (t) texts.push(t);
    }
  }
  return {
    summary: buildParkingSummary(h.facility_details, currency, texts),
    kind: parkingKind(h.facility_details, texts),
    details: parseParkingDetails(h.facility_details, currency),
  };
}

// (2026-10-29, przeglad pkt 7) preloaded = surowe /details z wyszukiwania
// (bookingClient.searchAccommodations pyta o ten sam endpoint z tymi samymi
// extras). Dla obiektow, ktore tam sa, nie pytamy API drugi raz.
export async function fetchParkingSummaries(
  hotelIds: number[],
  preloaded?: Map<number, any>
): Promise<{ byId: Map<number, ParkingInfo>; failed: boolean }> {
  const byId = new Map<number, ParkingInfo>();
  if (hotelIds.length === 0) return { byId, failed: false };
  let fromPreloaded = 0;
  if (preloaded && preloaded.size > 0) {
    const names = parkingApiCreds
      ? await loadFacilityNames(parkingApiCreds.apiKey, parkingApiCreds.affiliateId)
      : null;
    for (const id of hotelIds) {
      const h = preloaded.get(id);
      if (h) {
        byId.set(id, parkingInfoFromDetails(h, names));
        fromPreloaded++;
      }
    }
  }
  const missingIds = hotelIds.filter((id) => !byId.has(id));
  if (missingIds.length === 0) {
    console.error("=== DIAG parking dla listy: " + byId.size + " z " + hotelIds.length +
      " hoteli z danych wyszukiwania, bez dodatkowego zapytania /details.");
    return { byId, failed: false };
  }
  if (!parkingApiCreds) {
    console.error("=== OSTRZEZENIE fetchParkingSummaries: brak danych dostepowych " +
      "(registerHotelDetailsTool nie zostal wywolany) - pomijam parking dla listy.");
    return { byId, failed: true };
  }
  const { apiKey, affiliateId } = parkingApiCreds;
  const facilityNamesPromise = loadFacilityNames(apiKey, affiliateId);
  let failed = false;
  let withStructured = 0;

  for (let i = 0; i < missingIds.length; i += DETAILS_MAX_IDS_PER_REQUEST) {
    const chunk = missingIds.slice(i, i + DETAILS_MAX_IDS_PER_REQUEST);
    try {
      const response = await fetch(config.bookingApiBaseUrl + "/accommodations/details", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Affiliate-Id": affiliateId,
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify({ accommodations: chunk, extras: ["facilities"] }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      if (!response.ok) {
        console.error("=== BLAD parking dla listy: /details " + response.status + ": " + text.slice(0, 500));
        failed = true;
        continue;
      }
      const raw = JSON.parse(text);
      const list: any[] = raw.data ?? [];
      const names = await facilityNamesPromise;
      for (const h of list) {
        if (h?.id == null) continue;
        byId.set(h.id, parkingInfoFromDetails(h, names));
      }
    } catch (err) {
      console.error("=== BLAD parking dla listy: wyjatek: " + (err instanceof Error ? err.message : String(err)));
      failed = true;
    }
  }

  for (const v of byId.values()) if (v.details) withStructured++;
  console.error("=== DIAG parking dla listy: " + byId.size + " z " + hotelIds.length +
    " hoteli ma dane z /details (" + fromPreloaded + " z wyszukiwania, " + (byId.size - fromPreloaded) +
    " dociagniete), " + withStructured +
    " ze szczegolami parkingu (facility_details.parking_facilities)" +
    (failed ? ", CZESC ZAPYTAN NIEUDANA" : "") + ".");
  return { byId, failed };
}

export function registerHotelDetailsTool(
  server: McpServer,
  apiKey: string,
  affiliateId: string
): void {
  parkingApiCreds = { apiKey, affiliateId };
  server.registerTool(
    "booking_get_hotel_details",
    {
      title: "Get Hotel Details",
      description: "Full details of ONE hotel: facilities, parking, meal prices, rooms, check-in/out times, payment, pets, damage deposit, cots and extra beds, age rules, contact. hotel_id must come from booking_search_hotels or booking_find_hotel in THIS message - results of earlier messages are not visible to you; if you only know the hotel name, call booking_find_hotel first. Never guess or construct an id.\nAnswer only from fields of the response; if a field is null, say Booking.com does not provide it (a 24-hour reception does not mean check-in at any time - use checkin_from / checkin_until).\nParking: describe parking_summary once, in your own words; for parking_kind public_only say the hotel has no own parking. Contact: give 'contact' when something has to be confirmed with the hotel.\nAlways end the answer with the link from 'url' (e.g. '[Nazwa hotelu na Booking.com](url)').\nFor parking or amenities of a whole list of hotels, repeat booking_search_hotels (every hotel there has parking_summary; amenities via required_facilities) instead of calling this tool for each hotel.",
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
        if (LOG_DEBUG || !response.ok) console.error("=== Hotel details body: " + responseText.slice(0, 6000));

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
          // 2026-10-28: pusty data:[] dla wymyslonych ID byl oddawany jako zwykla
          // odpowiedz, a model wnioskowal z niego "hotel nie podaje danych".
          console.error("=== OSTRZEZENIE hotel_details: /details zwrocil pusta liste dla hotel_id=" +
            params.hotel_id + " - ID nie istnieje (najpewniej zgadniete przez model).");
          return {
            content: [{
              type: "text",
              text: "ERROR: hotel_id " + params.hotel_id + " does not exist on Booking.com - it was most likely " +
                "guessed or reconstructed from memory, not copied from a tool response in this turn. This says " +
                "NOTHING about the hotel's parking, amenities or data - do NOT tell the user the hotel has no " +
                "information. Get the real id: call booking_find_hotel with the hotel name, city and country, then " +
                "call booking_get_hotel_details again. If the user asks about parking for several hotels from a " +
                "previous search list, instead repeat booking_search_hotels with the same parameters - every " +
                "hotel on its list includes parking_summary.",
            }],
            isError: true,
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
        // Tekst z API jak opis - tez czyszczony (ContentFiltered, przeglad pkt 18).
        const rawImportantInfo = extractText(hotel.description?.important_information) ?? null;
        const importantInfo = rawImportantInfo ? sanitizeForOrchestrator(rawImportantInfo, 800) : null;
        const checkinFrom = hotel.checkin_checkout_times?.checkin_from ?? null;
        const checkinTo = hotel.checkin_checkout_times?.checkin_to ?? null;
        const checkoutFrom = hotel.checkin_checkout_times?.checkout_from ?? null;
        const checkoutTo = hotel.checkin_checkout_times?.checkout_to ?? null;

        const facilityNames = await facilityNamesPromise;

        const facilities: string[] = [];
        if (Array.isArray(hotel.facilities)) {
          for (const f of hotel.facilities) {
            const ftext = facilityToText(f, facilityNames?.accommodation ?? null, FACILITY_NAMES);
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
          if (typeof hotel.meal_prices.breakfast === "number" && hotel.meal_prices.breakfast >= 1) mp.breakfast = hotel.meal_prices.breakfast;
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
                const ftext = facilityToText(f, facilityNames?.room ?? null, null);
                // Bez slownika pokoi nie pokazujemy "udogodnienie #N" - nic nie mowi.
                if (ftext && !ftext.startsWith("udogodnienie #")) roomFacilities.push(ftext);
              }
            }
            rooms.push({
              name: extractText(room.name) ?? "Room",
              max_occupancy: room.max_occupancy ?? null,
              facilities: roomFacilities,
            });
          }
        }

        // Platnosci: API 3.1 zwraca je w hotel.payment (wczesniej czytalismy
        // nieistniejace payment_methods - pole bylo zawsze puste).
        const pay = hotel.payment ?? null;
        const payment = pay ? {
          cash_accepted: pay.methods?.cash ?? null,
          cards_accepted: Array.isArray(pay.methods?.cards) ? pay.methods.cards.length > 0 : null,
          cvc_required: pay.cvc_required ?? null,
          payment_timings: Array.isArray(pay.timings)
            ? pay.timings.map((t: string) => PAYMENT_TIMING_NAMES[t] ?? t)
            : null,
        } : null;

        // Zwierzeta: API 3.1 zwraca je w hotel.policies.pets (wczesniej
        // czytalismy nieistniejace hotel.pets - zawsze null).
        const petsRaw = hotel.policies?.pets ?? null;
        const pets = petsRaw ? {
          allowed: PETS_ALLOWED_NAMES[petsRaw.allowed] ?? petsRaw.allowed ?? null,
          charge: petsRaw.charge_mode ? (CHARGE_MODE_NAMES[petsRaw.charge_mode] ?? petsRaw.charge_mode) : null,
        } : null;

        // === DEPOZYT, DOSTAWKI, WIEK (2026-10-30, zgloszenie: depozyt w Mercure Riga) ===
        // API 3.1 zwraca je w hotel.policies (damage, cots_and_extra_beds, *_age).
        // Pobieralismy policies, ale przekazywalismy tylko pets - agent pisal
        // "brak wzmianki o depozycie", choc Booking.com go podaje.
        const policies = hotel.policies ?? null;
        const damage = policies?.damage ?? null;
        const describeTiming = function (t: any): any {
          if (!t || typeof t !== "object") return null;
          const date = t.date ?? null;
          return {
            when: date ? { days_offset: date.days_offset ?? null, reference: date.reference_date ?? null } : null,
            payment_method: t.payment_method ?? null,
          };
        };
        const damageDeposit = damage && (damage.amount != null || damage.deposit) ? {
          amount: damage.amount ?? null,
          currency: damage.currency ?? hotelCurrency ?? null,
          collected: describeTiming(damage.deposit?.collect),
          refunded: describeTiming(damage.deposit?.refund),
        } : null;
        const cotsRaw = policies?.cots_and_extra_beds;
        const cotsAndExtraBeds = Array.isArray(cotsRaw) && cotsRaw.length > 0
          ? cotsRaw.map(function (c: any) {
              return {
                type: c?.type ?? null,
                age_from: c?.age?.from ?? null,
                age_to: c?.age?.to ?? null,
                charge: c?.mode ?? null,
                price: c?.price ?? null,
              };
            })
          : (cotsRaw && typeof cotsRaw === "object" && !Array.isArray(cotsRaw) ? cotsRaw : null);
        const ageRules = policies && (policies.minimum_checkin_age != null || policies.maximum_checkin_age != null ||
          policies.minimum_guest_age != null) ? {
            minimum_checkin_age: policies.minimum_checkin_age ?? null,
            maximum_checkin_age: policies.maximum_checkin_age ?? null,
            minimum_guest_age: policies.minimum_guest_age ?? null,
          } : null;
        console.error("=== DIAG hotel_details " + params.hotel_id + ": depozyt=" +
          (damageDeposit ? JSON.stringify(damageDeposit) : "brak w danych") +
          ", dostawki=" + (cotsAndExtraBeds ? "tak" : "brak") + ", wiek=" + (ageRules ? JSON.stringify(ageRules) : "brak"));

        // Kontakt do obiektu (dane "trader" z opisu) - konsultanci potrzebuja
        // telefonu/maila recepcji, np. do potwierdzenia miejsca parkingowego.
        const trader = hotel.description?.trader ?? null;
        const contact = trader && (trader.telephone || trader.email)
          ? { telephone: trader.telephone ?? null, email: trader.email ?? null }
          : null;

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
          checkin_until: checkinTo,
          checkout_from: checkoutFrom,
          checkout_until: checkoutTo,
          contact: contact,
          description: description,
          important_information: importantInfo ?? null,
          facilities: facilities,
          parking_summary: parkingSummary,
          parking_kind: parkingKind(hotel.facility_details, facilities),
          parking_details: parkingDetails,
          wifi_details: wifiDetails,
          meal_prices: mealPrices,
          rooms: rooms,
          payment: payment,
          pets: pets,
          damage_deposit: damageDeposit,
          damage_deposit_note: damageDeposit
            ? "Refundable damage deposit reported by Booking.com - give the amount, when and how it is collected " +
              "(days_offset relative to reference, e.g. arrival) and when it is refunded."
            : "Booking.com does not report a damage deposit for this hotel. If asked, say Booking.com has no " +
              "information about a deposit (not that there is none) and suggest checking with the hotel.",
          cots_and_extra_beds: cotsAndExtraBeds,
          age_rules: ageRules,
          url: hotel.url ?? null,
          display_instruction: hotel.url
            ? "End your answer with this link to the property page: [" + name + " na Booking.com](" + hotel.url + ")"
            : "No property page link available from the API for this hotel.",
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