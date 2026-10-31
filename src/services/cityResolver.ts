import { BookingApiClient } from "./bookingClient.js";
import { normalizeText } from "./textNormalize.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM } from "../constants.js";

export interface CitySearchResult {
  city_id: number;
  name: string;
  country: string;
  name_variants: string[];
}

interface CachedCity {
  city_id: number;
  name: string;
  name_variants: string[];
}

const cityCache = new Map<string, CachedCity>();
// Ostatnie niejednoznaczne nazwy (kraj:nazwa -> kandydaci) - dla komunikatu cityNotFoundMessage.
const ambiguousCities = new Map<string, string[]>();

// === WYBOR MIASTA PAMIETANY W CZACIE (31.10) ===
// Po pytaniu "Frankfurt/Main czy Frankfurt/Oder?" i wyborze usera agent w kolejnej
// wiadomosci znow wysylal samo "Frankfurt" (nie widzi poprzednich tur) - serwer
// pytal drugi raz. Teraz: pytanie zapamietane per czat, wybor kandydata zapisany
// jako "Frankfurt" -> "Frankfurt/Main" dla tego czatu. 60 min od ostatniego uzycia.
const CITY_CHOICE_TTL_MS = 60 * 60 * 1000;
const pendingCityQuestion = new Map<string, { key: string; candidates: string[]; at: number }>();
const cityChoices = new Map<string, { name: string; at: number }>();

function trimMap(m: Map<string, unknown>): void {
  if (m.size > 2000) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
}

// === LISTA MIAST KRAJU W CACHE (2026-10-29, przeglad optymalizacji) ===
// resolveCityId i searchCities przechodzily CALA liste miast kraju przy kazdym
// wywolaniu (Polska: kilka stron po 1000, ~1,3 s). Prewarm 7 miast robil to
// 7 razy przy kazdym starcie kontenera, a booking_search_cities i "alternatywne
// miasta" w booking_find_hotel - przy kazdym uzyciu. Teraz lista kraju jest
// pobierana raz na 24 h i wspolna dla wszystkich.
interface CountryCity { id: number; name: string; norm: string; variants: string[] }
const COUNTRY_CITIES_TTL_MS = 24 * 60 * 60 * 1000;
const countryCities = new Map<string, { at: number; list: CountryCity[] }>();
const countryInFlight = new Map<string, Promise<CountryCity[]>>();

async function loadCountryCities(client: BookingApiClient, country: string): Promise<CountryCity[]> {
  const cached = countryCities.get(country);
  if (cached && Date.now() - cached.at < COUNTRY_CITIES_TTL_MS) return cached.list;
  const pending = countryInFlight.get(country);
  if (pending) return pending;
  const p = (async () => {
    const started = Date.now();
    const list: CountryCity[] = [];
    let body: any = { country, rows: CITIES_ROWS_PER_PAGE };
    let complete = false;
    let pages = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await client.post<any>("/common/locations/cities", body);
      pages++;
      for (const entry of (resp.data ?? []) as any[]) {
        const name = extractName(entry.name);
        if (!name || entry.id == null) continue;
        list.push({ id: entry.id, name, norm: normalizeText(name), variants: extractAllNameVariants(entry.name) });
      }
      if (!resp.next_page) { complete = true; break; }
      // Przy paginacji "page" musi byc jedynym polem.
      body = { page: resp.next_page };
    }
    console.error("=== Lista miast kraju \"" + country + "\": " + list.length + " miast, " + pages + " stron, " +
      (Date.now() - started) + " ms" + (complete ? "" : " (NIEKOMPLETNA - nie zapisuje w cache)"));
    if (complete) countryCities.set(country, { at: Date.now(), list });
    return list;
  })();
  countryInFlight.set(country, p);
  try {
    return await p;
  } finally {
    countryInFlight.delete(country);
  }
}

const MAX_PAGES = 200;
// Booking.com API /common/locations/cities akceptuje "rows" do 1000
// (wielokrotnosc 10), domyslnie tylko 100. Ustawienie maksimum redukuje
// liczbe potrzebnych stron ~10-krotnie (potwierdzone: Polska mialo 52-73
// strony przy domyslnym rows:100, powinno spasc do ~7 stron przy rows:1000).
// Zrodlo: https://developers.booking.com/demand/docs/open-api/demand-api/commonlocations/common/locations/cities
const CITIES_ROWS_PER_PAGE = 1000;

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

// Sprawdza ile hoteli faktycznie zwraca dana lokalizacja (probne zapytanie,
// interesuje nas total_count, nie same dane). Uzywane do rozstrzygania
// miedzy DOWOLNA liczba zduplikowanych wpisow tego samego miasta w bazie
// Booking.com - moga byc 2, 3 lub wiecej takich wpisow, funkcja dziala
// niezaleznie od ich liczby.
async function countHotelsForCity(client: BookingApiClient, cityId: number): Promise<number> {
  try {
    const base = new Date();
    base.setDate(base.getDate() + 90);
    const co = new Date(base);
    co.setDate(co.getDate() + 2);
    const resp = await client.post<any>("/accommodations/search", {
      booker: { country: DEFAULT_BOOKER_COUNTRY, platform: DEFAULT_BOOKER_PLATFORM },
      checkin: base.toISOString().split("T")[0],
      checkout: co.toISOString().split("T")[0],
      city: cityId,
      guests: { number_of_adults: 1, number_of_rooms: 1 },
      currency: "PLN",
      rows: 10,
    });
    const data: any[] = resp.data ?? resp.result ?? resp.hotels ?? [];
    return resp.total_count ?? resp.metadata?.total_results ?? resp.count ?? data.length;
  } catch (err) {
    console.error("=== Blad przy liczeniu hoteli dla city_id=" + cityId + " (pomijam, liczba=0): " +
      (err instanceof Error ? err.message : String(err)));
    return 0;
  }
}

// Szuka City ID po nazwie miasta, pytajac API Booking.com (z kartkowaniem stron).
//
// KLUCZOWA ZASADA (ogolna, nie punktowa dla jednego miasta): Booking.com
// moze miec DOWOLNA liczbe zduplikowanych wpisow TEGO SAMEGO miasta w
// swojej bazie (potwierdzony przypadek: "Leszno" ma DWA rozne city_id o
// identycznej nazwie, jeden z zaledwie 1 hotelem w puli, drugi z pelna
// oferta zawierajaca realne, znane hotele jak "B&B HOTEL Leszno" - branie
// pierwszego z brzegu dawalo falszywy no_match). Ta funkcja ZAWSZE zbiera
// WSZYSTKIE dokladne dopasowania nazwy w calym kraju (bez wzgledu na to
// czy jest ich 1, 2, 5 czy wiecej), a gdy jest ich wiecej niz jedno,
// sprawdza KAZDE z nich przez probne zapytanie o realna liczbe hoteli i
// wybiera wariant z NAJWIEKSZA pula.
//
// UWAGA - POTWIERDZONY BUG NAPRAWIONY (2026-09-09): poprzednia wersja
// cache'owala PRZY OKAZJI (incydentalnie) KAZDE miasto napotkane podczas
// paginacji, NIEZALEZNIE od tego, czy to ono bylo celem danego zapytania.
// To moglo zanieczyscic cache falszywym wyborem dla miast z duplikatami,
// bez zadnego loga. FIX: cache'ujemy WYLACZNIE finalny, w pelni
// zweryfikowany wynik dla miasta bedacego bezposrednim celem zapytania.
export async function resolveCityId(
  client: BookingApiClient,
  cityName: string,
  country: string,
  scope?: string
): Promise<CitySearchResult | null> {
  const normCountry = country.toLowerCase().trim();
  const normName = normalizeText(cityName);
  const cacheKey = normCountry + ":" + normName;

  if (scope) {
    const choice = cityChoices.get(scope + "|" + cacheKey);
    if (choice && Date.now() - choice.at <= CITY_CHOICE_TTL_MS && normalizeText(choice.name) !== normName) {
      choice.at = Date.now();
      console.error("=== Miasto: \"" + cityName + "\" -> " + choice.name + " (wybor usera wczesniej w tym czacie).");
      return resolveCityId(client, choice.name, country);
    }
  }
  const result = await resolveCityIdInner(client, cityName, country, normCountry, normName, cacheKey);
  if (scope) {
    if (!result && ambiguousCities.has(cacheKey)) {
      pendingCityQuestion.set(scope, { key: cacheKey, candidates: ambiguousCities.get(cacheKey)!, at: Date.now() });
      trimMap(pendingCityQuestion);
    } else if (result) {
      const pending = pendingCityQuestion.get(scope);
      if (pending && Date.now() - pending.at <= CITY_CHOICE_TTL_MS && pending.key !== cacheKey &&
          pending.candidates.some((c) => normalizeText(c) === normalizeText(result.name))) {
        cityChoices.set(scope + "|" + pending.key, { name: result.name, at: Date.now() });
        trimMap(cityChoices);
        pendingCityQuestion.delete(scope);
        console.error("=== Miasto: zapamietany wybor w tym czacie: \"" + pending.key.split(":")[1] + "\" -> " + result.name + ".");
      }
    }
  }
  return result;
}

async function resolveCityIdInner(
  client: BookingApiClient,
  cityName: string,
  country: string,
  normCountry: string,
  normName: string,
  cacheKey: string
): Promise<CitySearchResult | null> {

  const cached = cityCache.get(cacheKey);
  if (cached) {
    console.error("=== Miasto z cache: \"" + cityName + "\" -> " + cached.name +
      " (id=" + cached.city_id + ")");
    return {
      city_id: cached.city_id,
      name: cached.name,
      country: normCountry,
      name_variants: cached.name_variants,
    };
  }

  // Cala lista miast kraju (z cache) - WSZYSTKIE dokladne dopasowania, zeby
  // wykryc kazdy duplikat nazwy (patrz komentarz nad funkcja).
  const exactMatches: CachedCity[] = [];
  for (const c of await loadCountryCities(client, normCountry)) {
    if (c.norm === normName && !exactMatches.some((m) => m.city_id === c.id)) {
      exactMatches.push({ city_id: c.id, name: c.name, name_variants: c.variants });
    }
  }

  // === NAZWA NIE IDENTYCZNA (2026-10-30, zgloszenie: "Frankfurt") ===
  // Booking.com ma "Frankfurt am Main" i "Frankfurt (Oder)" - samo "Frankfurt"
  // nie mialo identycznego dopasowania i agent konczyl na "sprawdz pisownie".
  // 1) nazwa w innym jezyku z bazy Booking.com, 2) nazwa zaczynajaca sie od
  // podanej ("Frankfurt " / "Frankfurt (" / "Frankfurt-"). Jedno miasto -> bierzemy;
  // kilka roznych -> NIE zgadujemy, agent ma zapytac usera (decyzja uzytkownika).
  let matchHow = "";
  if (exactMatches.length === 0) {
    const all = await loadCountryCities(client, normCountry);
    for (const c of all) {
      if (c.variants.some((v) => normalizeText(v) === normName) && !exactMatches.some((m) => m.city_id === c.id)) {
        exactMatches.push({ city_id: c.id, name: c.name, name_variants: c.variants });
      }
    }
    if (exactMatches.length > 0) matchHow = "nazwa w innym jezyku";
    if (exactMatches.length === 0 && normName.length >= 3) {
      const prefixed = all.filter((c) => {
        if (c.norm.indexOf(normName) !== 0 || c.norm.length === normName.length) return false;
        return " (-,/".indexOf(c.norm.charAt(normName.length)) !== -1;
      });
      const distinctNames = Array.from(new Set(prefixed.map((c) => c.name)));
      if (distinctNames.length === 1) {
        for (const c of prefixed) exactMatches.push({ city_id: c.id, name: c.name, name_variants: c.variants });
        matchHow = "jedyne miasto zaczynajace sie od tej nazwy";
      } else if (distinctNames.length > 1) {
        ambiguousCities.set(normCountry + ":" + normName, distinctNames.slice(0, 10));
        console.error("=== Miasto NIEJEDNOZNACZNE: \"" + cityName + "\" w kraju \"" + country + "\" -> " +
          JSON.stringify(distinctNames.slice(0, 10)) + " - agent ma zapytac usera.");
        return null;
      }
    }
    if (matchHow) {
      console.error("=== Miasto: \"" + cityName + "\" bez identycznej nazwy - " + matchHow + ": " +
        JSON.stringify(Array.from(new Set(exactMatches.map((m) => m.name)))));
    }
  }

  if (exactMatches.length === 0) {
    console.error("=== Miasto NIE rozwiazane: \"" + cityName + "\" w kraju \"" + country + "\"");
    return null;
  }

  let chosen: CachedCity;

  if (exactMatches.length === 1) {
    chosen = exactMatches[0];
    console.error("=== Miasto rozwiazane: \"" + cityName + "\" -> " + chosen.name +
      " (id=" + chosen.city_id + "), jedno dopasowanie, bez duplikatow.");
  } else {
    // DUPLIKAT NAZWY MIASTA - dziala dla DOWOLNEJ liczby duplikatow (2, 3, ...).
    console.error("=== OSTRZEZENIE: znaleziono " + exactMatches.length +
      " zduplikowanych wpisow miasta \"" + cityName + "\" w kraju \"" + country +
      "\" w bazie Booking.com (city_id: " + exactMatches.map((m) => m.city_id).join(", ") +
      "). Sprawdzam realna liczbe hoteli w kazdym wariancie...");

    const counts = await Promise.all(
      exactMatches.map((m) => countHotelsForCity(client, m.city_id))
    );

    console.error("=== DIAG resolveCityId: liczba hoteli per city_id dla \"" + cityName + "\": " +
      exactMatches.map((m, i) => m.city_id + "=" + counts[i] + "szt.").join(", "));

    let bestIndex = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] > counts[bestIndex]) bestIndex = i;
    }
    chosen = exactMatches[bestIndex];

    console.error("=== Wybrano city_id=" + chosen.city_id + " dla \"" + cityName + "\" (" +
      counts[bestIndex] + " hoteli) sposrod " + exactMatches.length + " duplikatow w bazie.");
  }

  // Cache'ujemy WYLACZNIE ten, w pelni zweryfikowany finalny wynik - dla
  // miasta bedacego bezposrednim celem TEGO wywolania.
  const finalKey = normCountry + ":" + normalizeText(chosen.name);
  cityCache.set(finalKey, chosen);
  // Takze pod kluczem zapytania (inna pisownia tej samej nazwy) - bez tego kazde
  // takie zapytanie liczylo duplikaty od nowa (zapytania /search).
  cityCache.set(cacheKey, chosen);

  return {
    city_id: chosen.city_id,
    name: chosen.name,
    country: normCountry,
    name_variants: chosen.name_variants,
  };
}

// Wyszukiwanie miast po fragmencie nazwy (dla narzedzia booking_search_cities).
// UWAGA: ta funkcja CELOWO nadal nie robi wyboru "najlepszego" wariantu
// (zwraca WSZYSTKIE pasujace wyniki) - user/model zawsze widzi pelna liste
// i decyduje sam, wiec nie ma tu ryzyka "cichego" bledu jak w resolveCityId.
export async function searchCities(
  client: BookingApiClient,
  query: string,
  country: string,
  limit: number
): Promise<Omit<CitySearchResult, "name_variants">[]> {
  const normCountry = country.toLowerCase().trim();
  const normQuery = normalizeText(query);
  const results: Omit<CitySearchResult, "name_variants">[] = [];
  const seen = new Set<number>();

  for (const c of await loadCountryCities(client, normCountry)) {
    if (c.norm.indexOf(normQuery) !== -1 && !seen.has(c.id)) {
      seen.add(c.id);
      results.push({ city_id: c.id, name: c.name, country: normCountry });
      if (results.length >= limit) return results;
    }
  }
  return results;
}
// Komunikat dla agenta, gdy resolveCityId zwrocilo null: przy kilku miastach -
// lista do wyboru przez usera; przy braku - podobne nazwy z kraju (zamiast
// samego "sprawdz pisownie", na ktorym agent sie zatrzymywal).
export async function cityNotFoundMessage(client: BookingApiClient, cityName: string, country: string): Promise<string> {
  const normCountry = country.toLowerCase().trim();
  const normName = normalizeText(cityName);
  const ambiguous = ambiguousCities.get(normCountry + ":" + normName);
  if (ambiguous && ambiguous.length > 1) {
    return "Several cities on Booking.com match \"" + cityName + "\" in country \"" + country + "\": " +
      ambiguous.join("; ") + ". Ask the user which one they mean (list these names) and STOP - do not pick one " +
      "yourself. Then search again with the full city name the user chose.";
  }
  let similar: string[] = [];
  try {
    const firstToken = normName.split(/[\s(,-]+/)[0] ?? "";
    if (firstToken.length >= 3) {
      const all = await loadCountryCities(client, normCountry);
      similar = Array.from(new Set(all
        .filter((c) => c.norm.indexOf(firstToken) !== -1 || c.variants.some((v) => normalizeText(v).indexOf(firstToken) !== -1))
        .map((c) => c.name))).slice(0, 8);
    }
  } catch { /* pomijamy podpowiedzi */ }
  if (similar.length > 0) {
    return "City \"" + cityName + "\" not found in country \"" + country + "\" on Booking.com. Similar city names: " +
      similar.join("; ") + ". If one of them clearly is what the user meant, search again with that exact name and " +
      "tell the user which city you used; if it is not clear, ask the user.";
  }
  return "City \"" + cityName + "\" not found in country \"" + country + "\" on Booking.com. Ask the user to check " +
    "the city name (in English) and the country.";
}
