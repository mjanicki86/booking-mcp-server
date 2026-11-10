import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId, cityNotFoundMessage } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";
import { z } from "zod";
import {
  saveResultSet, getResultSet, getMostRecentResultSet, getPage, totalPages, makeSearchKey, RESULT_PAGE_SIZE,
  StoredResultSet,
} from "../services/resultStore.js";
import { fetchParkingSummaries } from "./hotelDetails.js";
import { RequestContext } from "../services/requestContext.js";
import { normalizeText } from "../services/textNormalize.js";
import { ALLOWED_HOTEL_ACCOMMODATION_TYPES, NEAR_PLACE_RE, OTHER_ACCOMMODATION_RE, NEGATED_TYPE_RE, requestedAccommodationTypes, parseUserDistanceKm, isNextBatchRequest, STREET_PREFIX_RE, alternativeNamesFromRequest, breakfastIntent, wantsParking, normalizeFacilities, kidsFacilitiesFromText } from "../services/textParsing.js";
import { resolveStay, childAgesQuestion } from "../services/stayContext.js";
import { brandIdsForChain, brandLabel } from "../services/chains.js";
import { rememberSearchBatch } from "../services/shownHotels.js";
import { searchLandmarks, geocodeAddress } from "../services/landmarkResolver.js";
import { LANDMARK_CLUSTER_DIAMETER_KM, clusterDiameterKm, getCoords, landmarkLabel } from "./findLandmark.js";

// === PROMIEN DOMYSLNY (v4, 2026-10-29, decyzja Michala) ===
// Wczesniej promien dla "koło Wawelu" wybieral model - raz 3 km, raz 1 km
// (testy 2026-10-29), wiec ta sama prosba dawala rozne listy. Teraz:
// - user podal odleglosc -> dokladnie ta odleglosc, bez poszerzania,
// - user nie podal ("koło", "w pobliżu") -> model pomija radius_km, serwer
//   ustawia DEFAULT_NEAR_RADIUS_KM i pokazuje WSZYSTKIE hotele w tym promieniu
//   (paczki po 10, "dalej"),
// - 0 hoteli w promieniu domyslnym -> serwer sam powtarza wyszukiwanie dla
//   WIDENED_RADIUS_KM i zwraca radius_note, ktore agent podaje userowi we wstepie.
const DEFAULT_NEAR_RADIUS_KM = 1;
const WIDENED_RADIUS_KM = 3;
// === MALO WYNIKOW (06.11, zgloszenie Julii - Ossendrecht: 1 hotel w promieniu 1 km, Hotel Dekkers
// dalej) === Poszerzamy nie tylko przy 0, ale gdy jest mniej niz MIN_RESULTS_BEFORE_WIDEN:
// 1 km -> 3 km -> 10 km. Szukanie po samym miescie (male miejscowosci) -> 10 km od centrum.
const MIN_RESULTS_BEFORE_WIDEN = 3;
const FAR_RADIUS_KM = 10;
// Szukanie po miescie poszerzamy tylko dla malych miejscowosci (malo obiektow w miescie).
const SMALL_PLACE_MAX_FOUND = 30;

type WidenContext = {
  fromKm: number;            // 0 = szukanie po samym miescie
  fromCount: number;         // ile obiektow bylo przed poszerzeniem
  continuationExpired: boolean;
};

// Bazowy schemat (inputSchemas.ts) moze miec radius_km z .default(...) - wtedy
// SDK wstawialby wartosc domyslna i serwer nie odroznilby "user nie podal" od
// "user podal". Zdejmujemy default/optional, zachowujac pozostale ograniczenia
// (min/max) z bazowego schematu. Dziala dla zod v3 (_def.typeName) i v4 (_def.type).
function radiusKmWithoutDefault(): z.ZodTypeAny {
  let cur: any = (HotelSearchInputSchema as any).shape?.radius_km;
  for (let i = 0; i < 4 && cur && cur._def; i++) {
    const t = cur._def.typeName ?? cur._def.type;
    if (t === "ZodDefault" || t === "default" || t === "ZodOptional" || t === "optional") {
      cur = cur._def.innerType;
      continue;
    }
    break;
  }
  return cur ?? z.number().positive();
}

// "dalej" = to samo wyszukiwanie + continue_previous:true. Patrz resultStore.ts
// (v3) - Copilot Studio nie przekazuje modelowi wynikow narzedzi z poprzednich
// tur, wiec model nie zna zadnego identyfikatora listy, ale pamieta parametry.
const SearchToolInputSchema = HotelSearchInputSchema.extend({
  continue_previous: z.boolean().optional()
    .describe("true only for the next batch of the same search ('dalej', 'pokaż kolejne', 'więcej'). Repeat the " +
      "search parameters if you know them; continue_previous:true alone also works. Omit for any new or changed search."),
  // (v4) radius_km bez wartosci domyslnej - patrz PROMIEN DOMYSLNY wyzej.
  radius_km: radiusKmWithoutDefault()
    .optional()
    .describe("Radius in km around latitude/longitude - only when the user gave a distance ('do 500 m' -> 0.5). " +
      "Omit for 'koło' / 'w pobliżu' (server default " + DEFAULT_NEAR_RADIUS_KM + " km, widened to " + WIDENED_RADIUS_KM + " km)."),
  landmark_name: z.string().min(2).max(150).optional()
    .describe("Named place to search around (landmark, station, airport, street address), e.g. 'Wawel', " +
      "'Dworzec Centralny'. Requires city + country. The server finds its coordinates - preferred over latitude/longitude."),
  // (v6) dosłowny tekst prośby - patrz USER_REQUEST nizej.
  user_request: z.string().max(2000).optional()
    .describe("Always: the request you are handling (user's message or the task text you received), copied " +
      "verbatim - not paraphrased. The server reads distance and accommodation-type wishes from it."),
});
type SearchToolInput = Omit<HotelSearchInput, "radius_km"> & {
  landmark_name?: string;
  continue_previous?: boolean;
  radius_km?: number;
  user_request?: string;
};


// === TYLKO HOTELE (2026-10-30, decyzja uzytkownika: wykluczyc kazdy typ inny niz hotel) ===
// Wczesniej lista wykluczen (hostel 203, apartament 201, B&B 208, 219, pensjonat 216)
// przepuszczala wille, domy wakacyjne, kwatery, kempingi itd. Teraz lista DOZWOLONYCH:
// 204 Hotels, 231 Economy hotels (np. sieci budzetowe). Typy wg Booking.com:
// 201 Apartments, 203 Hostels, 205 Motels, 206 Resorts, 208 B&B, 210 Farm stays,
// 213 Villas, 214 Campgrounds, 215 Boats, 216 Guesthouses, 218 Inns, 219 Condo hotels,
// 220 Vacation homes, 221 Lodges, 222 Homestays, 224 Luxury tents, 225 Capsule hotels,
// 228 Chalets, 235 Student accommodations. Obiekt bez typu w danych - przepuszczamy.
// 31.10 (decyzja uzytkownika): dopuszczone tez 205 motel, 206 resort, 218 zajazd -
// formaty hotelowe (np. hotel z SPA nad morzem, podmiejski zajazd z pokojami).

const AMENITY_FACILITY_IDS: Record<string, number[]> = {
  pool: [103, 104],
  gym: [11],
  parking: [2],
  wifi: [107],
  air_conditioning: [109],
  spa: [54],
  restaurant: [3],
  sauna: [10],
  pets_allowed: [4],
  // (10.11, zgloszenie Damiana: "hotel z atrakcjami dla dzieci, np. bawialnia") - ID z
  // /accommodations/constants (test 09.11). kids_play: wystarczy jedno z czterech.
  kids_play: [172, 144, 56, 173],   // Indoor play area, Kids' club, Children's playground, Kids' outdoor play equipment
  kids_pool: [258],                  // Kids' pool
  family_rooms: [28],                // Family rooms
  babysitting: [21],                 // Babysitting/child services
};

// Okno "ok. 3 miesiace do przodu" potrafi wpasc dokladnie w swieta - dla
// zapytania z 2026-09-22 dawalo checkin 2026-12-25. Ceny z 25-27 grudnia sa
// skrajnie nietypowe, a byly podawane userowi jako orientacyjne. Omijamy wiec
// okres swiateczno-noworoczny, przesuwajac okno o tydzien.
function isInHolidayBlackout(d: Date): boolean {
  const month = d.getMonth();
  const day = d.getDate();
  if (month === 11 && day >= 20) return true;
  if (month === 0 && day <= 3) return true;
  return false;
}

// Daty z wczesniejszego pytania w czacie (2026-10-29) - od 09.11 w services/stayContext.ts.
// Ten sam TTL (60 min od ostatniego uzycia) dla ostatniego miasta/kraju:
const CHAT_DATES_TTL_MS = 60 * 60 * 1000;

// Ostatnie miasto/kraj wyszukiwania w czacie (60 min od ostatniego uzycia) - fallback,
// gdy agent poda landmark_name bez city/country.
const chatLocation = new Map<string, { city: string; country: string; at: number }>();
function rememberChatLocation(scope: string, city: string, country: string): void {
  if (!scope) return;
  chatLocation.set(scope, { city, country, at: Date.now() });
  if (chatLocation.size > 2000) {
    const oldest = chatLocation.keys().next().value;
    if (oldest !== undefined) chatLocation.delete(oldest);
  }
}
function recentChatLocation(scope: string): { city: string; country: string } | null {
  if (!scope) return null;
  const hit = chatLocation.get(scope);
  if (!hit || Date.now() - hit.at > CHAT_DATES_TTL_MS) return null;
  return { city: hit.city, country: hit.country };
}
const COUNTRY_NAME_CODES: Record<string, string> = {
  poland: "pl", polska: "pl", germany: "de", niemcy: "de", deutschland: "de", latvia: "lv", lotwa: "lv",
  lithuania: "lt", litwa: "lt", czechia: "cz", "czech republic": "cz", czechy: "cz", austria: "at",
  france: "fr", francja: "fr", italy: "it", wlochy: "it", spain: "es", hiszpania: "es", "united kingdom": "gb",
  uk: "gb", "wielka brytania": "gb", netherlands: "nl", holandia: "nl", belgium: "be", belgia: "be",
  portugal: "pt", portugalia: "pt", hungary: "hu", wegry: "hu", slovakia: "sk", slowacja: "sk",
  sweden: "se", szwecja: "se", norway: "no", norwegia: "no", denmark: "dk", dania: "dk", estonia: "ee",
  finland: "fi", finlandia: "fi", switzerland: "ch", szwajcaria: "ch", croatia: "hr", chorwacja: "hr",
  greece: "gr", grecja: "gr", ireland: "ie", irlandia: "ie", romania: "ro", rumunia: "ro", bulgaria: "bg",
};
function countryCodeFromName(name: string): string | null {
  const n = normalizeText(name);
  if (/^[a-z]{2}$/.test(n)) return n;
  return COUNTRY_NAME_CODES[n] ?? null;
}

const nearPlaceGuard = new Map<string, number>();

function getDefaultDates(): { checkin: string; checkout: string } {
  const base = new Date();
  base.setDate(base.getDate() + 90);
  const day = base.getDay();
  const toFriday = (5 - day + 7) % 7;
  base.setDate(base.getDate() + toFriday);
  let checkout = new Date(base);
  checkout.setDate(checkout.getDate() + 2);

  let guard = 0;
  while ((isInHolidayBlackout(base) || isInHolidayBlackout(checkout)) && guard < 8) {
    base.setDate(base.getDate() + 7);
    checkout = new Date(base);
    checkout.setDate(checkout.getDate() + 2);
    guard++;
  }

  return {
    checkin: base.toISOString().split("T")[0],
    checkout: checkout.toISOString().split("T")[0],
  };
}

function roundUpToTen(n: number): number {
  return Math.min(100, Math.max(10, Math.ceil(n / 10) * 10));
}

function rowsToFetch(usingCoordinates: boolean, resultsLimit: number, hasStrongFilters: boolean): number {
  const base = (usingCoordinates || hasStrongFilters)
    ? Math.max(resultsLimit, 100)
    : resultsLimit;
  return roundUpToTen(base);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Zabezpieczenie: /accommodations/details zwraca dane posortowane rosnąco po
// ID Booking.com, IGNORUJĄC kolejność żądania - jeśli merge w bookingClient.ts
// (lub samo API przy dużym "rows") zgubi kolejność ustaloną przez "sort" w
// request body, wyniki zwrócone userowi będą pomieszane mimo sort_by=price
// (POTWIERDZONY BUG 2026-09-11: 1990->2680->2960->6960->3028->3071 PLN).
// To jawne, lokalne sortowanie gwarantuje poprawną kolejność niezależnie od
// tego, co się dzieje wyżej w stosie - defense in depth, nie zależy od
// naprawy w bookingClient.ts.
function compareForSort(a: any, b: any, sortBy?: string): number {
  if (sortBy === "price") {
    const pa = a.price != null ? a.price.amount : null;
    const pb = b.price != null ? b.price.amount : null;
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  }
  if (sortBy === "review_score") {
    const ra = a.review_score;
    const rb = b.review_score;
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  }
  if (sortBy === "stars") {
    const sa = a.star_rating;
    const sb = b.star_rating;
    if (sa == null && sb == null) return 0;
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sb - sa;
  }
  return 0;
}

// === DRYF WSPOLRZEDNYCH MIEDZY TURAMI (2026-10-29) ===
// Test 2026-10-29: pierwsze wyszukiwanie przy Wawelu z booking_find_landmark
// uzylo (50.05519, 19.9359), a dopytanie o parking w kolejnej turze - bez
// ponownego find_landmark - (50.054454, 19.93656), czyli wspolrzedne wpisane
// przez model "z pamieci", ok. 80 m obok. Model nie widzi wynikow narzedzi z
// poprzednich tur, wiec nie ma skad skopiowac dokladnych wartosci.
// Obrona w glebi (niezaleznie od instrukcji w opisie narzedzia): jesli nowy
// punkt lezy blizej niz COORD_SNAP_MAX_KM od punktu uzytego w ciagu ostatnich
// 30 min, uzywamy DOKLADNIE tamtego punktu. Roznica <= 250 m nie zmienia
// sensu zapytania, a zapewnia ten sam zestaw hoteli i te same odleglosci
// (oraz ten sam klucz listy w resultStore przy "dalej").
const COORD_SNAP_MAX_KM = 0.25;
const COORD_SNAP_MAX_AGE_MS = 30 * 60 * 1000;
const COORD_SNAP_MAX_POINTS = 200;
const recentSearchPoints: { scope: string; lat: number; lon: number; at: number }[] = [];


// Odleglosc podana przez usera dla danego punktu - zeby "teraz 4 gwiazdki" po
// "w promieniu 2 km" zostalo przy 2 km, choc nowa wiadomosc nie ma liczby.
const userRadiusByPoint = new Map<string, { km: number; at: number }>();
const USER_RADIUS_MAX_POINTS = 300;

// (2026-10-29) Caly stan miedzy turami jest per czat (scope = czesc naglowka
// conversation-id stala dla czatu Teams, patrz services/requestContext.ts).
// Bez naglowka scope = "" i zachowanie jest jak wczesniej (wspolne dla serwera).
function pointKey(scope: string, lat: number, lon: number): string {
  return scope + "|" + lat.toFixed(4) + "," + lon.toFixed(4);
}

function rememberUserRadius(scope: string, lat: number, lon: number, km: number): void {
  userRadiusByPoint.delete(pointKey(scope, lat, lon));
  userRadiusByPoint.set(pointKey(scope, lat, lon), { km, at: Date.now() });
  if (userRadiusByPoint.size > USER_RADIUS_MAX_POINTS) {
    const oldest = userRadiusByPoint.keys().next().value;
    if (oldest !== undefined) userRadiusByPoint.delete(oldest);
  }
}

// "dalej" bez continue_previous (test 2026-10-29, Sukiennice): model 2 z 5 razy
// wyslal "dalej" jako NOWE wyszukiwanie -> znowu pozycje 1-10, ktore agent podpisal
// jako 11-20 albo przenumerowal na 31-40. Krotka wiadomosc o kolejnych wynikach
// traktujemy wiec jako kontynuacje niezaleznie od flagi od modelu.

function recentUserRadius(scope: string, lat: number, lon: number): number | null {
  const e = userRadiusByPoint.get(pointKey(scope, lat, lon));
  if (!e || Date.now() - e.at > COORD_SNAP_MAX_AGE_MS) return null;
  e.at = Date.now();
  return e.km;
}

function snapToRecentPoint(scope: string, lat: number, lon: number): { lat: number; lon: number; snappedFromM: number | null } {
  const now = Date.now();
  for (let i = recentSearchPoints.length - 1; i >= 0; i--) {
    if (now - recentSearchPoints[i].at > COORD_SNAP_MAX_AGE_MS) recentSearchPoints.splice(i, 1);
  }
  let best: { scope: string; lat: number; lon: number; at: number } | null = null;
  let bestKm = Infinity;
  for (const p of recentSearchPoints) {
    if (p.scope !== scope) continue;
    const d = haversineKm(lat, lon, p.lat, p.lon);
    if (d < bestKm) { bestKm = d; best = p; }
  }
  if (best && bestKm === 0) {
    best.at = now;
    return { lat, lon, snappedFromM: null };
  }
  if (best && bestKm <= COORD_SNAP_MAX_KM) {
    best.at = now;
    return { lat: best.lat, lon: best.lon, snappedFromM: Math.round(bestKm * 1000) };
  }
  recentSearchPoints.push({ scope, lat, lon, at: now });
  if (recentSearchPoints.length > COORD_SNAP_MAX_POINTS) recentSearchPoints.shift();
  return { lat, lon, snappedFromM: null };
}

// Log pokazywanej paczki: pozycja, nazwa, gwiazdki, ocena/liczba opinii, cena.
// Pozwala porownac to, co agent napisal uzytkownikowi, z tym, co dostal
// (test 2026-10-29: w odpowiedzi agenta dwa hotele mialy identyczna ocene i
// liczbe opinii - podejrzenie przepisywania wartosci miedzy pozycjami).
function logBatchContents(label: string, hotels: any[], firstPosition: number): void {
  const lines = hotels.map(function (h, i) {
    return (h.position ?? firstPosition + i) + ". " + (h.name ?? "-") + " | " + (h.stars ?? "-") + "* | ocena " +
      (h.review_score ?? "-") + " (" + (h.review_count ?? "-") + " opinii) | " + (h.price_total ?? "-") + " " + (h.currency ?? "");
  });
  console.error("=== DIAG paczka " + label + ":\n" + lines.join("\n"));
}

// Minimalny odstep miedzy wydaniem paczki a prosba o kolejna. Prod
// 2026-10-22: model w JEDNEJ turze sam wolal continue_previous co 2 s
// (paczka 1 -> 2 -> 3) i wypisywal wszystkie 30 hoteli naraz. Czlowiek nie
// przeczyta 10 hoteli i nie napisze "dalej" w 8 s - wiec szybsza prosba to
// automatyczne dociaganie przez model, ktore blokujemy.
const MIN_MS_BETWEEN_BATCHES = 8000;

// Wydaje nastepna paczke z zapisanej listy - BEZ zapytan do Booking.com.
function serveNextBatch(key: string, entry: StoredResultSet, how: string): any {
  const pages = totalPages(entry);
  const total = entry.hotels.length;
  const nextPage = entry.lastServedPage + 1;
  const sinceLast = Date.now() - entry.lastAccess;
  if (sinceLast < MIN_MS_BETWEEN_BATCHES) {
    console.error("=== DIAG paging: continue_previous (" + how + "), klucz " + key + " - odrzucone, " + sinceLast +
      " ms po poprzedniej paczce (automatyczne dociaganie w tej samej turze).");
    const out = {
      status: "wait_for_user",
      message: "The next batch is served only after the user writes 'dalej'. The batch already received (positions " +
        ((entry.lastServedPage - 1) * entry.page_size + 1) + "-" +
        Math.min(entry.lastServedPage * entry.page_size, total) + " of " + total + ") is the complete answer for this " +
        "message; the user can write 'dalej' for the next " + entry.page_size + ".",
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  }
  entry.lastAccess = Date.now();
  if (nextPage > pages) {
    console.error("=== DIAG paging: continue_previous (" + how + "), klucz " + key + " - brak kolejnych (" +
      total + " hoteli juz pokazane).");
    const out = {
      status: "no_more_results",
      total_matching: total,
      location: entry.meta.location,
      message: "All " + total + " matching hotels have already been shown (positions 1-" + total + "). " +
        "Suggested reply: there are no more results for this search (no hotel list in this reply).",
    };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  }
  const batch = getPage(entry, nextPage);
  rememberSearchBatch((entry as any).scope ?? "", key, batch as any[]);
  entry.lastServedPage = nextPage;
  const from = (nextPage - 1) * entry.page_size + 1;
  const to = from + batch.length - 1;
  const remaining = total - to;
  console.error("=== DIAG paging: continue_previous (" + how + "), klucz " + key + ", paczka " + nextPage + "/" + pages +
    ", pozycje " + from + "-" + to + " z " + total + ": pierwszy=\"" + (batch[0]?.name ?? "-") +
    "\", ostatni=\"" + (batch[batch.length - 1]?.name ?? "-") + "\", bez zapytan do API.");
  logBatchContents(from + "-" + to, batch, from);
  const out: any = {
    success: true,
    batch: nextPage,
    total_batches: pages,
    showing_positions: from + "-" + to,
    total_matching: total,
    remaining: remaining,
    has_more: remaining > 0,
    hotels: batch,
    ...entry.meta,
    display_instruction: "Presentation: these " + batch.length + " hotels as a numbered list with each hotel's " +
      "'position' before its name (e.g. '" + from + ". Hotel ...'), positions " + from + "-" + to + ", in this order " +
      "and the same format as before, with names, prices and ratings from this response. " +
      (remaining > 0
        ? "After the list: " + remaining + " more remain ('dalej')."
        : "After the list: these were the last results of this search (all " + total + " shown)."),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(out) + "\n\n---\nSource: Booking.com API" }],
    structuredContent: out,
  };
}

// "dalej" bez parametrow wyszukiwania -> ostatnio uzywana lista z tego okna.
const CONTINUE_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000;

// === "DALEJ" Z DRYFEM PARAMETROW (v5, test 2026-10-29) ===
// Przy "dalej" model dopisal sort_by:"distance", ktorego nie bylo w pierwszym
// wyszukiwaniu -> inny klucz listy -> "lista wygasla" i nowe wyszukiwanie od
// pozycji 1, w innej kolejnosci. Dlatego przy chybieniu klucza szukamy
// niedawnej listy o tych samych parametrach istotnych dla ZAWARTOSCI listy
// (miejsce, promien, daty, goscie, filtry), pomijajac pola, ktore model gubi
// lub dopisuje przy "dalej" (sort_by, currency, city/country obok wspolrzednych).
const LOOSE_MATCH_IGNORED_FIELDS = ["sort_by", "currency", "city", "country"];
const savedLists: { key: string; loose: string; at: number }[] = [];
const SAVED_LISTS_MAX = 300;

function looseKeyOf(keyParams: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const k of Object.keys(keyParams).sort()) {
    if (LOOSE_MATCH_IGNORED_FIELDS.indexOf(k) !== -1) continue;
    const v = keyParams[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    copy[k] = v;
  }
  return JSON.stringify(copy);
}

function rememberSavedList(key: string, keyParams: Record<string, unknown>): void {
  const loose = looseKeyOf(keyParams);
  for (let i = savedLists.length - 1; i >= 0; i--) {
    if (savedLists[i].key === key) savedLists.splice(i, 1);
  }
  savedLists.push({ key, loose, at: Date.now() });
  if (savedLists.length > SAVED_LISTS_MAX) savedLists.shift();
}

function findLooseMatch(keyParams: Record<string, unknown>): string | null {
  const loose = looseKeyOf(keyParams);
  const now = Date.now();
  for (let i = savedLists.length - 1; i >= 0; i--) {
    const e = savedLists[i];
    if (now - e.at > CONTINUE_FALLBACK_MAX_AGE_MS) continue;
    if (e.loose === loose) return e.key;
  }
  return null;
}

type LandmarkResolution =
  | { kind: "point"; lat: number; lon: number; name: string; approximate: boolean }
  | { kind: "multiple"; candidates: string[] }
  | { kind: "none" }
  | { kind: "city_not_found"; message: string };

let landmarkClient: BookingApiClient | null = null;

// Ta sama logika co booking_find_landmark: jedno dopasowanie albo kilka wpisow
// tego samego miejsca (do LANDMARK_CLUSTER_DIAMETER_KM) -> punkt; kilka roznych
// miejsc -> pytanie do usera; brak -> geokodowanie zewnetrzne.
// === KILKA PROB PRZY NIEZNALEZIONYM MIEJSCU (05.11, Wroclaw: "blisko adresu ul. Weigla 5 -
// to jest 4 Szpital Wojskowy" - agent podal tylko "ul. Weigla 5", landmarku nie ma, geokodowanie
// nie trafilo, a druga nazwa z tej samej wiadomosci byla na liscie Booking.com) ===

async function resolveLandmarkForSearch(name: string, city: string, country: string, scope: string, userText?: string): Promise<LandmarkResolution> {
  const first = await resolveLandmarkOnce(name, city, country, scope);
  if (first.kind !== "none") return first;
  const tries: string[] = [];
  const stripped = name.replace(STREET_PREFIX_RE, "").trim();
  if (stripped && stripped !== name) tries.push(stripped);
  if (userText) tries.push(...alternativeNamesFromRequest(userText, name));
  for (const t of tries) {
    const r = await resolveLandmarkOnce(t, city, country, scope);
    console.error("=== DIAG landmark_name: proba \"" + t + "\" -> " + r.kind + ".");
    if (r.kind !== "none") return r;
  }
  return first;
}

async function resolveLandmarkOnce(name: string, city: string, country: string, scope: string): Promise<LandmarkResolution> {
  if (!landmarkClient) return { kind: "none" };
  const cityResult = await resolveCityId(landmarkClient, city, country, scope);
  if (!cityResult) return { kind: "city_not_found", message: await cityNotFoundMessage(landmarkClient, city, country) };
  const matches = await searchLandmarks(landmarkClient, cityResult.city_id, name, 10, cityResult.name, cityResult.name_variants);
  if (matches.length > 0) {
    const diameter = matches.length === 1 ? 0 : clusterDiameterKm(matches);
    if (diameter !== null && diameter <= LANDMARK_CLUSTER_DIAMETER_KM) {
      const c = getCoords(matches[0]);
      if (c) return { kind: "point", lat: c.lat, lon: c.lon, name: landmarkLabel(matches[0]), approximate: false };
    }
    return { kind: "multiple", candidates: matches.map(landmarkLabel) };
  }
  const geo = await geocodeAddress(name, cityResult.name);
  if (geo) return { kind: "point", lat: geo.latitude, lon: geo.longitude, name: name, approximate: true };
  return { kind: "none" };
}

export function registerHotelSearchTool(server: McpServer, client: BookingApiClient, ctx: RequestContext): void {
  const scope = ctx.chatId ?? "";
  landmarkClient = client;
  server.registerTool(
    "booking_search_hotels",
    {
      title: "Search Hotels on Booking.com",
      description: "Search available hotels on Booking.com in a city or around a point. Results come in batches of 10 together with notes on how to present them - follow every *_note / *_instruction field in the response.\nLOCATION: city + country for 'hotels in X' (city name in English, e.g. 'Warsaw'). For a named place (landmark, station, airport, address) pass landmark_name with city + country - the server finds the coordinates (also in follow-up messages: just pass the same landmark_name again). If the response says multiple_matches, ask the user which place they mean. Never type coordinates yourself. If the user names several areas at once ('centrum i Wola', 'Mokotów albo Ochota'), search the whole city (city + country, without landmark_name) or ask which area they prefer - do not pick one of them. If you are not sure a city name is right, call booking_search_cities; if it could be in more than one country, ask the user.\nRADIUS: pass radius_km only when the user gave a distance ('w promieniu 2 km', 'do 500 m' -> 0.5). For 'koło', 'w pobliżu', 'przy', 'near' omit it - the server uses 1 km and widens to 3 km when nothing is found.\nUSER_REQUEST: always copy the request you are handling, verbatim, into user_request.\nFOLLOW-UPS: results of earlier messages are not visible to you. When the user changes one thing ('teraz 4 gwiazdki', 'bez śniadania'), search again with everything the user asked for earlier in the conversation and change only that. Say which filter changed; if the list is the same, say so.\nNEXT BATCH: for 'dalej' / 'pokaż kolejne' call this tool again with the same parameters plus continue_previous:true - only in a new message, one batch per reply.\nFILTERS (enforced by the server):\n- 'hotele 3*' = min_stars 3 + exact_stars true; 'co najmniej 3*', '3+', 'od 3*' = exact_stars false.\n- breakfast_only true for 'ze śniadaniem', 'śniadanie w cenie', 'with breakfast': prices are then for offers with breakfast included (hotels without such an offer are left out). Without it prices are for the cheapest offer.\n- property types: the server reads them from user_request ('tylko hostele', 'apartament', 'pensjonat lub B&B') and shows only those types - never present other types as matching. exclude_hostels is true by default; false only if the user accepts hostels, apartments or guesthouses - then keep every other filter from the conversation (stars, price, rating, amenities) unchanged.\n- price limits are per night; amenities via required_facilities; ratings via min_review_score.\n- chain or brand ('hotele Marriott', 'tylko ibis', 'Hiltony') -> chain; never pick chain hotels from the list by their names yourself. Each hotel has 'brand' (e.g. 'Novotel (Accor)') - questions which chain a hotel belongs to are answered from it, not from Weco documents.\n- Zero results: explain which filter caused it (zero_results_breakdown) and ASK before relaxing a filter - never run a relaxed search on your own.\nDATES are optional - do not ask for them. 'dziś'/'today'/'jutro'/'tomorrow' = 1 night; the server computes these dates itself from user_request (Polish time). When omitted, the server reuses the dates given earlier in this conversation or uses sample dates about 3 months ahead; follow dates_note.\nPRESENTING: list every hotel of the batch numbered with its 'position': price, guest rating (or 'ocena niedostępna'), distance (when searching around a point), breakfast (free, or paid with the price), one 'Parking:' line (for parking_kind public_only: 'tylko parking publiczny, obiekt nie ma własnego') and the booking link. Then give the total number and mention 'dalej'. Use only data from this tool's response in this message - never invent hotels, prices or ratings and never show raw field names. Full details of one hotel: booking_get_hotel_details; check-in, reception or parking of several hotels already shown ('we wszystkich hotelach'): booking_get_shown_hotels_info.",
      inputSchema: SearchToolInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchToolInput) => searchHotels(params, null),
  );

  // (v4) Nazwana funkcja zamiast anonimowego handlera - automatyczne poszerzenie
  // promienia wywoluje ja ponownie z WidenContext.
  async function searchHotels(params: SearchToolInput, widen: WidenContext | null): Promise<any> {

      if (!widen && !params.continue_previous && typeof params.user_request === "string" &&
          isNextBatchRequest(params.user_request)) {
        params.continue_previous = true;
        console.error("=== DIAG paging: user_request \"" + params.user_request.trim() + "\" to prosba o kolejne " +
          "wyniki, a model nie ustawil continue_previous - ustawiam sam.");
      }

      // === landmark_name (2026-10-29, przeglad optymalizacji pkt 1) ===
      // Wczesniej kazda tura z miejscem to dwa kroki modelu: booking_find_landmark,
      // potem to narzedzie (w logach 2,5-3 s miedzy nimi). Teraz model moze podac
      // sama nazwe miejsca, a serwer ustala wspolrzedne (lista landmarkow miasta
      // z cache 24 h, potem geokodowanie). Niejednoznaczna nazwa -> pytanie do usera.
      let landmarkResolvedName: string | null = null;
      if (!widen && params.latitude == null && typeof params.landmark_name === "string" &&
          params.landmark_name.trim().length >= 2) {
        // Miasto z nazwy miejsca ("Krakow Plaszow Railway Station, Krakow, Poland") albo z ostatniego
        // wyszukiwania w tym czacie (31.10: agent po wyborze Plaszowa zapomnial pola city/country,
        // serwer odrzucil zapytanie, a user dostal liste z Dworca Glownego).
        if (!params.city || !params.country) {
          const parts = params.landmark_name.split(",").map((x) => x.trim()).filter(Boolean);
          const last = recentChatLocation(scope);
          if (parts.length >= 2) {
            params.landmark_name = parts[0];
            if (!params.city) params.city = parts[1];
            if (!params.country) {
              const fromName = parts.length >= 3 ? countryCodeFromName(parts[parts.length - 1]) : null;
              params.country = fromName ?? (last && normalizeText(last.city) === normalizeText(params.city) ? last.country : undefined);
            }
          }
          if ((!params.city || !params.country) && last) {
            if (!params.city) params.city = last.city;
            if (!params.country) params.country = last.country;
          }
          if (params.city && params.country) {
            console.error("=== DIAG landmark_name bez miasta od agenta - uzupelniam: city=\"" + params.city +
              "\", country=\"" + params.country + "\", miejsce=\"" + params.landmark_name + "\".");
          }
        }
        if (!params.city || !params.country) {
          return {
            content: [{ type: "text", text: "landmark_name needs city (in English) and country. Ask the user which city " +
              "the place is in, then search again." }],
            isError: true,
          };
        }
        const resolved = await resolveLandmarkForSearch(params.landmark_name.trim(), params.city, params.country, scope,
          typeof params.user_request === "string" ? params.user_request : undefined);
        if (resolved.kind === "point") {
          rememberChatLocation(scope, params.city, params.country);
          params.latitude = resolved.lat;
          params.longitude = resolved.lon;
          landmarkResolvedName = resolved.name;
          console.error("=== DIAG landmark_name: \"" + params.landmark_name + "\" -> " + resolved.name + " (" +
            resolved.lat + ", " + resolved.lon + ")" + (resolved.approximate ? ", geokodowanie zewnetrzne" : "") + ".");
        } else {
          console.error("=== DIAG landmark_name: \"" + params.landmark_name + "\" -> " + resolved.kind + ".");
          if (resolved.kind === "city_not_found") {
            return { content: [{ type: "text", text: resolved.message }], isError: true };
          }
          const out: any = resolved.kind === "multiple"
            ? {
              status: "multiple_matches",
              message: "Several places match \"" + params.landmark_name + "\". Suggested reply: a question which place " +
                "the user means (with the candidate names), without a hotel list. After the answer, search with " +
                "landmark_name set to the full name of the chosen place.",
              candidates: resolved.candidates,
            }
            : {
              status: "no_match",
              message: "Place \"" + params.landmark_name + "\" was not found in " + params.city + " (Booking.com landmarks " +
                "and general geocoding). Suggested reply: the place was not found - ask for another name or a nearby " +
                "well-known place.",
            };
          return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
        }
      }

      // === PROSBA O HOTELE PRZY MIEJSCU BEZ MIEJSCA (31.10) ===
      // Hotelowy (bez posredniego agenta MCP) wyslal "hotele przy stacji kolejowej w krakowie"
      // jako samo miasto - user dostal 86 hoteli z calego Krakowa (z lotniskiem na 1. miejscu).
      // Odsylamy agenta po landmark_name zamiast szukac po calym miescie. Raz na prosbe -
      // gdy agent wroci znow bez miejsca, szukamy po miescie (bez petli).
      if (!widen && !params.continue_previous && params.latitude == null && !params.landmark_name &&
          typeof params.user_request === "string" && NEAR_PLACE_RE.test(params.user_request)) {
        const guardKey = scope + "|" + params.user_request.trim().toLowerCase();
        const last = nearPlaceGuard.get(guardKey);
        if (!last || Date.now() - last > 60 * 1000) {
          nearPlaceGuard.set(guardKey, Date.now());
          if (nearPlaceGuard.size > 2000) {
            const oldest = nearPlaceGuard.keys().next().value;
            if (oldest !== undefined) nearPlaceGuard.delete(oldest);
          }
          console.error("=== DIAG miejsce: user_request wskazuje miejsce (\"" + params.user_request.slice(0, 120) +
            "\"), a agent nie podal landmark_name - odsylam po landmark_name zamiast szukac po calym miescie.");
          return {
            content: [{ type: "text", text: "The request is about hotels near a specific place (\"" +
              params.user_request.slice(0, 200) + "\"), but no landmark_name was given, so a search would cover the " +
              "whole city. Next step: booking_search_hotels with landmark_name set to that place (e.g. the " +
              "station, airport or monument named by the user) plus city and country." }],
            isError: true,
          };
        }
        console.error("=== DIAG miejsce: agent ponownie bez landmark_name - szukam po miescie.");
      }

      const usingCoordinates = params.latitude != null && params.longitude != null;

      if (usingCoordinates) {
        const reqLat = Number(params.latitude);
        const reqLon = Number(params.longitude);
        const snapped = snapToRecentPoint(scope, reqLat, reqLon);
        if (snapped.snappedFromM != null) {
          console.error("=== DIAG wspolrzedne: (" + reqLat + ", " + reqLon + ") dociagniete do niedawno uzytego " +
            "punktu (" + snapped.lat + ", " + snapped.lon + "), odchylenie " + snapped.snappedFromM + " m " +
            "(model najpewniej wpisal wspolrzedne z pamieci zamiast wywolac booking_find_landmark).");
          params.latitude = snapped.lat;
          params.longitude = snapped.lon;
        }
      }

      // KOLEJNOSC PRZY WYSZUKIWANIU KOLO MIEJSCA (2026-10-30, decyzja uzytkownika):
      // przy "4 km od Wawelu" popularnosc wstawiala hotel z 3,6 km na 1. miejsce,
      // a hotele 0,4-0,7 km trafialy na druga strone. Kolo punktu domyslnie od
      // najblizszego; inne sortowanie (cena, ocena, gwiazdki) zostaje bez zmian.
      if (usingCoordinates && (params.sort_by == null || params.sort_by === "popularity") &&
          !/popularn|popular/i.test(typeof params.user_request === "string" ? params.user_request : "")) {
        if (!widen && params.sort_by === "popularity") {
          console.error("=== DIAG sortowanie: wyszukiwanie kolo punktu - domyslnie od najblizszego (zamiast popularnosci).");
        }
        params.sort_by = "distance";
      }

      // PROMIEN DOMYSLNY (v4) - patrz komentarz przy DEFAULT_NEAR_RADIUS_KM.
      let radiusSource: "user" | "default" | "widened" = "user";
      const userText = typeof params.user_request === "string" ? params.user_request.trim() : "";
      if (userText) {
        console.error("=== DIAG user_request: \"" + userText.slice(0, 300) + "\"");
      } else {
        console.error("=== DIAG user_request: brak - promien i hostele wg pol od modelu.");
      }
      if (usingCoordinates) {
        const lat = Number(params.latitude);
        const lon = Number(params.longitude);
        if (widen) {
          radiusSource = "widened";
        } else if (userText) {
          const modelRadius = params.radius_km;
          const fromText = parseUserDistanceKm(userText);
          const earlier = fromText == null ? recentUserRadius(scope, lat, lon) : null;
          if (fromText != null) {
            params.radius_km = fromText;
            rememberUserRadius(scope, lat, lon, fromText);
            console.error("=== DIAG promien: " + fromText + " km z tekstu usera" +
              (modelRadius != null && modelRadius !== fromText ? " (model wyslal " + modelRadius + " km - pomijam)." : "."));
          } else if (earlier != null) {
            params.radius_km = earlier;
            console.error("=== DIAG promien: " + earlier + " km - odleglosc podana przez usera wczesniej dla tego punktu" +
              (modelRadius != null && modelRadius !== earlier ? " (model wyslal " + modelRadius + " km - pomijam)." : "."));
          } else {
            params.radius_km = DEFAULT_NEAR_RADIUS_KM;
            radiusSource = "default";
            console.error("=== DIAG promien: brak odleglosci w tekscie usera - promien domyslny " + DEFAULT_NEAR_RADIUS_KM +
              " km" + (modelRadius != null ? " (model wyslal " + modelRadius + " km - pomijam)." : "."));
          }
        } else if (params.radius_km == null) {
          params.radius_km = DEFAULT_NEAR_RADIUS_KM;
          radiusSource = "default";
          console.error("=== DIAG promien: brak radius_km od modelu - promien domyslny " + DEFAULT_NEAR_RADIUS_KM + " km.");
        } else {
          console.error("=== DIAG promien: radius_km=" + params.radius_km + " podany przez model" +
            (Number(params.radius_km) === DEFAULT_NEAR_RADIUS_KM
              ? " (rowny domyslnemu - przy 0 wynikow poszerzam do " + WIDENED_RADIUS_KM + " km)."
              : " - bez poszerzania."));
        }
      }
      // (v5) Test 2026-10-29: dla "koło lotniska Balice" model wyslal radius_km:1
      // sam z siebie (powtorzyl domyslny promien z poprzedniej odpowiedzi), wiec
      // poszerzenie sie nie wlaczylo. Serwer nie odrozni takiego 1 km od "w promieniu
      // 1 km" usera - dlatego 0 wynikow przy 1 km zawsze poszerza do 3 km (z informacja
      // dla usera). Inne promienie podane przez model (0.5, 2, 5...) nie sa poszerzane.
      const widenEligible = usingCoordinates && !widen &&
        Number(params.radius_km) === DEFAULT_NEAR_RADIUS_KM && DEFAULT_NEAR_RADIUS_KM < WIDENED_RADIUS_KM;

      // (v6) Hostele/apartamenty tylko gdy user o nie prosi (Sukiennice 2026-10-29:
      // "hotele w promieniu 1 km" -> model wyslal exclude_hostels:false).
      const typeRequest = requestedAccommodationTypes(userText);
      // "bez hosteli", "nie apartament" - zaprzeczony typ nie jest prosba o ten typ
      const userTextNoNegations = userText.replace(NEGATED_TYPE_RE, " ");
      if (userText && params.exclude_hostels === false && !typeRequest && !OTHER_ACCOMMODATION_RE.test(userTextNoNegations)) {
        params.exclude_hostels = true;
        console.error("=== DIAG exclude_hostels: model wyslal false, ale tekst usera nie wspomina hosteli/apartamentow - wymuszam true.");
      }
      if (typeRequest) {
        // Filtr typow zastepuje "tylko hotele" (hotele sa w nim, jesli user o nie prosi).
        params.exclude_hostels = false;
        if (!widen) {
          console.error("=== DIAG typy obiektow z prosby: " + typeRequest.labels.join(", ") + " (typy Booking.com: " +
            typeRequest.types.join(",") + ").");
        }
      } else if (userText && params.exclude_hostels !== false && OTHER_ACCOMMODATION_RE.test(userTextNoNegations)) {
        params.exclude_hostels = false;
        if (!widen) console.error("=== DIAG exclude_hostels: user pyta o dowolne / inne obiekty noclegowe - wszystkie typy.");
      }

      // === SNIADANIE (02.11, zgloszenie: Green Garden w Raszynie) ===
      // Wyszukiwanie zwraca jedna (najtansza) oferte hotelu - 365 zl bez sniadania,
      // choc Booking.com ma tez 427 zl ze sniadaniem w cenie. "ze sniadaniem" i
      // "sniadanie w cenie" = filtr: Booking.com zwraca wtedy ceny ofert ze sniadaniem
      // (meal_plan: breakfast_included, test 02.11). Tekst usera rozstrzyga.
      if (userText && !params.continue_previous) {
        const bi = breakfastIntent(userText);
        if (bi === "off") {
          if (params.breakfast_only) console.error("=== DIAG sniadanie: \"bez sniadania\" w tekscie usera - wylaczam filtr.");
          params.breakfast_only = false;
        } else if (bi === "on" && !params.breakfast_only) {
          params.breakfast_only = true;
          console.error("=== DIAG sniadanie: tekst usera wspomina sniadanie - ceny ofert ze sniadaniem w cenie (meal_plan).");
        }
      }

      // === UDOGODNIENIA (09.11): synonimy -> klucze filtra, nieznane pomijamy i mowimy o nich agentowi ===
      const facilitiesNorm = normalizeFacilities(params.required_facilities);
      const unsupportedFilters = facilitiesNorm.unsupported;
      params.required_facilities = facilitiesNorm.known.length > 0 ? facilitiesNorm.known : undefined;
      if (unsupportedFilters.length > 0 && !widen) {
        console.error("=== OSTRZEZENIE udogodnienia: nie umiem filtrowac po " + JSON.stringify(unsupportedFilters) +
          " - szukam bez nich (do uzupelnienia mapowania).");
      }

      // === UDOGODNIENIA DLA DZIECI Z TRESCI PROSBY (10.11) - jak parking ponizej ===
      if (userText) {
        const kids = kidsFacilitiesFromText(userText).filter((k) => !(params.required_facilities ?? []).includes(k));
        if (kids.length > 0) {
          params.required_facilities = [...(params.required_facilities ?? []), ...kids];
          if (!widen) console.error("=== DIAG dzieci: tekst usera wspomina " + kids.join(", ") + " - dokladam do required_facilities.");
        }
      }

      // === PARKING Z TRESCI PROSBY (05.11, Wroclaw: w drugim wywolaniu agent zgubil
      // required_facilities=parking, choc prosba "ze sniadaniem i parkingiem" przyszla w calosci) ===
      if (userText && !params.continue_previous) {
        const has = (params.required_facilities ?? []).includes("parking");
        if (wantsParking(userText) && !has) {
          params.required_facilities = [...(params.required_facilities ?? []), "parking"];
          console.error("=== DIAG parking: tekst usera wspomina parking, a agent nie podal filtra - dokladam required_facilities=parking.");
        }
      }

      // "dalej" bez miasta/wspolrzednych: model czesto wysyla SAMO
      // continue_previous:true (test 2026-10-22). Bierzemy ostatnio uzywana liste.
      if (params.continue_previous && !usingCoordinates && (!params.city || !params.country)) {
        const recent = getMostRecentResultSet(CONTINUE_FALLBACK_MAX_AGE_MS, scope);
        if (recent) {
          return serveNextBatch(recent.key, recent.entry, "ostatnia lista - bez parametrow");
        }
        console.error("=== DIAG paging: continue_previous bez parametrow i brak aktywnej listy.");
        const out = {
          status: "no_previous_list",
          message: "There is no active result list to continue (it expired or the server restarted), so there are no " +
            "hotels to show from it. Next step: booking_search_hotels with the full parameters of the user's search " +
            "(place, dates, filters) without continue_previous; the list then starts again from position 1.",
        };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      }

      if (!usingCoordinates && (!params.city || !params.country)) {
        return {
          content: [{
            type: "text",
            text: "Error: provide either city + country, or latitude + longitude.",
          }],
          isError: true,
        };
      }

      // === POBYT (09.11): daty i goscie ze wspolnego kontekstu (services/stayContext.ts) -
      // agent -> tresc prosby -> pamiec rozmowy -> domyslne. Przy poszerzaniu promienia (widen)
      // liczone ponownie z tych samych danych, bez logu.
      const stay = resolveStay(scope, params, "wyszukiwanie", { quiet: !!widen });
      if (stay.pastError) {
        return { content: [{ type: "text", text: stay.pastError }], isError: true };
      }
      // (przeglad pkt 11) Booking.com liczy cene dzieci tylko z ich wieku - sama liczba dzieci
      // bez wieku dawala cicho cene dla samych doroslych.
      if (!params.continue_previous && stay.children_without_age > 0) {
        return { content: [{ type: "text", text: childAgesQuestion(stay) }], isError: true };
      }
      params.adults = stay.adults;
      params.rooms = stay.rooms;
      params.children_ages = stay.children_ages.length > 0 ? stay.children_ages : undefined;
      params.children_count = stay.children_ages.length > 0 ? stay.children_ages.length : undefined;

      let checkin = stay.checkin;
      let checkout = stay.checkout;
      let datesAssumed = false;
      const datesFromChat = stay.dates_source === "rozmowa";

      if (!checkin || !checkout) {
        const defaults = getDefaultDates();
        checkin = checkin ?? defaults.checkin;
        checkout = checkout ?? defaults.checkout;
        datesAssumed = true;
      }

      const checkinDate = new Date(checkin);
      const checkoutDate = new Date(checkout);

      if (checkoutDate <= checkinDate) {
        return {
          content: [{ type: "text", text: "Error: checkout must be after checkin." }],
          isError: true,
        };
      }

      const nights = Math.round((checkoutDate.getTime() - checkinDate.getTime()) / 86400000);

      // Klucz listy = parametry wyszukiwania (bez continue_previous i results_limit).
      const keyParams = {
        // Czat - ta sama lista u dwoch konsultantow to dwie osobne listy (wlasny licznik paczek).
        scope: scope || undefined,
        city: params.city, country: params.country,
        latitude: params.latitude != null ? Number(params.latitude).toFixed(5) : undefined,
        longitude: params.longitude != null ? Number(params.longitude).toFixed(5) : undefined,
        radius_km: params.latitude != null ? params.radius_km : undefined,
        checkin: checkin, checkout: checkout,
        adults: params.adults, rooms: params.rooms, children_ages: params.children_ages,
        currency: params.currency,
        min_price_per_night: params.min_price_per_night, max_price_per_night: params.max_price_per_night,
        min_review_score: params.min_review_score, min_stars: params.min_stars, exact_stars: params.exact_stars ?? false,
        exclude_hostels: params.exclude_hostels, required_facilities: params.required_facilities,
        chain: params.chain ? normalizeText(params.chain) : undefined,
        breakfast_only: params.breakfast_only, free_cancellation_only: params.free_cancellation_only,
        sort_by: params.sort_by,
        accommodation_types: typeRequest ? typeRequest.types.join(",") : undefined,
      };
      const searchKey = makeSearchKey(keyParams);

      let continuationExpired = widen ? widen.continuationExpired : false;
      if (params.continue_previous) {
        const entry = getResultSet(searchKey);
        if (entry) {
          return serveNextBatch(searchKey, entry, "po parametrach");
        }
        // "dalej" po automatycznym poszerzeniu: model znow wysyla 1 km albo pomija
        // radius_km, wiec klucz wyszedl dla 1 km, a lista jest zapisana dla 3 km.
        const candidates: { params: Record<string, unknown>; how: string }[] = [
          { params: keyParams, how: "luzne dopasowanie parametrow" },
        ];
        if (widenEligible) {
          const widenedParams = { ...keyParams, radius_km: WIDENED_RADIUS_KM };
          const widenedKey = makeSearchKey(widenedParams);
          const widenedEntry = getResultSet(widenedKey);
          if (widenedEntry) {
            return serveNextBatch(widenedKey, widenedEntry, "po parametrach, lista poszerzona do " + WIDENED_RADIUS_KM + " km");
          }
          candidates.push({ params: widenedParams, how: "luzne dopasowanie, lista poszerzona do " + WIDENED_RADIUS_KM + " km" });
          const farParams = { ...keyParams, radius_km: FAR_RADIUS_KM };
          const farKey = makeSearchKey(farParams);
          const farEntry = getResultSet(farKey);
          if (farEntry) {
            return serveNextBatch(farKey, farEntry, "po parametrach, lista poszerzona do " + FAR_RADIUS_KM + " km");
          }
          candidates.push({ params: farParams, how: "luzne dopasowanie, lista poszerzona do " + FAR_RADIUS_KM + " km" });
        }
        for (const c of candidates) {
          const looseKey = findLooseMatch(c.params);
          const looseEntry = looseKey ? getResultSet(looseKey) : undefined;
          if (looseKey && looseEntry) {
            console.error("=== DIAG paging: klucz " + searchKey + " nie istnieje (model zmienil pole pomijane przy " +
              "dopasowaniu: " + LOOSE_MATCH_IGNORED_FIELDS.join("/") + ") - kontynuuje liste " + looseKey + ".");
            return serveNextBatch(looseKey, looseEntry, c.how);
          }
        }
        continuationExpired = true;
        console.error("=== DIAG paging: continue_previous, klucz " + searchKey +
          " - brak zapisanej listy (wygasla, restart albo zmienione parametry) - wykonuje nowe wyszukiwanie.");
      }

      let locationPart: any;
      let locationLabel: string;
      let cityIdForOutput: number | null = null;

      if (usingCoordinates) {
        locationPart = {
          coordinates: {
            latitude: params.latitude,
            longitude: params.longitude,
            radius: params.radius_km,
          },
        };
        locationLabel = (landmarkResolvedName ? landmarkResolvedName + " " : "") + "point (" + params.latitude + ", " +
          params.longitude + "), radius " + params.radius_km + " km";
      } else {
        const cityResult = await resolveCityId(client, params.city!, params.country!, scope);
        if (!cityResult) {
          return {
            content: [{
              type: "text",
              text: await cityNotFoundMessage(client, params.city!, params.country!),
            }],
            isError: true,
          };
        }
        rememberChatLocation(scope, params.city!, params.country!);
        locationPart = { city: cityResult.city_id };
        locationLabel = cityResult.name;
        cityIdForOutput = cityResult.city_id;
      }

      // === WAZNE (2026-09-11) - "sort" NIE JEST wysylane do Booking.com API ===
      // Potwierdzono empirycznie: wysylanie "sort":{"by":"price",...} w request
      // body do /accommodations/search powoduje, ze Booking.com API zwraca
      // WEZSZA, INNA pule wynikow niz przy tym samym zapytaniu BEZ "sort" - nie
      // tylko w innej kolejnosci, ale z BRAKUJACYMI prawdziwymi hotelami (np.
      // "Mercure Warszawa Grand", "NYX Hotel Warsaw" znikaly calkowicie z
      // surowej odpowiedzi API, gdy dodano sort=price, mimo identycznej
      // lokalizacji/promienia/ratingu). W polaczeniu z exclude_hostels dawalo
      // to falszywe "0 hoteli" dla lokalizacji, gdzie realnie jest ich kilkanascie.
      // Dlatego NIGDY nie budujemy i nie wysylamy pola "sort" do API - zawsze
      // pobieramy dane w domyslnej kolejnosci (ktora, jak potwierdzono, zwraca
      // pelna, poprawna pule wynikow), a sortowanie wykonujemy WYLACZNIE
      // lokalnie (patrz "local re-sort safeguard" nizej).

      const maxTotalPrice = params.max_price_per_night != null
        ? Math.round(params.max_price_per_night * nights * 100) / 100
        : undefined;
      const minTotalPrice = params.min_price_per_night != null
        ? Math.round(params.min_price_per_night * nights * 100) / 100
        : undefined;
      let pricePart: any = undefined;
      if (maxTotalPrice != null || minTotalPrice != null) {
        pricePart = {};
        if (minTotalPrice != null) pricePart.minimum = minTotalPrice;
        if (maxTotalPrice != null) pricePart.maximum = maxTotalPrice;
      }

      let ratingPart: any = undefined;
      if (params.min_review_score != null || params.min_stars != null) {
        ratingPart = {};
        if (params.min_review_score != null) ratingPart.minimum_review_score = Math.ceil(params.min_review_score);
        if (params.min_stars != null) {
          if (params.exact_stars) {
            ratingPart.stars = [params.min_stars];
          } else {
            const starsArr: number[] = [];
            for (let s = params.min_stars; s <= 5; s++) starsArr.push(s);
            ratingPart.stars = starsArr;
          }
        }
      }

      const hasStrongFilters = !!(
        maxTotalPrice != null || minTotalPrice != null ||
        params.min_review_score != null ||
        (params.required_facilities && params.required_facilities.length > 0) ||
        params.exclude_hostels ||
        params.breakfast_only ||
        params.free_cancellation_only
      );

      try {
        const guestsPart: any = {
          number_of_adults: params.adults,
          number_of_rooms: params.rooms,
        };
        if (params.children_ages != null && params.children_ages.length > 0) {
          guestsPart.children = params.children_ages;
        }

        const request: any = {
          booker: { country: DEFAULT_BOOKER_COUNTRY, platform: DEFAULT_BOOKER_PLATFORM },
          checkin: checkin,
          checkout: checkout,
          guests: guestsPart,
          currency: params.currency,
          // Zawsze pelna pula (100) - wyniki sa podawane paczkami z resultStore,
          // wiec liczba pobranych hoteli nie zalezy juz od results_limit.
          rows: rowsToFetch(usingCoordinates, 100, hasStrongFilters),
          extras: ["products"],
          ...locationPart,
        };
        // "sort" celowo NIE jest dodawane do request - patrz komentarz powyzej.
        if (pricePart) request.price = pricePart;
        if (ratingPart) request.rating = ratingPart;
        // Booking.com zwraca wtedy oferty ze sniadaniem w cenie (ich ceny), a hotele bez takiej oferty pomija.
        if (params.breakfast_only) request.meal_plan = "breakfast_included";

        const result = await client.searchAccommodations(request);

        if (params.required_facilities?.length && result.facilities_fetch_failed) {
          return {
            content: [{
              type: "text",
              text: "Nie udało się pobrać danych o udogodnieniach z Booking.com API w tej chwili " +
                "(problem techniczny, nie brak takich hoteli), więc nie mogę wiarygodnie przefiltrować " +
                "po: " + params.required_facilities.join(", ") + ". Spróbuj ponownie za chwilę.",
            }],
            isError: true,
          };
        }

        // Analogicznie do facilities: jesli user poprosil o filtr po ocenie, a
        // ocen nie udalo sie pobrac, NIE wolno cicho przepuscic wszystkiego -
        // opis narzedzia obiecuje, ze filtry sa twarde, a model na tym polega.
        if (params.min_review_score != null && result.reviews_fetch_failed) {
          return {
            content: [{
              type: "text",
              text: "Nie udało się pobrać ocen gości z Booking.com API w tej chwili " +
                "(problem techniczny, nie brak takich hoteli), więc nie mogę wiarygodnie " +
                "przefiltrować po min_review_score >= " + params.min_review_score +
                ". Spróbuj ponownie za chwilę.",
            }],
            isError: true,
          };
        }

        console.error("=== CHECKPOINT: dane pobrane, " + result.hotels.length +
          " hoteli, rozpoczynam filtrowanie...");
        if (result.truncated) {
          console.error("=== OSTRZEZENIE: lista niekompletna - Booking.com mial wiecej niz " + result.hotels.length +
            " obiektow (" + result.pages_fetched + " stron).");
        }

        const stepBreakdown: { step: string; count: number }[] = [];

        let hotels = result.hotels;
        stepBreakdown.push({ step: "found_in_location", count: hotels.length });

        if (maxTotalPrice != null) {
          hotels = hotels.filter(function (h) { return h.price != null && h.price.amount <= maxTotalPrice; });
          stepBreakdown.push({ step: "after_max_price", count: hotels.length });
        }
        if (minTotalPrice != null) {
          hotels = hotels.filter(function (h) { return h.price != null && h.price.amount >= minTotalPrice; });
          stepBreakdown.push({ step: "after_min_price", count: hotels.length });
        }

        if (params.min_review_score != null) {
          // TWARDY filtr. Wczesniejszy warunek "if (filtered.length > 0 || ...)"
          // powodowal, ze przy braku ocen (a oceny nie byly w ogole pobierane do
          // 2026-09-22) filtr NIE robil nic i zwracal pelna liste, choc opis
          // narzedzia zapewnia model, ze filtry sa wymuszane po stronie serwera.
          // Teraz, gdy oceny sa realnie pobierane, filtr musi byc bezwarunkowy -
          // pusty wynik jest uczciwie wyjasniany przez zero_results_breakdown.
          const beforeReview = hotels.length;
          hotels = hotels.filter(function (h) {
            return h.review_score != null && h.review_score >= params.min_review_score!;
          });
          console.error("=== DIAG min_review_score>=" + params.min_review_score + ": " +
            beforeReview + " -> " + hotels.length + " hoteli.");
          stepBreakdown.push({ step: "after_min_review_score", count: hotels.length });
        }

        if (params.min_stars) {
          // TWARDY filtr. Wczesniejszy warunek "if (filtered.length > 0)" powodowal,
          // ze gdy filtr gwiazdek wyzerowalby liste, byl CICHO POMIJANY i user
          // dostawal hotele niespelniajace kryterium - a filters_applied_note
          // nadal zapewnialo "Filters enforced server-side (guaranteed accurate)".
          // Konsultant prosil o 5 gwiazdek, dostawal 3-gwiazdkowe i potwierdzenie,
          // ze filtr zadzialal. Po tej zmianie WSZYSTKIE filtry w tym pliku sa
          // faktycznie twarde, a pusty wynik wyjasnia zero_results_breakdown.
          const beforeStars = hotels.length;
          hotels = hotels.filter(function (h) {
            if (h.star_rating == null) return false;
            return params.exact_stars
              ? h.star_rating === params.min_stars
              : h.star_rating >= params.min_stars!;
          });
          console.error("=== DIAG min_stars" + (params.exact_stars ? "==" : ">=") +
            params.min_stars + ": " + beforeStars + " -> " + hotels.length + " hoteli.");
          stepBreakdown.push({ step: "after_stars", count: hotels.length });
        }

        if (params.exclude_hostels) {
          const beforeExclusion = hotels.length;
          const rejectedTypes: Record<string, number> = {};
          for (const h of hotels) {
            if (h.accommodation_type_id != null && !ALLOWED_HOTEL_ACCOMMODATION_TYPES.has(h.accommodation_type_id)) {
              rejectedTypes[h.accommodation_type_id] = (rejectedTypes[h.accommodation_type_id] ?? 0) + 1;
            }
          }
          hotels = hotels.filter(function (h) {
            return h.accommodation_type_id == null || ALLOWED_HOTEL_ACCOMMODATION_TYPES.has(h.accommodation_type_id);
          });
          console.error("=== DIAG exclude_hostels: " + beforeExclusion + " -> " + hotels.length +
            " hoteli (dozwolone typy: 204 hotel, 205 motel, 206 resort, 218 zajazd, 231 hotel ekonomiczny; odrzucone typy: " +
            JSON.stringify(rejectedTypes) + ").");
          stepBreakdown.push({ step: "after_exclude_hostels_apartments_villas", count: hotels.length });
        }

        if (typeRequest) {
          const beforeTypes = hotels.length;
          const wanted = new Set(typeRequest.types);
          const includesHotels = typeRequest.labels.includes("hotele");
          const rejected: Record<string, number> = {};
          hotels = hotels.filter(function (h) {
            // obiekt bez typu w danych - zostaje tylko, gdy user chce tez hoteli (jak w filtrze "tylko hotele")
            const ok = h.accommodation_type_id == null ? includesHotels : wanted.has(h.accommodation_type_id);
            if (!ok) rejected[String(h.accommodation_type_id)] = (rejected[String(h.accommodation_type_id)] ?? 0) + 1;
            return ok;
          });
          console.error("=== DIAG typy obiektow: " + beforeTypes + " -> " + hotels.length + " (" + typeRequest.labels.join(", ") +
            "; odrzucone typy: " + JSON.stringify(rejected) + ").");
          stepBreakdown.push({ step: "after_accommodation_types (" + typeRequest.labels.join(", ") + ")", count: hotels.length });
        }

        // === SIEC / MARKA (02.11, "hotele Marriott kolo NEC" - agent dorzucil Novotel) ===
        if (params.chain) {
          const chainSet = await brandIdsForChain(params.chain);
          if (!chainSet) {
            return {
              content: [{ type: "text", text: "Booking.com has no hotel chain or brand named \"" + params.chain +
                "\". Suggested reply: the chain was not recognised - a question about the exact chain or brand name." }],
              isError: true,
            };
          }
          const beforeChain = hotels.length;
          hotels = hotels.filter(function (h) {
            const brands = result.details_by_id?.get(h.hotel_id)?.brands;
            return Array.isArray(brands) && brands.some(function (b: any) { return chainSet.ids.has(b); });
          });
          console.error("=== DIAG siec: \"" + params.chain + "\" -> " + chainSet.label + " (" + chainSet.ids.size +
            " marek): " + beforeChain + " -> " + hotels.length + " hoteli.");
          stepBreakdown.push({ step: "after_chain", count: hotels.length });
        }

        if (params.required_facilities && params.required_facilities.length > 0) {
          const beforeCount = hotels.length;
          const rejectedSample: any[] = [];
          hotels = hotels.filter(function (h) {
            if (!h.facilities) {
              if (rejectedSample.length < 5) rejectedSample.push({ hotel_id: h.hotel_id, name: h.name, facilities: null });
              return false;
            }
            const ok = params.required_facilities!.every(function (amenity) {
              const ids = AMENITY_FACILITY_IDS[amenity];
              if (!ids) {
                console.error("=== OSTRZEZENIE booking_search_hotels: nieznana wartosc " +
                  "required_facilities=\"" + amenity + "\" - brak mapowania w AMENITY_FACILITY_IDS. " +
                  "Sprawdz zgodnosc ze schema (inputSchemas.ts). Dostepne klucze: " +
                  Object.keys(AMENITY_FACILITY_IDS).join(", "));
                return false;
              }
              return ids.some(function (id) { return h.facilities!.includes(id); });
            });
            if (!ok && rejectedSample.length < 5) {
              rejectedSample.push({ hotel_id: h.hotel_id, name: h.name, facilities: h.facilities });
            }
            return ok;
          });
          console.error("=== DIAG required_facilities=" + params.required_facilities.join(",") +
            " zredukowal wyniki z " + beforeCount + " do " + hotels.length +
            ". Sprawdzane ID: " + JSON.stringify(params.required_facilities.map(a => ({ [a]: AMENITY_FACILITY_IDS[a] }))) +
            ". Probka odrzuconych (realne facilities ID z API): " + JSON.stringify(rejectedSample));
          stepBreakdown.push({ step: "after_required_facilities", count: hotels.length });
        }

        if (params.breakfast_only) {
          const beforeBreakfast = hotels.length;
          const filtered = hotels.filter(function (h) {
            return h.meal_plans && h.meal_plans.some(function (mp) {
              return mp.code === "breakfast_included" ||
                (mp.name != null && mp.name.toLowerCase().indexOf("breakfast") !== -1);
            });
          });
          console.error("=== DIAG breakfast_only: " + beforeBreakfast + " -> " + filtered.length +
            " hoteli. Przyklad meal_plans z odrzuconych: " +
            JSON.stringify(hotels.filter(function (h) { return filtered.indexOf(h) === -1; })
              .slice(0, 5)
              .map(function (h) { return { hotel_id: h.hotel_id, name: h.name, meal_plans: h.meal_plans, breakfast_price_paid: h.breakfast_price_paid }; })));
          hotels = filtered;
          stepBreakdown.push({ step: "after_breakfast_only_free", count: hotels.length });
        }

        if (params.free_cancellation_only) {
          const beforeCancellation = hotels.length;
          const filtered = hotels.filter(function (h) { return h.free_cancellation === true; });
          console.error("=== DIAG free_cancellation_only: " + beforeCancellation + " -> " + filtered.length +
            " hoteli. Przyklad free_cancellation z odrzuconych: " +
            JSON.stringify(hotels.filter(function (h) { return filtered.indexOf(h) === -1; })
              .slice(0, 5)
              .map(function (h) { return { hotel_id: h.hotel_id, name: h.name, free_cancellation: h.free_cancellation }; })));
          hotels = filtered;
          stepBreakdown.push({ step: "after_free_cancellation_only", count: hotels.length });
        }

        const distanceById = new Map<number, number>();
        if (usingCoordinates) {
          for (const h of hotels) {
            const lat = h.location?.latitude;
            const lon = h.location?.longitude;
            if (typeof lat === "number" && typeof lon === "number") {
              distanceById.set(h.hotel_id, haversineKm(params.latitude!, params.longitude!, lat, lon));
            }
          }
        }

        // === ZABEZPIECZENIE SORTOWANIA (2026-09-11) ===
        // Skoro "sort" nigdy nie jest wysylane do Booking.com API (patrz
        // komentarz przy budowaniu request wyzej), TO sortowanie jest
        // WYLACZNIE lokalne i jedyne zrodlo prawdy o kolejnosci wynikow.
        const beforeSortOrder = hotels.map((h) => h.hotel_id);
        if (params.sort_by === "distance" && usingCoordinates) {
          hotels = hotels.slice().sort(function (a, b) {
            const da = distanceById.has(a.hotel_id) ? distanceById.get(a.hotel_id)! : Infinity;
            const db = distanceById.has(b.hotel_id) ? distanceById.get(b.hotel_id)! : Infinity;
            return da - db;
          });
        } else if (params.sort_by === "price" || params.sort_by === "review_score" || params.sort_by === "stars") {
          hotels = hotels.slice().sort(function (a, b) {
            return compareForSort(a, b, params.sort_by);
          });
        }
        if (params.sort_by) {
          console.error("=== DIAG local re-sort safeguard (sort_by=" + params.sort_by +
            "): kolejnosc PRZED=" + JSON.stringify(beforeSortOrder) +
            " PO=" + JSON.stringify(hotels.map((h) => h.hotel_id)));
        }

        // Jesli sortujemy po ocenie, a zaden hotel oceny nie ma, kolejnosc jest
        // przypadkowa. Zamiast udawac posortowana liste - powiedzmy to wprost.
        const hotelsWithScore = hotels.filter(function (h) { return h.review_score != null; }).length;
        const reviewSortUnreliable = params.sort_by === "review_score" && hotelsWithScore === 0;
        if (reviewSortUnreliable) {
          console.error("=== OSTRZEZENIE: sort_by=review_score, ale zaden z " + hotels.length +
            " hoteli nie ma oceny (reviews_fetch_failed=" + String(result.reviews_fetch_failed) +
            ") - kolejnosc NIE odzwierciedla ocen.");
        }

        const currency = result.currency ?? params.currency;
        console.error("=== CHECKPOINT: filtrowanie zakonczone, " + hotels.length +
          " hoteli pozostalo, formatuje odpowiedz...");
        // PACZKI (2026-10-21): formatujemy CALA przefiltrowana i posortowana
        // liste, zapisujemy ja w resultStore, a modelowi oddajemy tylko pierwsza
        // paczke. Wczesniej 55 hoteli przekraczalo CHARACTER_LIMIT (JSON ucinany
        // "...[truncated]") i limit odpowiedzi agenta - model pisal "lista
        // wszystkich 55" i wstawial "...". Kolejne paczki: to samo wyszukiwanie + continue_previous,
        // bez zapytan do Booking.com.
        const allFormatted = hotels.map(function (h) {
          const fh = formatHotel(h, currency);
          // 06.11 (Julia): "Sniadanie w cenie (doplata: 58 PLN)" - cena oferty juz ze sniadaniem,
          // a breakfast_price_paid to cena sniadania dokupowanego do oferty bez sniadania.
          if (fh.breakfast_included) fh.breakfast_price_paid = null;
          const d = distanceById.get(h.hotel_id);
          fh.distance_km = d != null ? Math.round(d * 10) / 10 : null;
          return fh;
        });
        // results_limit < paczki (np. "5 najlepszych") zmniejsza paczke i cala liste.
        const pageSize = Math.min(RESULT_PAGE_SIZE, params.results_limit ?? RESULT_PAGE_SIZE);
        const limitedAll = params.results_limit != null && params.results_limit < RESULT_PAGE_SIZE
          ? allFormatted.slice(0, params.results_limit)
          : allFormatted;
        // PARKING DLA LISTY (2026-10-29, zgloszenie Julii z 2026-10-28) - patrz
        // fetchParkingSummaries w hotelDetails.ts. Decyzja dzialu HTL: parking
        // ZAWSZE w wynikach, z wyraznym oznaczeniem parkingu tylko publicznego.
        // Dociagamy parking dla CALEJ listy (nie tylko paczki 1), bo kolejne
        // paczki ida z resultStore bez zapytan do API. allFormatted ma te same
        // indeksy co hotels (map), a limitedAll to jego poczatek - stad
        // hotel_id z hotels[i]. Koszt: 1 zapytanie /details (~90 ms, test 2026-10-29).
        // Marka/siec przy kazdym hotelu (z /details pobranego przy wyszukiwaniu).
        for (let i = 0; i < limitedAll.length; i++) {
          (limitedAll[i] as any).brand = await brandLabel(result.details_by_id?.get(hotels[i].hotel_id)?.brands);
        }

        let parkingFetchFailed = false;
        if (limitedAll.length > 0) {
          const ids = limitedAll.map(function (_h, i) { return hotels[i].hotel_id; });
          const parking = await fetchParkingSummaries(ids, result.details_by_id);
          parkingFetchFailed = parking.failed;
          limitedAll.forEach(function (fh: any, i) {
            const info = parking.byId.get(hotels[i].hotel_id);
            if (info) {
              fh.parking_summary = info.summary;
              fh.parking_kind = info.kind;
            } else {
              fh.parking_summary = parking.failed
                ? "Nie udało się pobrać danych o parkingu (problem techniczny) - sprawdź w szczegółach obiektu."
                : "Brak informacji o parkingu w Booking.com.";
              fh.parking_kind = "unknown";
            }
          });
        }

        // "position" (1..N) - te same numery, ktore resultStore nadaje calej liscie.
        const formatted = limitedAll.slice(0, pageSize).map(function (h, i) { return { position: i + 1, ...h }; });
        rememberSearchBatch(scope, searchKey, formatted as any[]);

        // Budujemy active_search_state NIEZALEZNIE od tego, czy wynik jest
        // pusty czy nie - potrzebny w OBU przypadkach, zeby model mial
        // pelny stan do skopiowania przy nastepnym wywolaniu, nawet jesli
        // ta konkretna kombinacja filtrow dala zero wynikow.
        const activeSearchState: any = {
          location: locationLabel,
          search_mode: usingCoordinates ? "coordinates" : "city",
          checkin: checkin,
          checkout: checkout,
          adults: params.adults,
          rooms: params.rooms,
          min_stars: params.min_stars ?? null,
          exact_stars: params.exact_stars ?? false,
          exclude_hostels: params.exclude_hostels,
          chain: params.chain ?? null,
          breakfast_only: params.breakfast_only,
          free_cancellation_only: params.free_cancellation_only,
          required_facilities: params.required_facilities ?? [],
          max_price_per_night: params.max_price_per_night ?? null,
          min_price_per_night: params.min_price_per_night ?? null,
          currency: params.currency,
        };
        if (usingCoordinates) {
          activeSearchState.latitude = params.latitude;
          activeSearchState.longitude = params.longitude;
          // Promien domyslny/poszerzony NIE trafia do radius_km - model ma go dalej
          // pomijac, inaczej w nastepnej turze wyslalby 1 lub 3 km jako "podane przez usera".
          if (radiusSource === "user") {
            activeSearchState.radius_km = params.radius_km;
          } else {
            activeSearchState.radius_applied_km = params.radius_km;
            activeSearchState.radius_source = radiusSource === "default"
              ? "server default - keep omitting radius_km"
              : "widened automatically by the server - keep omitting radius_km";
          }
        } else {
          activeSearchState.city = params.city;
          activeSearchState.country = params.country;
        }

        const activeSearchStateInstruction =
          "Parameters of THIS search, for this reply only (not visible to you in later messages). In a follow-up, " +
          "search again with what the user asked for and change only what they changed; say which filter changed.";

        const foundInLocation = stepBreakdown.length > 0 ? stepBreakdown[0].count : 0;
        if (limitedAll.length < MIN_RESULTS_BEFORE_WIDEN && widenEligible) {
          console.error("=== DIAG promien: " + limitedAll.length + " obiektow w promieniu domyslnym " + params.radius_km + " km (" +
            stepBreakdown.map((s) => s.step + ": " + s.count).join(" -> ") + ") - poszerzam automatycznie do " +
            WIDENED_RADIUS_KM + " km.");
          return searchHotels(
            { ...params, radius_km: WIDENED_RADIUS_KM, continue_previous: false },
            { fromKm: Number(params.radius_km), fromCount: limitedAll.length, continuationExpired: continuationExpired },
          );
        }
        if (limitedAll.length < MIN_RESULTS_BEFORE_WIDEN && widen && widen.fromKm > 0 && usingCoordinates &&
            Number(params.radius_km) === WIDENED_RADIUS_KM) {
          console.error("=== DIAG promien: " + limitedAll.length + " obiektow takze w " + WIDENED_RADIUS_KM +
            " km - poszerzam automatycznie do " + FAR_RADIUS_KM + " km.");
          return searchHotels(
            { ...params, radius_km: FAR_RADIUS_KM, continue_previous: false },
            { fromKm: widen.fromKm, fromCount: widen.fromCount, continuationExpired: continuationExpired },
          );
        }
        if (limitedAll.length < MIN_RESULTS_BEFORE_WIDEN && !widen && !usingCoordinates && params.city && params.country &&
            foundInLocation < SMALL_PLACE_MAX_FOUND && params.radius_km == null) {
          const center = await resolveLandmarkForSearch(params.city, params.city, params.country, scope, undefined);
          if (center.kind === "point") {
            console.error("=== DIAG promien: w miescie " + params.city + " tylko " + limitedAll.length + " obiektow (" +
              foundInLocation + " w miescie przed filtrami) - szukam " + FAR_RADIUS_KM + " km od centrum (" +
              center.lat + ", " + center.lon + ").");
            return searchHotels(
              { ...params, latitude: center.lat, longitude: center.lon, radius_km: FAR_RADIUS_KM,
                landmark_name: undefined, continue_previous: params.continue_previous },
              { fromKm: 0, fromCount: limitedAll.length, continuationExpired: continuationExpired },
            );
          }
          console.error("=== DIAG promien: malo obiektow w " + params.city + ", ale nie ustalono centrum (" + center.kind + ") - bez poszerzania.");
        }

        if (formatted.length === 0) {
          const breakdownText = stepBreakdown
            .map((s) => s.step + ": " + s.count)
            .join(" -> ");

          let specificHint = "";
          const breakfastStep = stepBreakdown.find((s) => s.step === "after_breakfast_only_free");
          const priorToBreakfast = breakfastStep
            ? stepBreakdown[stepBreakdown.indexOf(breakfastStep) - 1]
            : null;
          if (breakfastStep && breakfastStep.count === 0 && priorToBreakfast && priorToBreakfast.count > 0) {
            specificHint = " Note: " + priorToBreakfast.count + " hotel(s) matched location/price/type before the " +
              "breakfast filter - they exist, but have no offer with breakfast included in this price range.";
          }

          return {
            content: [{
              type: "text",
              text: "No hotels found for " + locationLabel + " between " + checkin + " and " + checkout +
                " matching ALL filters together." +
                (widen ? " The server first searched " + (widen.fromKm === 0 ? "the town itself" : "the default " +
                  widen.fromKm + " km around the point") + " (" + widen.fromCount + " found) and then automatically " +
                  "widened to " + params.radius_km + " km - 0 matching (all radii checked)." : "") +
                " Step-by-step breakdown of how many hotels survived each " +
                "filter (found_in_location -> ... -> final): " + breakdownText + "." + specificHint +
                " Suggested reply: no hotels for these criteria, the filter that reduced the list to zero (from the " +
                "breakdown), and a question whether to relax that filter (e.g. 'Czy pokazać hotele 4* w tej okolicy?'). " +
                "A search with relaxed filters follows only after the user agrees." +
                (unsupportedFilters.length > 0 ? " Not applied (the server cannot filter by them): " +
                  unsupportedFilters.join(", ") + " - say so." : ""),
            }],
            structuredContent: {
              zero_results_breakdown: stepBreakdown,
              active_search_state: activeSearchState,
              active_search_state_instruction: activeSearchStateInstruction,
            },
          };
        }

        logBatchContents("1-" + formatted.length, formatted, 1);
        const output: any = {
          success: true,
          location: locationLabel,
          city_id: cityIdForOutput,
          search_mode: usingCoordinates ? "coordinates" : "city",
          checkin: checkin,
          checkout: checkout,
          nights: nights,
          adults: params.adults,
          total_found: result.total_count,
          returned_count: formatted.length,
          hotels: formatted,
          currency: currency,
        };

        const appliedFilters: string[] = [];
        if (maxTotalPrice != null) appliedFilters.push("max " + params.max_price_per_night + " " + params.currency + "/night");
        if (minTotalPrice != null) appliedFilters.push("min " + params.min_price_per_night + " " + params.currency + "/night");
        if (params.min_review_score != null) appliedFilters.push("review score >= " + params.min_review_score);
        if (params.min_stars) appliedFilters.push((params.exact_stars ? "exactly " : "") + params.min_stars + (params.exact_stars ? " stars" : "+ stars"));
        if (params.exclude_hostels) appliedFilters.push("hostels/apartments/serviced apartments/villas/B&Bs excluded");
        if (typeRequest) appliedFilters.push("property types requested by the user only: " + typeRequest.labels.join(", ") +
          " (Booking.com property type) - other types excluded");
        if (params.required_facilities && params.required_facilities.length > 0) appliedFilters.push("must have: " + params.required_facilities.join(", "));
        if (params.breakfast_only) appliedFilters.push("breakfast included FREE only (paid-breakfast hotels excluded)");
        if (params.free_cancellation_only) appliedFilters.push("free cancellation only");
        if (params.chain) appliedFilters.push("chain/brand: " + params.chain);
        if (appliedFilters.length > 0) {
          output.filters_applied_note = "Filters enforced server-side (guaranteed accurate, not just re-described): " + appliedFilters.join("; ") + ".";
        }
        if (unsupportedFilters.length > 0) {
          output.unsupported_filters = unsupportedFilters;
          output.unsupported_filters_note = "The server cannot filter by: " + unsupportedFilters.join(", ") +
            ". These hotels were NOT checked for it - tell the user once above the list and suggest checking it in " +
            "the hotel details or on Booking.com.";
        }

        output.total_matching = limitedAll.length;
        if (limitedAll.length > formatted.length) {
          const totalPagesCount = Math.ceil(limitedAll.length / pageSize);
          output.paging_note = "This search matched " + limitedAll.length + " hotels after all filters. " +
            "This response contains hotels 1-" + formatted.length + " (batch 1 of " + totalPagesCount + "). " +
            "After these " + formatted.length + ": " + limitedAll.length + " hotels match in total, 'dalej' shows the " +
            "next " + pageSize + ". Next batch = booking_search_hotels with the same parameters plus " +
            "continue_previous:true (positions 11-20, then 21-30, ... from the stored list).";
          output.has_more = true;
        } else {
          output.has_more = false;
        }

        output.review_score_note = hotelsWithScore === 0
          ? "No hotel here has a guest rating (ratings unavailable)."
          : "Quote review_score as given; write 'ocena niedostępna' where it is null.";

        if (reviewSortUnreliable) {
          output.sort_warning = "sort_by=review_score was requested but no hotel in this set has a " +
            "review score, so the order does not reflect guest ratings (worth saying instead of presenting the " +
            "list as sorted by rating).";
        }

        output.display_instruction = "Presentation: all " + formatted.length + " hotels of this batch numbered with " +
          "'position' (1-" + formatted.length + "), in this order (already sorted).";

        if (!params.breakfast_only) {
          output.breakfast_reminder = "For each hotel say whether breakfast is included in the price " +
            "(breakfast_included) or paid extra (breakfast_price_paid, per person per day).";
          if (formatted.some(function (h: any) { return !h.breakfast_included; })) {
            output.breakfast_reminder += " Prices are for the cheapest offer. After the list add one sentence: " +
              "'Ceny dotyczą najtańszej oferty – napisz „ze śniadaniem w cenie”, aby zobaczyć ceny ofert ze śniadaniem.'";
          }
        } else {
          output.breakfast_reminder = "Prices are for offers with breakfast included - say so once above the list; " +
            "do not mention any extra charge for breakfast.";
        }

        if (usingCoordinates) {
          output.radius_km = params.radius_km;
          if (radiusSource === "default") {
            output.radius_note = "Szukam w promieniu " + params.radius_km + " km od {miejsce} (domyślna odległość " +
              "dla zapytań typu „koło” / „w pobliżu”). Jeśli chcesz inny promień, napisz np. „w promieniu 2 km”.";
          } else if (radiusSource === "widened" && widen) {
            const before = widen.fromCount === 0 ? "nie ma żadnego obiektu spełniającego wszystkie kryteria"
              : "jest tylko " + widen.fromCount + " " + (widen.fromCount === 1 ? "obiekt spełniający" : "obiekty spełniające") +
                " wszystkie kryteria";
            output.radius_note = widen.fromKm === 0
              ? "W samej miejscowości " + params.city + " " + before + ", więc automatycznie poszerzyłem wyszukiwanie do " +
                params.radius_km + " km od centrum (także sąsiednie miejscowości)."
              : "W promieniu " + widen.fromKm + " km od {miejsce} " + before + ", więc automatycznie poszerzyłem " +
                "wyszukiwanie do " + params.radius_km + " km.";
          }
          if (output.radius_note) {
            output.radius_note_instruction = "Reply starts with radius_note, {miejsce} replaced by the place name in " +
              "the correct Polish form (e.g. 'Wawelu', 'dworca Kraków Główny'), numbers unchanged. When the user asked " +
              "for exactly this distance: only 'Szukam w promieniu X km od {miejsce}.' without the part about the default.";
          }
          output.location_note = "Hotels within " + params.radius_km + " km of the point - give each hotel's distance_km" +
            (params.sort_by === "distance" ? " (sorted by distance)." : ".");
        } else {
          output.location_note = "City-wide search - not filtered by distance to any place.";
        }

        // Gwiazdki + inne typy obiektow (31.10): Booking.com nie zwraca obiektow bez
        // kategorii przy filtrze gwiazdek - mowimy o tym wprost (decyzja: wariant 1).
        if (params.exclude_hostels === false && params.min_stars != null) {
          output.star_filter_note = "Other property types are included, but only those with " + params.min_stars +
            (params.exact_stars ? "" : "+") + " stars. One sentence for the user: properties without an official " +
            "star category (many guesthouses, hostels, apartments) are not included; they can ask to see them without " +
            "the star filter.";
        }

        if (datesFromChat) {
          output.dates_note = "No dates in this request - the dates from an earlier question in this conversation " +
            "were used: " + checkin + " to " + checkout + ". Reply starts with e.g. 'Przyjąłem daty z wcześniejszego " +
            "pytania: …' and mentions that the user can give other dates.";
        } else if (datesAssumed) {
          output.dates_note = "No dates given - sample prices for " + checkin + " to " + checkout + " (to be mentioned as sample dates).";
        }

        if (result.truncated) {
          output.completeness_note = "Booking.com has more than " + result.hotels.length + " properties for this search " +
            "and only the first " + result.hotels.length + " were checked, so this list may be incomplete - worth a " +
            "short mention with a suggestion to narrow the search (smaller radius, star category or price).";
        }

        output.parking_note = "One 'Parking:' line per hotel from parking_summary, in your own words; for parking_kind " +
          "public_only say the hotel has no own parking, only public. No information -> say so for that hotel only." +
          (parkingFetchFailed ? " Some parking data could not be fetched (technical problem) - say so for those hotels." : "");

        output.active_search_state = activeSearchState;
        output.active_search_state_instruction = activeSearchStateInstruction;

        {
          const meta: Record<string, unknown> = {
            location: locationLabel,
            search_mode: usingCoordinates ? "coordinates" : "city",
            checkin: checkin,
            checkout: checkout,
            nights: nights,
            currency: currency,
            location_note: output.location_note,
            active_search_state: activeSearchState,
          };
          if (output.filters_applied_note) meta.filters_applied_note = output.filters_applied_note;
          if (output.breakfast_reminder) meta.breakfast_reminder = output.breakfast_reminder;
          if (output.unsupported_filters_note) meta.unsupported_filters_note = output.unsupported_filters_note;
          if (output.parking_note) meta.parking_note = output.parking_note;
          if (usingCoordinates) meta.radius_km = params.radius_km;
          saveResultSet(searchKey, limitedAll, pageSize, meta, scope);
          rememberSavedList(searchKey, keyParams);
          console.error("=== DIAG paging: zapisano " + limitedAll.length + " hoteli (paczki po " + pageSize +
            ") pod kluczem " + searchKey);
        }
        if (continuationExpired) {
          output.continuation_note = "The user asked for the next batch, but the previous list was no longer " +
            "available (older than 1 hour or the server restarted), so this is a FRESH search starting again from " +
            "position 1 (worth a short mention that the list was refreshed).";
        }

        const text = JSON.stringify(output);
        return {
          content: [{
            type: "text",
            text: (text.length > CHARACTER_LIMIT ? text.slice(0, CHARACTER_LIMIT) + "\n...[truncated]" : text) + "\n\n---\nSource: Booking.com API"
          }],
          structuredContent: output,
        };

      } catch (err) {
        console.error("=== BLAD w booking_search_hotels: " +
          (err instanceof Error ? (err.stack ?? err.message) : String(err)));
        if (err instanceof BookingApiRequestError) {
          return {
            content: [{
              type: "text",
              text: "Booking.com API error (" + err.apiError.status + "): " + err.apiError.message + " | " + (err.apiError.details || ""),
            }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text",
            text: "Error: " + (err instanceof Error ? err.message : String(err)),
          }],
          isError: true,
        };
      }
  }
}