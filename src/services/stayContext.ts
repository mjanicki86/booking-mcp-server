// === WSPOLNY KONTEKST POBYTU (09.11, Etap 1 planu naprawczego) ===
// Wczesniej kazde narzedzie mialo wlasne parametry pobytu: wyszukiwanie znalo dzieci, a dostepnosc
// jednego hotelu nie (zgloszenie Damiana 09.11 - dziecko zginelo), daty z tresci prosby (06.11)
// dzialaly tylko w wyszukiwaniu. Teraz kazde narzedzie ustala daty i gosci tutaj, w tej kolejnosci:
//   1) parametry od agenta, 2) tresc prosby (user_request), 3) pamiec rozmowy (60 min), 4) domyslne.
// Jedna linia w logu mowi, skad wziela sie kazda wartosc.
import { fixStayDates, warsawToday } from "./dates.js";
import { parseGuestsFromText } from "./textParsing.js";

// 60 min od OSTATNIEGO uzycia w czacie (okno przesuwne) - jak wczesniej daty w hotelSearch
// (test 2026-10-30: Teams 1:1 z botem to jeden czat, serwer nie widzi nowej sesji).
const TTL_MS = 60 * 60 * 1000;

interface Memory {
  checkin?: string;
  checkout?: string;
  adults?: number;
  rooms?: number;
  children_ages?: number[];
  at: number;
}
const memory = new Map<string, Memory>();

function recall(scope: string): Memory | null {
  if (!scope) return null;
  const m = memory.get(scope);
  if (!m || Date.now() - m.at > TTL_MS) return null;
  m.at = Date.now();
  return m;
}

function store(scope: string, patch: Partial<Memory>): void {
  if (!scope) return;
  const m = memory.get(scope);
  const base: Memory = m && Date.now() - m.at <= TTL_MS ? m : { at: Date.now() };
  Object.assign(base, patch, { at: Date.now() });
  memory.set(scope, base);
  if (memory.size > 2000) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
}

export type Source = "agent" | "tekst" | "rozmowa" | "domyslnie";

export interface StayInput {
  checkin?: string;
  checkout?: string;
  adults?: number;
  rooms?: number;
  children_count?: number;
  children_ages?: number[];
  user_request?: string;
}

export interface Stay {
  checkin?: string;           // brak = narzedzie samo decyduje (wyszukiwanie: daty przykladowe)
  checkout?: string;
  dates_source: Source;
  adults: number;
  rooms: number;
  children_ages: number[];
  children_without_age: number; // dzieci podane bez wieku (trzeba dopytac)
  sources: { dates: Source; adults: Source; rooms: Source; children: Source };
  pastError?: string;          // data w przeszlosci, ktorej nie da sie poprawic
}

const NO_CHILDREN_RE = /bez\s+dzie|bez\s+dziecka|bez\s+dzieci|without\s+(the\s+)?(kids|children|child)/i;

export interface ResolveOptions {
  quiet?: boolean;        // bez logu i bez zapisu do pamieci (powtorka przy poszerzaniu promienia)
  ignoreDates?: boolean;  // narzedzie samo wybiera terminy (dostepnosc: miesiac / najblizszy wolny)
}

export function resolveStay(scope: string, input: StayInput, tool: string, opts: ResolveOptions = {}): Stay {
  const quiet = !!opts.quiet;
  const text = typeof input.user_request === "string" ? input.user_request : "";
  const mem = recall(scope);
  const fromText = parseGuestsFromText(text);

  // --- daty
  const agentDates = !opts.ignoreDates && !!(input.checkin || input.checkout);
  const fixed = opts.ignoreDates ? { checkin: undefined, checkout: undefined, pastError: undefined, oneNightAdded: false }
    : fixStayDates(input.checkin, input.checkout, text, quiet ? "=== (powtorka) daty" : "=== DIAG daty");
  let checkin = fixed.checkin;
  let checkout = fixed.checkout;
  let datesSource: Source = agentDates ? "agent" : checkin ? "tekst" : "domyslnie";
  if (!opts.ignoreDates && !checkin && !checkout && mem?.checkin && mem.checkout && mem.checkin >= warsawToday()) {
    checkin = mem.checkin;
    checkout = mem.checkout;
    datesSource = "rozmowa";
  }

  // --- dorosli / pokoje
  let adults: number;
  let adultsSource: Source;
  if (input.adults != null) { adults = input.adults; adultsSource = "agent"; }
  else if (fromText.adults != null) { adults = fromText.adults; adultsSource = "tekst"; }
  else if (mem?.adults != null) { adults = mem.adults; adultsSource = "rozmowa"; }
  else { adults = 1; adultsSource = "domyslnie"; }

  let rooms: number;
  let roomsSource: Source;
  if (input.rooms != null) { rooms = input.rooms; roomsSource = "agent"; }
  else if (fromText.rooms != null) { rooms = fromText.rooms; roomsSource = "tekst"; }
  else if (mem?.rooms != null) { rooms = mem.rooms; roomsSource = "rozmowa"; }
  else { rooms = 1; roomsSource = "domyslnie"; }

  // --- dzieci: wiek od agenta, potem z tekstu, potem z rozmowy; "bez dzieci" czysci
  let ages: number[] = [];
  let childrenSource: Source = "domyslnie";
  let withoutAge = 0;
  if (Array.isArray(input.children_ages) && input.children_ages.length > 0) {
    ages = input.children_ages.slice();
    childrenSource = "agent";
  } else if (fromText.children_ages && fromText.children_ages.length > 0) {
    ages = fromText.children_ages;
    childrenSource = "tekst";
  } else if (NO_CHILDREN_RE.test(text)) {
    ages = [];
    childrenSource = "tekst";
  } else if ((input.children_count ?? 0) > 0 || (fromText.children_count ?? 0) > 0) {
    withoutAge = Math.max(input.children_count ?? 0, fromText.children_count ?? 0);
    childrenSource = (input.children_count ?? 0) > 0 ? "agent" : "tekst";
  } else if (mem?.children_ages && mem.children_ages.length > 0) {
    ages = mem.children_ages.slice();
    childrenSource = "rozmowa";
  }
  // agent podal liczbe dzieci wieksza niz liczba znanych wiekow
  if (ages.length > 0 && (input.children_count ?? 0) > ages.length) withoutAge = (input.children_count ?? 0) - ages.length;

  // --- pamiec: tylko wartosci podane wprost (agent / tekst), nie domyslne
  const patch: Partial<Memory> = {};
  if (checkin && checkout && !fixed.pastError && (datesSource === "agent" || datesSource === "tekst")) {
    patch.checkin = checkin; patch.checkout = checkout;
  }
  if (adultsSource === "agent" || adultsSource === "tekst") patch.adults = adults;
  if (roomsSource === "agent" || roomsSource === "tekst") patch.rooms = rooms;
  if (childrenSource === "agent" || childrenSource === "tekst") patch.children_ages = ages;
  if (!quiet && Object.keys(patch).length > 0) store(scope, patch);

  if (!quiet) {
    console.error("=== DIAG pobyt [" + tool + "]: daty " + (opts.ignoreDates ? "wybiera narzedzie" : checkin ? checkin + " - " + checkout : "brak") +
      " (" + datesSource + "), dorosli " + adults + " (" + adultsSource + "), dzieci " +
      (ages.length > 0 ? JSON.stringify(ages) : withoutAge > 0 ? withoutAge + " bez wieku" : "brak") +
      " (" + childrenSource + "), pokoje " + rooms + " (" + roomsSource + ").");
  }

  return {
    checkin, checkout, dates_source: datesSource,
    adults, rooms, children_ages: ages, children_without_age: withoutAge,
    sources: { dates: datesSource, adults: adultsSource, rooms: roomsSource, children: childrenSource },
    pastError: fixed.pastError,
  };
}

// Tekst dla agenta, gdy brakuje wieku dzieci (Booking.com liczy cene dzieci tylko z ich wieku).
export function childAgesQuestion(stay: Stay): string {
  return "The age of each child is needed for correct prices and availability (" + stay.children_without_age +
    " child(ren) without age). Suggested reply: a question about the age of each child; then call again with children_ages.";
}

// Do testow: czysci pamiec rozmow.
export function _resetStayMemory(): void {
  memory.clear();
}
