import { BookingApiClient } from "./bookingClient.js";
import { normalizeText } from "./textNormalize.js";

export interface LandmarkSearchResult {
  landmark_id: number;
  name: string;
  latitude: number;
  longitude: number;
}

const MAX_PAGES = 50;

// === CACHE (2026-10-29, przeglad optymalizacji) ===
// Lista landmarkow miasta jest statyczna, a booking_find_landmark jest wolany
// w kazdej turze (2 zapytania na wywolanie, np. Wawel). Teraz lista miasta
// jest pobierana raz na 24 h. Wynik geokodowania (Nominatim) tez 24 h - to
// rowniez wymog regulaminu OSM (bez powtarzania tych samych zapytan).
const LANDMARKS_TTL_MS = 24 * 60 * 60 * 1000;
const cityLandmarks = new Map<number, { at: number; list: any[] }>();
const landmarksInFlight = new Map<number, Promise<any[]>>();
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const geocodeCache = new Map<string, { at: number; result: LandmarkSearchResult | null }>();

async function loadCityLandmarks(client: BookingApiClient, cityId: number): Promise<any[]> {
  const cached = cityLandmarks.get(cityId);
  if (cached && Date.now() - cached.at < LANDMARKS_TTL_MS) return cached.list;
  const pending = landmarksInFlight.get(cityId);
  if (pending) return pending;
  const p = (async () => {
    const list: any[] = [];
    let body: any = { city: cityId, languages: ["en-gb", "pl", "de"] };
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await client.post<any>("/common/locations/landmarks", body);
      list.push(...((resp.data ?? []) as any[]));
      if (!resp.next_page) { complete = true; break; }
      body = { page: resp.next_page };
    }
    if (complete) cityLandmarks.set(cityId, { at: Date.now(), list });
    return list;
  })();
  landmarksInFlight.set(cityId, p);
  try {
    return await p;
  } finally {
    landmarksInFlight.delete(cityId);
  }
}

function tokenize(name: string): string[] {
  return normalizeText(name)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Slowa ktore czesto POWTARZAJA sie w nazwie miasta i w nazwach wielu
// niepowiazanych landmarkow tego miasta jednoczesnie (np. "Warsaw"
// pojawia sie w "Warsaw Central Railway Station" ORAZ w "Warsaw Trade
// Tower" - kompletnie niepowiazane miejsca). Samo trafienie w token
// nazwy miasta to zbyt slaby sygnal dopasowania - dokladnie ten sam
// problem juz raz rozwiazany dla dopasowania nazw hoteli (patrz
// cityExclusions w findHotel.ts). Landmarki nigdy nie mialy tej ochrony.
function buildCityExclusions(cityName: string, cityNameVariants: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const t of tokenize(cityName)) tokens.add(t);
  for (const variant of cityNameVariants) {
    for (const t of tokenize(variant)) tokens.add(t);
  }
  return tokens;
}

// Slowa ktore sa NAJEZYKOWO SPOKREWNIONE (dzielą ten sam lacinski rdzen)
// ale oznaczaja co innego - "central" (przymiotnik: centralny) i
// "centre"/"centrum"/"center" (rzeczownik: centrum) dziela identyczny
// 4-znakowy rdzen "cent", przez co stemsMatch falszywie je utozsamial.
// POTWIERDZONY BUG: zapytanie o "Warsaw Central [Railway] Station"
// falszywie dopasowalo sie do "Expo 21 Convention CENTRE" wylacznie
// dzieki temu, ze "central" i "centre" maja wspolny rdzen "cent".
// Dla tokenow z tej listy WYMAGAMY dokladnej rownosci - stemsMatch nie
// moze ich mostkowac miedzy soba.
const STEM_COLLISION_DENYLIST = new Set([
  "central", "centre", "center", "centrum", "centralny", "centralna", "century",
]);

// Dla krótkich tokenów (do 3 znaków włącznie) prosty substring jest
// niebezpieczny - moga wystapic jako PODCIAG zupelnie niepowiazanego,
// dluzszego slowa (np. "art" wewnatrz "apartment").
//
// Dodatkowo: fallback dla polskiej fleksji (odmiana przez przypadki) -
// "targi"/"targach", "hotel"/"hotelu" itp. czesto roznia sie tylko
// koncowka. Pelna lematyzacja wymagalaby slownika NLP - zamiast tego
// porownujemy "rdzen" (pierwsze min. 4 znaki). UWAGA: ten fallback jest
// swiadomie WYLACZONY dla par tokenow z STEM_COLLISION_DENYLIST, bo
// dzielenie tylko 4-znakowego rdzenia miedzy jezykowo pokrewnymi, ale
// znaczeniowo roznymi slowami (central/centre) daje falszywe trafienia.
const STEM_MIN_LENGTH = 4;

function stemsMatch(a: string, b: string): boolean {
  if (a.length < STEM_MIN_LENGTH || b.length < STEM_MIN_LENGTH) return false;
  if (a !== b && (STEM_COLLISION_DENYLIST.has(a) || STEM_COLLISION_DENYLIST.has(b))) {
    return false;
  }
  const stemLen = Math.min(STEM_MIN_LENGTH, a.length, b.length);
  return a.slice(0, stemLen) === b.slice(0, stemLen);
}

function tokensMatch(a: string, b: string): boolean {
  const minLen = Math.min(a.length, b.length);
  if (minLen <= 3) {
    return a === b;
  }
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) {
    return true;
  }
  return stemsMatch(a, b);
}

function extractName(field: any): string | null {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (typeof field === "object") {
    return field["en-gb"] ?? field["pl"] ?? field["en"] ?? (Object.values(field)[0] as string) ?? null;
  }
  return null;
}

function extractAllNameVariants(field: any): string[] {
  if (!field) return [];
  if (typeof field === "string") return [field];
  if (typeof field === "object") {
    return Object.values(field).filter((v): v is string => typeof v === "string");
  }
  return [];
}

// === OGOLNE ZAPYTANIA O TYP MIEJSCA (test 2026-10-29) ===
// "stacja kolejowa" w Krakowie trafilo TYLKO w Plaszow (jego polska nazwa ma
// slowa "stacja kolejowa"; Kraków Główny w polskiej wersji to "Dworzec Główny"),
// wiec serwer bez pytania szukal kolo Plaszowa. Gdy zapytanie sklada sie
// wylacznie ze slow ogolnych ("dworzec", "stacja kolejowa", "lotnisko"),
// zbieramy WSZYSTKIE miejsca tego typu w miescie - przy kilku agent pyta usera.
type PlaceCategory = { name: string; vocab: Set<string>; required?: string[]; markers: string[] };
const PLACE_CATEGORIES: PlaceCategory[] = [
  {
    name: "dworzec autobusowy",
    vocab: new Set(["dworzec", "dworca", "dworcu", "autobusowy", "autobusowego", "autobusowym", "autobusowa",
      "autobusowej", "bus", "coach", "station", "terminal", "stacja", "stacji"]),
    required: ["autobus", "bus", "coach"],
    markers: ["bus", "autobus", "coach"],
  },
  {
    name: "stacja kolejowa",
    vocab: new Set(["dworzec", "dworca", "dworcu", "stacja", "stacji", "kolejowa", "kolejowej", "kolejowy",
      "kolejowego", "kolejowym", "kolej", "pkp", "railway", "rail", "train", "station", "pociag", "pociagu"]),
    markers: ["railway", "train", "dworz", "dworc", "kolejow", "pkp", "bahnhof"],
  },
  {
    name: "lotnisko",
    vocab: new Set(["lotnisko", "lotniska", "lotnisku", "port", "lotniczy", "lotniczego", "lotniczym", "airport"]),
    markers: ["airport", "lotnisk", "lotnicz"],
  },
];

function genericCategory(tokens: string[]): PlaceCategory | null {
  if (tokens.length === 0) return null;
  for (const c of PLACE_CATEGORIES) {
    if (!tokens.every((t) => c.vocab.has(t))) continue;
    if (c.required && !tokens.some((t) => c.required!.some((r) => t.startsWith(r)))) continue;
    return c;
  }
  return null;
}

// Ulice o nazwie "Kolejowa", "Dworcowa" itp. to nie dworzec.
const STREET_TOKENS = new Set(["street", "ulica", "ul", "aleja", "avenue", "road", "strasse", "plac", "square"]);

// Glowny dworzec / glowne lotnisko na poczatek listy kandydatow.
const MAIN_PLACE_TOKENS = ["central", "glowny", "glowna", "main", "hauptbahnhof", "centralny", "international"];

// Szuka punktow orientacyjnych (zabytki, dworce, lotniska, atrakcje) w obrebie
// KONKRETNEGO miasta.
//
// cityName/cityNameVariants: przekazywane po to, by wykluczyc tokeny
// nazwy miasta z kryteriow dopasowania (patrz buildCityExclusions) -
// bez tego samo slowo "Warsaw" w zapytaniu falszywie dopasowywalo sie
// do KAZDEGO landmarku zawierajacego "Warsaw" w nazwie, niezaleznie od
// tego czy mial cokolwiek wspolnego z faktycznie szukanym miejscem.
export async function searchLandmarks(
  client: BookingApiClient,
  cityId: number,
  query: string,
  limit: number,
  cityName?: string,
  cityNameVariants?: string[]
): Promise<LandmarkSearchResult[]> {
  const cityExclusions = cityName
    ? buildCityExclusions(cityName, cityNameVariants ?? [])
    : new Set<string>();

  const rawQueryTokens = tokenize(query);
  const queryTokens = rawQueryTokens.filter((t) => !cityExclusions.has(t));
  // Jesli wykluczenie nazwy miasta zostawiloby zapytanie calkowicie puste
  // (user zapytal np. tylko o samo "Warsaw"), wracamy do pelnego zestawu -
  // lepiej dac szanse dopasowania niz od razu zwrocic 0 wynikow.
  const effectiveQueryTokens = queryTokens.length > 0 ? queryTokens : rawQueryTokens;

  const category = genericCategory(effectiveQueryTokens);
  const results: LandmarkSearchResult[] = [];
  const mainFlags = new Map<number, boolean>();
  const seen = new Set<number>();

  const cachedBefore = cityLandmarks.has(cityId);
  const all = await loadCityLandmarks(client, cityId);
  {
    for (const entry of all) {
      const displayName = extractName(entry.name);
      const allVariants = extractAllNameVariants(entry.name);
      const lat = entry.coordinates?.latitude;
      const lon = entry.coordinates?.longitude;
      if (!displayName || entry.id == null || typeof lat !== "number" || typeof lon !== "number") continue;

      const nameTokens = allVariants.flatMap((v) => tokenize(v));
      if (effectiveQueryTokens.length === 0 || nameTokens.length === 0) continue;

      const matches = category
        ? nameTokens.some((nt) => category.markers.some((m) => nt.startsWith(m))) &&
          (category.name !== "stacja kolejowa" || !nameTokens.some((nt) => nt.startsWith("bus") || nt.startsWith("autobus"))) &&
          !nameTokens.some((nt) => STREET_TOKENS.has(nt))
        : effectiveQueryTokens.every((qt) =>
            nameTokens.some((nt) => tokensMatch(nt, qt))
          );

      if (matches && !seen.has(entry.id)) {
        seen.add(entry.id);
        results.push({ landmark_id: entry.id, name: displayName, latitude: lat, longitude: lon });
        mainFlags.set(entry.id, nameTokens.some((nt) => MAIN_PLACE_TOKENS.indexOf(nt) !== -1));
        // Przy typie miejsca zbieramy wszystkie (zeby glowny dworzec nie wypadl za limitem), tniemy po sortowaniu.
        if (!category && results.length >= limit) break;
      }
    }
  }
  if (category) {
    results.sort((a, b) => Number(mainFlags.get(b.landmark_id) ?? false) - Number(mainFlags.get(a.landmark_id) ?? false));
    if (results.length > limit) results.length = limit;
  }

  console.error("=== DIAG searchLandmarks: query=\"" + query + "\"" + (cachedBefore ? " [lista miasta z cache]" : "") +
    (category ? " [ogolny typ miejsca: " + category.name + " - wszystkie takie miejsca w miescie]" : "") +
    " (efektywne tokeny: " +
    JSON.stringify(effectiveQueryTokens) + ") -> " + results.length +
    " dopasowan: " + JSON.stringify(results.map((r) => r.name)));

  return results;
}

export async function geocodeAddress(query: string, cityName: string): Promise<LandmarkSearchResult | null> {
  const cacheKey = normalizeText(query) + "|" + normalizeText(cityName);
  const hit = geocodeCache.get(cacheKey);
  // Brak wyniku (albo blad sieci) pamietamy tylko 10 min - zeby chwilowa awaria nie trwala dobe.
  if (hit && Date.now() - hit.at < (hit.result ? GEOCODE_TTL_MS : 10 * 60 * 1000)) return hit.result;
  const result = await geocodeUncached(query, cityName);
  geocodeCache.set(cacheKey, { at: Date.now(), result });
  if (geocodeCache.size > 2000) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest !== undefined) geocodeCache.delete(oldest);
  }
  return result;
}

async function geocodeUncached(query: string, cityName: string): Promise<LandmarkSearchResult | null> {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(query + ", " + cityName);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "booking-mcp-server/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return {
      landmark_id: -1,
      name: query,
      latitude: parseFloat(data[0].lat),
      longitude: parseFloat(data[0].lon),
    };
  } catch (err) {
    console.error("=== Geocoding fallback nieudany: " + (err instanceof Error ? err.message : String(err)));
    return null;
  }
}