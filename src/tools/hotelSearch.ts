import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookingApiClient, BookingApiRequestError, formatHotel } from "../services/bookingClient.js";
import { resolveCityId } from "../services/cityResolver.js";
import { HotelSearchInputSchema, HotelSearchInput } from "../schemas/inputSchemas.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM, CHARACTER_LIMIT } from "../constants.js";
import { z } from "zod";
import {
  saveResultSet, getResultSet, getMostRecentResultSet, getPage, totalPages, makeSearchKey, RESULT_PAGE_SIZE,
  StoredResultSet,
} from "../services/resultStore.js";
import { fetchParkingSummaries } from "./hotelDetails.js";
import { RequestContext } from "../services/requestContext.js";
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

type WidenContext = {
  fromKm: number;
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


const HOSTEL_ACCOMMODATION_TYPE = 203;
const APARTMENT_ACCOMMODATION_TYPE = 201;
const VILLA_BB_ACCOMMODATION_TYPE = 208;
// Potwierdzony empirycznie 2026-09-11: kolejny kod dla apartamentow/serviced
// apartments ("Warsaw Apartments - Apartamenty Sadyba", "Mennica Residence -
// City Center Apartments") ktore mimo exclude_hostels=true przechodzily filtr.
const SERVICED_APARTMENT_ACCOMMODATION_TYPE = 219;

const EXCLUDED_ACCOMMODATION_TYPES = new Set([
  HOSTEL_ACCOMMODATION_TYPE,
  APARTMENT_ACCOMMODATION_TYPE,
  VILLA_BB_ACCOMMODATION_TYPE,
  SERVICED_APARTMENT_ACCOMMODATION_TYPE,
]);

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

// === USER_REQUEST (v6, testy 2026-10-29) ===
// Mapa aktywnosci w Copilot Studio: hotelowy przekazal "Wyszukaj hotele 5-gwiazdkowe
// w okolicy lotniska Balice..." (bez odleglosci), a agent MCP sam wyslal radius_km:2.
// Przy Sukiennicach sam wyslal exclude_hostels:false. Opis narzedzia tego zabrania,
// ale model i tak to robi. Dlatego gdy przychodzi user_request (doslowny tekst prosby),
// promien i dopuszczenie hosteli ustala serwer z tego tekstu, a nie z pol od modelu.
const USER_DISTANCE_RE = /(\d+(?:[.,]\d+)?)\s*(km\b|kilometr\w*|m\b|metr\w*)/i;
const OTHER_ACCOMMODATION_RE = new RegExp(
  "hostel|apartament|apartment|pensjonat|kwater|b\\s*&\\s*b|bed and breakfast|willa|villa|" +
  "dowoln\\w* (typ|rodzaj|obiekt|nocleg)|any (type|kind|accommodation)|wszystkie (typy|rodzaje|obiekty)",
  "i");

function parseUserDistanceKm(text: string): number | null {
  const m = USER_DISTANCE_RE.exec(text);
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!isFinite(value) || value <= 0) return null;
  const km = /^k/i.test(m[2]) ? value : value / 1000;
  if (km < 0.1 || km > 50) return null;
  return Math.round(km * 1000) / 1000;
}

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
const NEXT_BATCH_WORDS_RE = /(^|[^\p{L}])(dalej|kolejn\p{L}*|nast[eę]pn\p{L}*|wi[eę]cej|pozosta[lł]\p{L}*|reszt\p{L}*|next|more)([^\p{L}]|$)/iu;
const NEXT_BATCH_MAX_LEN = 60;

function isNextBatchRequest(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > NEXT_BATCH_MAX_LEN) return false;
  if (/\d\s*(\*|gwiazd|km|m\b|pln|zł|eur)/iu.test(t)) return false;
  return NEXT_BATCH_WORDS_RE.test(t);
}

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
      message: "Do NOT fetch more batches in this turn. Show the user ONLY the batch you already received " +
        "(positions " + ((entry.lastServedPage - 1) * entry.page_size + 1) + "-" +
        Math.min(entry.lastServedPage * entry.page_size, total) + " of " + total + "), then tell them they can " +
        "write 'dalej' to see the next " + entry.page_size + ". Wait for the user's next message.",
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
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
        "Tell the user there are no more results for this search. Do NOT list any hotels.",
    };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
  }
  const batch = getPage(entry, nextPage);
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
    display_instruction: "Show ONLY these " + batch.length + " hotels as a numbered list - write each hotel's " +
      "'position' number before its name (e.g. '" + from + ". Hotel ...'), positions " +
      from + "-" + to + ", in this exact order and in the same format as before. Every hotel name, price and " +
      "rating you write must come from this response. " +
      (remaining > 0
        ? "Then say " + remaining + " more remain and the user can write 'dalej'."
        : "Then say these were the last results of this search (all " + total + " shown)."),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(out, null, 2) + "\n\n---\nSource: Booking.com API" }],
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
  | { kind: "none" };

let landmarkClient: BookingApiClient | null = null;

// Ta sama logika co booking_find_landmark: jedno dopasowanie albo kilka wpisow
// tego samego miejsca (do LANDMARK_CLUSTER_DIAMETER_KM) -> punkt; kilka roznych
// miejsc -> pytanie do usera; brak -> geokodowanie zewnetrzne.
async function resolveLandmarkForSearch(name: string, city: string, country: string): Promise<LandmarkResolution> {
  if (!landmarkClient) return { kind: "none" };
  const cityResult = await resolveCityId(landmarkClient, city, country);
  if (!cityResult) return { kind: "none" };
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
      description: "Search available hotels on Booking.com in a city or around a point. Results come in batches of 10 together with notes on how to present them - follow every *_note / *_instruction field in the response.\nLOCATION: city + country for 'hotels in X' (city name in English, e.g. 'Warsaw'). For a named place (landmark, station, airport, address) pass landmark_name with city + country - the server finds the coordinates (also in follow-up messages: just pass the same landmark_name again). If the response says multiple_matches, ask the user which place they mean. Never type coordinates yourself. If you are not sure a city name is right, call booking_search_cities; if it could be in more than one country, ask the user.\nRADIUS: pass radius_km only when the user gave a distance ('w promieniu 2 km', 'do 500 m' -> 0.5). For 'koło', 'w pobliżu', 'przy', 'near' omit it - the server uses 1 km and widens to 3 km when nothing is found.\nUSER_REQUEST: always copy the request you are handling, verbatim, into user_request.\nFOLLOW-UPS: results of earlier messages are not visible to you. When the user changes one thing ('teraz 4 gwiazdki', 'bez śniadania'), search again with everything the user asked for earlier in the conversation and change only that. Say which filter changed; if the list is the same, say so.\nNEXT BATCH: for 'dalej' / 'pokaż kolejne' call this tool again with the same parameters plus continue_previous:true - only in a new message, one batch per reply.\nFILTERS (enforced by the server):\n- 'hotele 3*' = min_stars 3 + exact_stars true; 'co najmniej 3*', '3+', 'od 3*' = exact_stars false.\n- breakfast_only only when breakfast must be included in the price ('śniadanie w cenie'); a plain 'ze śniadaniem' is not a filter - report free vs paid breakfast instead.\n- exclude_hostels is true by default; false only if the user accepts hostels or apartments.\n- price limits are per night; amenities via required_facilities; ratings via min_review_score.\n- Zero results: explain which filter caused it (zero_results_breakdown) and ASK before relaxing a filter - never run a relaxed search on your own.\nDATES are optional: without them sample prices for a weekend about 3 months ahead are returned - say they are sample dates.\nPRESENTING: list every hotel of the batch numbered with its 'position': price, guest rating (or 'ocena niedostępna'), distance (when searching around a point), breakfast (free, or paid with the price), one 'Parking:' line (for parking_kind public_only: 'tylko parking publiczny, obiekt nie ma własnego') and the booking link. Then give the total number and mention 'dalej'. Use only data from this tool's response in this message - never invent hotels, prices or ratings and never show raw field names. Full details of one hotel: booking_get_hotel_details.",
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
        if (!params.city || !params.country) {
          return {
            content: [{ type: "text", text: "landmark_name needs city (in English) and country. Ask the user which city " +
              "the place is in, then search again." }],
            isError: true,
          };
        }
        const resolved = await resolveLandmarkForSearch(params.landmark_name.trim(), params.city, params.country);
        if (resolved.kind === "point") {
          params.latitude = resolved.lat;
          params.longitude = resolved.lon;
          landmarkResolvedName = resolved.name;
          console.error("=== DIAG landmark_name: \"" + params.landmark_name + "\" -> " + resolved.name + " (" +
            resolved.lat + ", " + resolved.lon + ")" + (resolved.approximate ? ", geokodowanie zewnetrzne" : "") + ".");
        } else {
          console.error("=== DIAG landmark_name: \"" + params.landmark_name + "\" -> " + resolved.kind + ".");
          const out: any = resolved.kind === "multiple"
            ? {
              status: "multiple_matches",
              message: "Several places match \"" + params.landmark_name + "\". Ask the user which one they mean (show the " +
                "names) and STOP - do not list hotels yet. Then search again with landmark_name set to the full name " +
                "of the chosen place.",
              candidates: resolved.candidates,
            }
            : {
              status: "no_match",
              message: "Place \"" + params.landmark_name + "\" was not found in " + params.city + " (Booking.com landmarks " +
                "and general geocoding). Tell the user and ask for another name or a nearby well-known place.",
            };
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
        }
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
      if (userText && params.exclude_hostels === false && !OTHER_ACCOMMODATION_RE.test(userText)) {
        params.exclude_hostels = true;
        console.error("=== DIAG exclude_hostels: model wyslal false, ale tekst usera nie wspomina hosteli/apartamentow - wymuszam true.");
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
          message: "There is no active result list to continue (it expired or the server restarted). Do NOT list " +
            "any hotels and do NOT invent results. Run booking_search_hotels again with the full parameters of the " +
            "user's search (city/coordinates, dates, filters) WITHOUT continue_previous, and show batch 1 - telling " +
            "the user the list was refreshed and starts from the beginning.",
        };
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
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

      // (przeglad pkt 11) Booking.com liczy cene dzieci tylko z ich wieku - sama liczba dzieci
      // bez wieku dawala cicho cene dla samych doroslych.
      if (!params.continue_previous && (params.children_count ?? 0) > 0 &&
          (!params.children_ages || params.children_ages.length !== params.children_count)) {
        return {
          content: [{
            type: "text",
            text: "The age of each child is needed for correct prices (children_count=" + params.children_count +
              ", children_ages=" + JSON.stringify(params.children_ages ?? []) + "). Ask the user for the age of each " +
              "child and search again with children_ages. Do not search without them.",
          }],
          isError: true,
        };
      }

      let checkin = params.checkin;
      let checkout = params.checkout;
      let datesAssumed = false;

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
        breakfast_only: params.breakfast_only, free_cancellation_only: params.free_cancellation_only,
        sort_by: params.sort_by,
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
        const cityResult = await resolveCityId(client, params.city!, params.country!);
        if (!cityResult) {
          return {
            content: [{
              type: "text",
              text: "City \"" + params.city + "\" not found in country \"" + params.country + "\" on Booking.com. Check the spelling and the country code, or use booking_search_cities to search.",
            }],
            isError: true,
          };
        }
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
          hotels = hotels.filter(function (h) {
            return h.accommodation_type_id == null || !EXCLUDED_ACCOMMODATION_TYPES.has(h.accommodation_type_id);
          });
          console.error("=== DIAG exclude_hostels: " + beforeExclusion + " -> " + hotels.length +
            " hoteli. Wykluczone typy: hostel(" + HOSTEL_ACCOMMODATION_TYPE + "), apartament(" +
            APARTMENT_ACCOMMODATION_TYPE + "), willa/B&B(" + VILLA_BB_ACCOMMODATION_TYPE +
            "), serviced apartment(" + SERVICED_APARTMENT_ACCOMMODATION_TYPE + ").");
          stepBreakdown.push({ step: "after_exclude_hostels_apartments_villas", count: hotels.length });
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

        if (formatted.length === 0 && widenEligible) {
          console.error("=== DIAG promien: 0 hoteli w promieniu domyslnym " + params.radius_km + " km (" +
            stepBreakdown.map((s) => s.step + ": " + s.count).join(" -> ") + ") - poszerzam automatycznie do " +
            WIDENED_RADIUS_KM + " km.");
          return searchHotels(
            { ...params, radius_km: WIDENED_RADIUS_KM, continue_previous: false },
            { fromKm: Number(params.radius_km), continuationExpired: continuationExpired },
          );
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
            specificHint = " IMPORTANT: there WERE " + priorToBreakfast.count + " real hotel(s) matching " +
              "location/price/type before the breakfast filter - they exist and are bookable, they just " +
              "charge for breakfast instead of including it free. Tell the user this explicitly (e.g. name " +
              "the hotels and their paid breakfast price) instead of saying no hotels exist nearby.";
          }

          return {
            content: [{
              type: "text",
              text: "No hotels found for " + locationLabel + " between " + checkin + " and " + checkout +
                " matching ALL filters together." +
                (widen ? " The server first searched the default " + widen.fromKm + " km around the point (0 hotels) " +
                  "and then automatically widened to " + params.radius_km + " km - also 0 hotels. Tell the user both " +
                  "radii were checked." : "") +
                " Step-by-step breakdown of how many hotels survived each " +
                "filter (found_in_location -> ... -> final): " + breakdownText + "." + specificHint +
                " Tell the user specifically which filter caused the drop to zero, not just 'try relaxing " +
                "filters' generically. Do NOT run another search with a relaxed filter (e.g. without min_stars) " +
                "and present its hotels as the answer - report zero results and ASK the user whether to relax " +
                "a filter (e.g. 'Czy pokazać hotele 4* w tej okolicy?').",
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
        if (params.required_facilities && params.required_facilities.length > 0) appliedFilters.push("must have: " + params.required_facilities.join(", "));
        if (params.breakfast_only) appliedFilters.push("breakfast included FREE only (paid-breakfast hotels excluded)");
        if (params.free_cancellation_only) appliedFilters.push("free cancellation only");
        if (appliedFilters.length > 0) {
          output.filters_applied_note = "Filters enforced server-side (guaranteed accurate, not just re-described): " + appliedFilters.join("; ") + ".";
        }

        output.total_matching = limitedAll.length;
        if (limitedAll.length > formatted.length) {
          const totalPagesCount = Math.ceil(limitedAll.length / pageSize);
          output.paging_note = "This search matched " + limitedAll.length + " hotels after all filters. " +
            "This response contains hotels 1-" + formatted.length + " (batch 1 of " + totalPagesCount + "). " +
            "Show these " + formatted.length + ", then tell the user that " + limitedAll.length +
            " hotels match in total and they can write 'dalej' to see the next " + pageSize + ". " +
            "For the next batch call booking_search_hotels again with EXACTLY the same parameters plus " +
            "continue_previous:true - the server returns positions 11-20 (then 21-30, ...) from the stored list.";
          output.has_more = true;
        } else {
          output.has_more = false;
        }

        output.review_score_note = hotelsWithScore === 0
          ? "No hotel here has a guest rating - say ratings are unavailable, never invent one."
          : "Quote review_score as given; write 'ocena niedostępna' where it is null.";

        if (reviewSortUnreliable) {
          output.sort_warning = "sort_by=review_score was requested but no hotel in this set has a " +
            "review score, so the order does NOT reflect guest ratings. Say this explicitly instead " +
            "of presenting the list as sorted by rating.";
        }

        output.display_instruction = "List all " + formatted.length + " hotels of this batch numbered with 'position' " +
          "(1-" + formatted.length + "), in this order (already sorted - do not re-sort).";

        if (!params.breakfast_only) {
          output.breakfast_reminder = "For each hotel say whether breakfast is free (breakfast_included) or paid " +
            "(breakfast_price_paid). If both are set, breakfast IS included and the price is an optional upgrade - " +
            "never write 'w cenie, dodatkowo płatne'.";
        }

        if (usingCoordinates) {
          output.radius_km = params.radius_km;
          if (radiusSource === "default") {
            output.radius_note = "Szukam w promieniu " + params.radius_km + " km od {miejsce} (domyślna odległość " +
              "dla zapytań typu „koło” / „w pobliżu”). Jeśli chcesz inny promień, napisz np. „w promieniu 2 km”.";
          } else if (radiusSource === "widened" && widen) {
            output.radius_note = "W promieniu " + widen.fromKm + " km od {miejsce} nie ma żadnego hotelu spełniającego " +
              "wszystkie kryteria, więc automatycznie poszerzyłem wyszukiwanie do " + params.radius_km + " km.";
          }
          if (output.radius_note) {
            output.radius_note_instruction = "Start your reply with radius_note, replacing {miejsce} with the place " +
              "name in the correct Polish form (e.g. 'Wawelu', 'dworca Kraków Główny'). Do not change the numbers. " +
              "If the user explicitly asked for exactly this distance, write only 'Szukam w promieniu X km od {miejsce}.' " +
              "without the part about the default.";
          }
          output.location_note = "Hotels within " + params.radius_km + " km of the point - give each hotel's distance_km" +
            (params.sort_by === "distance" ? " (sorted by distance)." : ".");
        } else {
          output.location_note = "City-wide search - not filtered by distance to any place.";
        }

        if (datesAssumed) {
          output.dates_note = "No dates given - sample prices for " + checkin + " to " + checkout + ". Tell the user these are sample dates.";
        }

        if (result.truncated) {
          output.completeness_note = "Booking.com has more than " + result.hotels.length + " properties for this search " +
            "and only the first " + result.hotels.length + " were checked, so this list may be incomplete. Tell the user " +
            "briefly and suggest narrowing the search (smaller radius, star category or price).";
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
            "position 1. Tell the user briefly that the list was refreshed and starts from the beginning.";
        }

        const text = JSON.stringify(output, null, 2);
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