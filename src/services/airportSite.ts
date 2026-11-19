// === OFICJALNA STRONA LOTNISKA (19.11) - dla Asystenta Lotniczego (AL) w Copilot Studio ===
// Tematy "Lotniska" i "Saloniki" w AL przeszukiwaly domene lotniska zgadnieta przez model.
// Test Artura (BKK) skonczyl sie nieoficjalnym bangkokairportonline.com zamiast
// suvarnabhumi.airportthai.co.th. Teraz domene bierzemy z profilu lotniska w Google Places
// (pole websiteUri), sprawdzamy, czy nie jest to znany serwis-przewodnik, i oddajemy agentowi.
// Klucz Google zostaje w Azure - AL wola tylko endpoint GET /api/airport-site (src/index.ts).
// Pamiec wg kodu IATA na 90 dni (lotnisk jest skonczona liczba, strony zmieniaja sie rzadko).
import { config } from "../config.js";
import { countPlacesRequest, googlePlacesEnabled } from "./googlePlaces.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
// websiteUri to pole Enterprise - zapytanie liczy sie jako Text Search Enterprise (jak w hotelach).
const FIELD_MASK = ["places.id", "places.displayName", "places.formattedAddress", "places.websiteUri", "places.types"].join(",");
const TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

export interface AirportSite {
  found: boolean;
  iata: string | null;
  google_name: string | null;
  address: string | null;
  url: string | null;      // pelny adres z Google (moze miec sciezke, np. aena.es/en/madrid-barajas.html)
  domain: string | null;   // sam host bez "www." - to idzie do Global.DomenaTekst w AL
  source: "google" | "cache" | "none";
  reason?: "not_found" | "no_website" | "unofficial" | "error" | "disabled" | "bad_request";
}

// Serwisy, ktore nie sa strona zarzadcy lotniska. Lista celowo wprost, bez wzorcow typu
// "<miasto>-airport.com" - takie domeny bywaja oficjalne (frankfurt-airport.com, katowice-airport.com).
const UNOFFICIAL_DOMAINS = [
  "wikipedia.org", "wikivoyage.org", "tripadvisor.", "booking.com", "expedia.", "skyscanner.", "kayak.",
  "google.", "facebook.com", "instagram.com", "flightradar24.com", "flightaware.com", "airportguide.com",
  "airport-guide.com", "airports-worldwide.com", "airport-information.com", "sleepinginairports.net",
];
// Fragmenty nazw typowe dla przewodnikow: bangkokairportonline.com, istanbul-airport-online.com itd.
const UNOFFICIAL_PATTERNS = [/airport-?online/i, /airports?-?guide/i, /airport-?info\./i, /flights?-?info/i];

export function domainFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).hostname.toLowerCase();
    return host.replace(/^www\d?\./, "") || null;
  } catch {
    return null;
  }
}

export function isUnofficialDomain(domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  if (UNOFFICIAL_DOMAINS.some((u) => (u.endsWith(".") ? d.includes(u) : d === u || d.endsWith("." + u)))) return true;
  return UNOFFICIAL_PATTERNS.some((re) => re.test(d));
}

export function normalizeIata(iata: unknown): string | null {
  if (typeof iata !== "string") return null;
  const v = iata.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : null;
}

// Pierwszy samodzielny kod z trzech wielkich liter, np. "Bangkok Suvarnabhumi (BKK)" -> BKK.
export function iataFromText(text: string): string | null {
  const m = /(?:^|[^A-Za-z])([A-Z]{3})(?![A-Za-z])/.exec(text ?? "");
  return m ? m[1] : null;
}

const cache = new Map<string, { at: number; value: AirportSite }>();

function empty(iata: string | null, reason: AirportSite["reason"]): AirportSite {
  return { found: false, iata, google_name: null, address: null, url: null, domain: null, source: "none", reason };
}

// iata - kod IATA lotniska (zalecany), name - nazwa lotniska lub miasto (pomocniczo).
export async function findAirportSite(iataIn: unknown, nameIn: unknown): Promise<AirportSite> {
  let name = typeof nameIn === "string" ? nameIn.trim().slice(0, 120) : "";
  // monit AL zwraca "BRAK", gdy nie rozpoznal lotniska - nie szukamy wtedy "BRAK airport"
  if (/^brak$/i.test(name)) name = "";
  // Temat w AL przekazuje to, co monit wpisal jako lotnisko (np. "Bangkok Suvarnabhumi (BKK)") -
  // kod IATA wyciagamy sami, zeby w Copilot Studio nie trzeba bylo regexow.
  const iata = normalizeIata(iataIn) ?? iataFromText(name);
  if (!iata && !name) return empty(null, "bad_request");
  if (!googlePlacesEnabled()) return empty(iata, "disabled");

  const key = iata ?? "name:" + name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    console.error("=== [AL] Lotnisko z pamieci " + key + " -> " + (hit.value.domain ?? hit.value.reason));
    return { ...hit.value, source: hit.value.found ? "cache" : "none" };
  }

  const query = [iata, name, "airport"].filter(Boolean).join(" ");
  const started = Date.now();
  const n = countPlacesRequest();
  let value: AirportSite;
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, includedType: "airport", strictTypeFiltering: true, languageCode: "en", pageSize: 3 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j: any = await r.json();
    if (!r.ok) {
      console.error("=== [AL] Google Places: blad " + r.status + " " + JSON.stringify(j?.error?.message ?? j).slice(0, 300));
      return empty(iata, "error"); // bledu nie zapamietujemy - nastepne pytanie sprobuje ponownie
    }
    const places: any[] = Array.isArray(j?.places) ? j.places : [];
    const isAirport = (p: any) => Array.isArray(p?.types) && p.types.some((t: string) => /airport/.test(t));
    const p = places.find((x) => isAirport(x) && x.websiteUri) ?? places.find(isAirport) ?? null;
    if (!p) value = empty(iata, "not_found");
    else {
      const url: string | null = p.websiteUri ?? null;
      const domain = domainFromUrl(url);
      const base = { iata, google_name: p.displayName?.text ?? null, address: p.formattedAddress ?? null };
      if (!domain) value = { ...empty(iata, "no_website"), ...base };
      else if (isUnofficialDomain(domain)) value = { ...empty(iata, "unofficial"), ...base, url };
      else value = { found: true, ...base, url, domain, source: "google" };
    }
    console.error("=== [AL] Google Places: \"" + query + "\" -> " + (value.found ? value.google_name + " = " + value.domain : value.reason +
      (value.url ? " (" + value.url + ")" : "")) + ", " + (Date.now() - started) + " ms, zapytanie nr " + n + " dzisiaj");
  } catch (err) {
    console.error("=== [AL] Google Places: blad polaczenia: " + (err instanceof Error ? err.message : String(err)));
    return empty(iata, "error");
  }
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 3000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}
