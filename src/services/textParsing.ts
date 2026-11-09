// === PARSERY TRESCI PROSBY (09.11, Etap 1 planu naprawczego) ===
// Czyste funkcje bez zaleznosci od SDK i Booking.com - wydzielone z hotelSearch.ts,
// zeby testy regresji (test/*.test.mjs) sprawdzaly je przy kazdym wdrozeniu.
import { normalizeText } from "./textNormalize.js";

export const ALLOWED_HOTEL_ACCOMMODATION_TYPES = new Set([204, 205, 206, 218, 231]);

// Slowa wskazujace, ze user pyta o hotele przy konkretnym miejscu (patrz "PROSBA O HOTELE PRZY MIEJSCU").
export const NEAR_PLACE_RE = /(^|[^\p{L}])(ko[lł]o|przy|w pobli[zż]u|blisko|obok|niedaleko|dworz\p{L}*|dworc\p{L}*|stacj\p{L}*|lotnisk\p{L}*|near|close to|next to|airport|station)([^\p{L}]|$)/iu;

// === USER_REQUEST (v6, testy 2026-10-29) ===
// Mapa aktywnosci w Copilot Studio: hotelowy przekazal "Wyszukaj hotele 5-gwiazdkowe
// w okolicy lotniska Balice..." (bez odleglosci), a agent MCP sam wyslal radius_km:2.
// Przy Sukiennicach sam wyslal exclude_hostels:false. Opis narzedzia tego zabrania,
// ale model i tak to robi. Dlatego gdy przychodzi user_request (doslowny tekst prosby),
// promien i dopuszczenie hosteli ustala serwer z tego tekstu, a nie z pol od modelu.
export const USER_DISTANCE_RE = /(\d+(?:[.,]\d+)?)\s*(km\b|kilometr\w*|m\b|metr\w*)/i;
export const OTHER_ACCOMMODATION_RE = new RegExp(
  "hostel|apartament|apartment|pensjonat|kwater|b\\s*&\\s*b|bed and breakfast|willa|villa|" +
  "dowoln\\w* (typ|rodzaj|obiekt|nocleg)|any (type|kind|accommodation)|wszystkie (typy|rodzaje|obiekty)|" +
  // 06.11 (Ossendrecht): "inne obiekty noclegowe" - serwer wymuszal "tylko hotele"
  "obiekt\\w*\\s+nocleg|inn\\w*\\s+obiekt|nocleg(i|ów|ow|owe|owych)\\b|other (properties|accommodation)|any accommodation",
  "i");

// === TYPY OBIEKTOW Z PROSBY (06.11, zgloszenie Julii: "apartament kolo Magazynowej 7" - na liscie
// byly Holiday Inn Express i Centrum Barnabitow; decyzja: "robimy to, o co user poprosi") ===
// User wymienia typy -> pokazujemy tylko te typy (kilka naraz = suma). "hotel" obok innego typu
// dolacza typy hotelowe. Bez nazwy typu - tylko hotele (jak dotad); "obiekty noclegowe",
// "dowolny nocleg" - wszystkie typy. Zaprzeczenia ("bez hosteli", "nie apartament") sa pomijane.
export const REQUESTED_TYPE_RULES: { re: RegExp; types: number[]; label: string }[] = [
  { re: /apartament|apartment|\bstudio\b/i, types: [201], label: "apartamenty" },
  { re: /hostel/i, types: [203], label: "hostele" },
  { re: /\bb\s*&\s*b\b|\bbnb\b|bed\s*(and|&)\s*breakfast/i, types: [208], label: "B&B" },
  { re: /pensjonat|guest\s*house/i, types: [216], label: "pensjonaty" },
  { re: /\bwill(a|e|i|ę|ach)\b|\bvillas?\b/i, types: [213], label: "wille" },
  { re: /dom(y|ów|ow|ek|ki|ku|kach)?\s+wakacyjn|\bdomk(i|u|ów|ow|iem)?\b|\bdomek\b|holiday\s+home|vacation\s+home/i, types: [220], label: "domy wakacyjne" },
  { re: /kwater|pokoj\w*\s+go[sś]cinn|pokoje\s+go[sś]cinne|homestay/i, types: [222], label: "kwatery prywatne" },
];
export const HOTEL_WORD_RE = /\bhotel\w*|\bmotel\w*|\bzajazd\w*|\bresort\w*/i;
export const NEGATED_TYPE_RE = /(bez|nie|oprócz|oprocz|poza|except|without|not|no)\s+(\p{L}+(\s*&\s*\p{L}+)?)/giu;

export function requestedAccommodationTypes(text: string): { types: number[]; labels: string[] } | null {
  if (!text) return null;
  const t = text.replace(NEGATED_TYPE_RE, " ");
  const types = new Set<number>();
  const labels: string[] = [];
  for (const r of REQUESTED_TYPE_RULES) {
    if (r.re.test(t)) { r.types.forEach((x) => types.add(x)); labels.push(r.label); }
  }
  if (types.size === 0) return null;
  if (HOTEL_WORD_RE.test(t.replace(/hostel\w*/gi, " "))) {
    ALLOWED_HOTEL_ACCOMMODATION_TYPES.forEach((x) => types.add(x));
    labels.unshift("hotele");
  }
  return { types: Array.from(types).sort((a, b) => a - b), labels };
}

export function parseUserDistanceKm(text: string): number | null {
  const m = USER_DISTANCE_RE.exec(text);
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!isFinite(value) || value <= 0) return null;
  const km = /^k/i.test(m[2]) ? value : value / 1000;
  if (km < 0.1 || km > 50) return null;
  return Math.round(km * 1000) / 1000;
}

export const NEXT_BATCH_WORDS_RE = /(^|[^\p{L}])(dalej|kolejn\p{L}*|nast[eę]pn\p{L}*|wi[eę]cej|pozosta[lł]\p{L}*|reszt\p{L}*|next|more)([^\p{L}]|$)/iu;
export const NEXT_BATCH_MAX_LEN = 60;

export function isNextBatchRequest(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > NEXT_BATCH_MAX_LEN) return false;
  if (/\d\s*(\*|gwiazd|km|m\b|pln|zł|eur)/iu.test(t)) return false;
  return NEXT_BATCH_WORDS_RE.test(t);
}

export const STREET_PREFIX_RE = /^\s*(ul\.?|ulica|al\.?|aleja|aleje|pl\.?|plac|os\.?|osiedle)\s+/i;

export function alternativeNamesFromRequest(userText: string, given: string): string[] {
  const out: string[] = [];
  const g = normalizeText(given);
  const re = /(?:to jest|tj\.|czyli|\s[-–]\s)\s*([^.,;\n]{3,60})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(userText)) !== null) {
    const cand = m[1].trim().replace(/^(to jest|tj\.|czyli)\s+/i, "").replace(/\s+(nocleg|hotel|hotele|na)\b.*$/i, "").trim();
    if (cand.length >= 3 && normalizeText(cand) !== g && !normalizeText(cand).includes(g)) out.push(cand);
  }
  return out.slice(0, 2);
}

// === SNIADANIE / PARKING Z TRESCI PROSBY (02.11 i 05.11, przeniesione 09.11) ===
// "on" = user chce sniadania w cenie, "off" = wprost bez sniadania, null = nie wspomina.
export function breakfastIntent(text: string): "on" | "off" | null {
  if (!text) return null;
  const t = text.replace(/bed\s*(and|&)\s*breakfast|b\s*&\s*b/gi, " ");
  if (/bez\s+[sś]niada|without\s+breakfast|no\s+breakfast/i.test(t)) return "off";
  if (/[sś]niada|breakfast/i.test(t)) return "on";
  return null;
}

export function wantsParking(text: string): boolean {
  if (!text) return false;
  return /parking|garaż|garaz|\bparkowan/i.test(text) &&
    !/bez\s+parking|parking\s+(nie\s+jest\s+)?(niepotrzebny|zbędny|zbedny)|without\s+parking/i.test(text);
}

// === GOSCIE Z TRESCI PROSBY (09.11, zgloszenie Damiana: "dwoch doroslych z poltorarocznym
// dzieckiem" - przy dostepnosci jednego hotelu dziecko zginelo) ===
const NUM_WORDS: [RegExp, number][] = [
  [/^(jeden|jedna|jednej|jednego|jedno|one|single)$/i, 1],
  [/^(dwa|dwie|dw[oó]ch|dwoje|dwojga|dwu|dwojgiem|two|para|pary)$/i, 2],
  [/^(trzy|trzech|troje|trojga|three)$/i, 3],
  [/^(cztery|czterech|czworo|czworga|four)$/i, 4],
  [/^(pi[eę][cć]|pi[eę]ciu|pi[eę]cioro|five)$/i, 5],
  [/^(sze[sś][cć]|sze[sś]ciu|six)$/i, 6],
];
function numberOf(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  for (const [re, n] of NUM_WORDS) if (re.test(word)) return n;
  return null;
}
const NUM = "(\\d{1,2}|[a-ząćęłńóśźż]+)";
// wiek slowem przed "-letni"/"-roczny": "dwuletnim", "trzyletnia", "polroczny"
const AGE_PREFIX: [RegExp, number][] = [
  [/^p[oó][lł]torarocz/i, 1], [/^p[oó][lł]rocz/i, 0], [/^rocz/i, 1], [/^jednorocz/i, 1],
  [/^dwu(letn|rocz)/i, 2], [/^trzy(letn|rocz)/i, 3], [/^cztero(letn|rocz)/i, 4], [/^pi[eę]cio(letn|rocz)/i, 5],
  [/^sze[sś]cio(letn|rocz)/i, 6], [/^siedmio(letn|rocz)/i, 7], [/^o[sś]mio(letn|rocz)/i, 8],
  [/^dziewi[eę]cio(letn|rocz)/i, 9], [/^dziesi[eę]cio(letn|rocz)/i, 10],
];
const CHILD_RE = /dzieck|dzieci|dzie[cć]mi|syn|c[oó]rk|niemowl|noworod|child|kid|baby|infant|toddler/i;

export interface GuestsFromText {
  adults?: number;
  rooms?: number;
  children_count?: number;
  children_ages?: number[];
}

export function parseGuestsFromText(text: string): GuestsFromText {
  const out: GuestsFromText = {};
  if (!text) return out;
  const t = text.toLowerCase();
  let m: RegExpExecArray | null;
  // dorosli: "2 osoby", "dwoch doroslych", "dla 3 osob", "2 adults"
  m = new RegExp("(?:^|[^\\p{L}\\d])" + NUM + "\\s+(doros[lł]\\p{L}*|os[oó]b\\p{L}*|adults?|persons?|people|guests?)", "iu").exec(t);
  if (m) {
    const n = numberOf(m[1]);
    if (n && n >= 1 && n <= 30) out.adults = n;
  } else if (/(^|[^\p{L}])(we\s+dwoje|dla\s+dwojga|para\b|parze\b|couple)/iu.test(t)) {
    out.adults = 2;
  }
  // pokoje: "2 pokoje", "trzy pokoje", "2 rooms" ("pokoje goscinne" to typ obiektu, nie liczba)
  m = new RegExp("(?:^|[^\\p{L}\\d])" + NUM + "\\s+(pokoje|pokoi|pokoj[oó]w|pok[oó]j|rooms?)(?![\\p{L}])(?!\\s+go[sś]cinn)", "iu").exec(t);
  if (m) {
    const n = numberOf(m[1]);
    if (n && n >= 1 && n <= 30) out.rooms = n;
  }
  if (!CHILD_RE.test(t)) return out;
  // wiek: "5 lat", "5-letnie", "3 i 7 lat", "1,5 roku", "polrocznym", "dwuletnia", "niemowle"
  const ages: number[] = [];
  const listRe = /(\d{1,2})(?:[.,]5)?(?:\s*(?:,|i|oraz|and)\s*(\d{1,2})(?:[.,]5)?)*\s*(?:-\s*)?(lat\p{L}*|letn\p{L}*|rok\p{L}*|roczn\p{L}*|years?|y\.?o\.?|yrs?)/giu;
  while ((m = listRe.exec(t)) !== null) {
    const nums = m[0].match(/\d{1,2}(?:[.,]5)?/g) ?? [];
    for (const n of nums) {
      const v = Math.floor(Number(n.replace(",", ".")));
      if (v >= 0 && v <= 17) ages.push(v);
    }
  }
  for (const w of t.split(/[^\p{L}]+/u)) {
    if (!w) continue;
    for (const [re, age] of AGE_PREFIX) {
      if (re.test(w) && /(letn|rocz)/i.test(w)) { ages.push(age); break; }
    }
    if (/^(niemowl|noworod|infant|baby)/i.test(w)) ages.push(0);
  }
  // liczba dzieci: "2 dzieci", "dwoje dzieci", "z dzieckiem" = 1
  let count: number | null = null;
  m = new RegExp("(?:^|[^\\p{L}\\d])" + NUM + "\\s+(dzieci|dzieckiem|dziecko|dzie[cć]mi|children|kids)", "iu").exec(t);
  if (m) count = numberOf(m[1]);
  if (count == null && /dzieck|child\b|kid\b|baby|niemowl|infant|toddler|syn\p{L}*|c[oó]rk\p{L}*/iu.test(t)) count = 1;
  if (ages.length > 0) {
    out.children_ages = ages.slice(0, 10);
    out.children_count = Math.max(ages.length, count ?? 0);
  } else if (count != null && count > 0) {
    out.children_count = count;
  }
  return out;
}

// === UDOGODNIENIA OD AGENTA (09.11, Etap 1: zgloszenie Damiana - agent wyslal "playroom",
// schemat znal 9 wartosci i odrzucil cale wywolanie, a asystent odpisal "nie udalo sie") ===
// Agent moze wyslac dowolne slowo; znane synonimy mapujemy na klucze filtra, nieznane
// wracaja do agenta jako "nie umiem filtrowac po" (wyszukiwanie idzie dalej bez nich).
export const FACILITY_KEYS = ["pool", "gym", "parking", "wifi", "air_conditioning", "spa", "restaurant", "sauna", "pets_allowed"] as const;
const FACILITY_SYNONYMS: Record<string, string> = {
  pool: "pool", swimming_pool: "pool", basen: "pool", indoor_pool: "pool", outdoor_pool: "pool",
  gym: "gym", fitness: "gym", fitness_center: "gym", fitness_centre: "gym", silownia: "gym",
  parking: "parking", free_parking: "parking", car_park: "parking", garage: "parking", garaz: "parking",
  wifi: "wifi", wi_fi: "wifi", internet: "wifi", free_wifi: "wifi",
  air_conditioning: "air_conditioning", aircon: "air_conditioning", ac: "air_conditioning", klimatyzacja: "air_conditioning",
  spa: "spa", wellness: "spa", spa_and_wellness: "spa",
  restaurant: "restaurant", restauracja: "restaurant",
  sauna: "sauna",
  pets_allowed: "pets_allowed", pets: "pets_allowed", pet_friendly: "pets_allowed", zwierzeta: "pets_allowed", dogs_allowed: "pets_allowed",
};

export function normalizeFacilities(values: unknown): { known: string[]; unsupported: string[] } {
  const known: string[] = [];
  const unsupported: string[] = [];
  if (!Array.isArray(values)) return { known, unsupported };
  for (const v of values) {
    if (typeof v !== "string" || !v.trim()) continue;
    const k = normalizeText(v).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const key = FACILITY_SYNONYMS[k];
    if (key) { if (!known.includes(key)) known.push(key); }
    else if (!unsupported.includes(v.trim())) unsupported.push(v.trim());
  }
  return { known, unsupported };
}
