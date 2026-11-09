// === GOOGLE PLACES (09.11) - strona WWW i telefon hotelu ===
// Booking.com nie podaje strony hotelu, a "kontakt" w Booking.com to dane firmy prowadzacej
// obiekt (Bedford Swan 03.11). Google Places (Text Search, API "Places API (New)") daje strone
// WWW i telefon recepcji. Uzycie tylko na pytanie o jeden hotel (kontakt / parking), wynik
// pamietany 30 dni per hotel. Limity po stronie Google: 300 zapytan Text Search dziennie.
import { config } from "../config.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
// Tylko potrzebne pola - telefon i strona WWW to kategoria Enterprise (Text Search Enterprise).
const FIELD_MASK = [
  "places.id", "places.displayName", "places.formattedAddress", "places.websiteUri",
  "places.internationalPhoneNumber", "places.nationalPhoneNumber", "places.googleMapsUri", "places.types",
].join(",");
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PlaceInfo {
  place_id: string;
  name: string;
  address: string | null;
  website: string | null;
  phone: string | null;
  maps_url: string | null;
  is_lodging: boolean;
}

const cache = new Map<string, { at: number; value: PlaceInfo | null }>();
let requestsToday = 0;
let requestsDay = "";

export function googlePlacesEnabled(): boolean {
  return !!config.googlePlacesApiKey;
}

function countRequest(): number {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== requestsDay) { requestsDay = day; requestsToday = 0; }
  return ++requestsToday;
}

// Szuka hotelu po nazwie i adresie (albo miescie). null = nie znaleziono albo brak klucza.
export async function findPlace(name: string, addressOrCity: string, opts: { lat?: number; lon?: number } = {}): Promise<PlaceInfo | null> {
  if (!googlePlacesEnabled()) return null;
  const query = (name + ", " + addressOrCity).trim();
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    console.error("=== Google Places: z pamieci \"" + query + "\" -> " + (hit.value ? hit.value.name : "brak"));
    return hit.value;
  }
  const body: any = { textQuery: query, languageCode: "pl", pageSize: 3 };
  if (opts.lat != null && opts.lon != null) {
    body.locationBias = { circle: { center: { latitude: opts.lat, longitude: opts.lon }, radius: 2000 } };
  }
  const started = Date.now();
  const n = countRequest();
  let value: PlaceInfo | null = null;
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.googlePlacesApiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const j: any = await r.json();
    if (!r.ok) {
      // komunikat bledu Google nie zawiera klucza
      console.error("=== Google Places: blad " + r.status + " " + JSON.stringify(j?.error?.message ?? j).slice(0, 300));
      return null;
    }
    const places: any[] = Array.isArray(j?.places) ? j.places : [];
    const lodging = places.find((p) => Array.isArray(p.types) && p.types.some((t: string) => /lodging|hotel/.test(t)));
    const p = lodging ?? places[0];
    if (p) {
      value = {
        place_id: p.id,
        name: p.displayName?.text ?? "",
        address: p.formattedAddress ?? null,
        website: p.websiteUri ?? null,
        phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
        maps_url: p.googleMapsUri ?? null,
        is_lodging: !!lodging,
      };
    }
    console.error("=== Google Places: \"" + query + "\" -> " + (value ? value.name + " (" + (value.address ?? "") + ")" : "brak") +
      ", " + (Date.now() - started) + " ms, zapytanie nr " + n + " dzisiaj");
  } catch (err) {
    console.error("=== Google Places: blad polaczenia: " + (err instanceof Error ? err.message : String(err)));
    return null;
  }
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 5000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}
