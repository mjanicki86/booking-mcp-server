// === DATY POBYTU (05.11, test "hotele w Warszawie na dzis") ===
// 1) Model zamienil dzien z miesiacem ("na dzis" 05.11 -> 2026-05-11, data z przeszlosci).
// 2) Przy samym zameldowaniu serwer bral wymeldowanie z przykladowego terminu za ~3 mies.
//    -> 94 noce i blad 400 Booking.com (maks. 90 nocy).
// Zasady: "dzis/today" i "jutro/tomorrow" liczy serwer (czas polski), 1 noc;
// data z przeszlosci, ktora po zamianie dnia z miesiacem jest poprawna -> zamiana;
// samo zameldowanie -> 1 noc; samo wymeldowanie -> zameldowanie dzien wczesniej;
// data z przeszlosci nie do naprawienia -> czytelny komunikat zamiast bledu Booking.com.

const TODAY_RE = /(^|[^\p{L}])(dzi[sś]|dzisiaj|dzisiejsz\p{L}*|today|tonight)([^\p{L}]|$)/iu;
const TOMORROW_RE = /(^|[^\p{L}])(jutr\p{L}*|tomorrow)([^\p{L}]|$)/iu;

export function warsawToday(): string {
  // en-CA daje format RRRR-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

export function addDaysIso(s: string, n: number): string {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

function isValidIso(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

// 2026-05-11 -> 2026-11-05 (tylko gdy dzien <= 12, czyli zamiana daje poprawny miesiac)
function swapDayMonth(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || m[2] === m[3] || Number(m[3]) > 12) return null;
  const swapped = m[1] + "-" + m[3] + "-" + m[2];
  return isValidIso(swapped) ? swapped : null;
}

// === DATY Z TRESCI PROSBY (06.11, zgloszenie Julii: "apartament kolo Magazynowej 7 ... termin 15-16.12"
// - agent nie przekazal dat, serwer wzial 16-18.12 z wczesniejszego pytania, a agent napisal 15-16.12) ===
// Obslugiwane: "15-16.12", "15–16.12.2026", "15.12-16.12", "10-11/11", "30.12-2.01", "15-16 grudnia",
// "od 15.12 do 16.12", pojedyncza data po "na/od/dnia/w dniu/on" ("na 10.12" -> 1 noc).
const MONTHS_PL: Record<string, number> = {
  stycz: 1, lut: 2, marc: 3, marz: 3, kwiet: 4, kwiec: 4, maj: 5, czerw: 6, lip: 7, sierp: 8,
  wrzes: 9, wrzesn: 9, pazdz: 10, list: 11, grud: 12,
};
function monthFromWord(w: string): number | null {
  const n = w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");
  for (const [k, v] of Object.entries(MONTHS_PL)) if (n.startsWith(k)) return v;
  return null;
}

function pad(n: number): string { return (n < 10 ? "0" : "") + n; }

// Dzien/miesiac(/rok) -> RRRR-MM-DD; bez roku: najblizszy przyszly (dzis lub pozniej).
function toIso(day: number, month: number, year: number | null, today: string): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let y = year != null ? (year < 100 ? 2000 + year : year) : Number(today.slice(0, 4));
  let s = y + "-" + pad(month) + "-" + pad(day);
  if (!isValidIso(s)) return null;
  if (year == null && s < today) {
    y += 1;
    s = y + "-" + pad(month) + "-" + pad(day);
    if (!isValidIso(s)) return null;
  }
  return s;
}

export function parseDatesFromText(text: string, today: string = warsawToday()): { checkin: string; checkout?: string } | null {
  if (!text) return null;
  const t = text.replace(/[–—]/g, "-");
  const yr = (s: string | undefined) => (s ? Number(s) : null);
  // 1) zakres z liczbowym miesiacem: 15-16.12 | 15.12-16.12 | 30.12-2.01 | 10-11/11 | 15/12-16/12/2026
  let m = /(?:^|[^\d.,\/])(\d{1,2})(?:[.\/](\d{1,2}))?(?:[.\/](\d{2,4}))?\.?\s*(?:-|do)\s*(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?(?!\d|[.,]\d)/.exec(t);
  if (m) {
    const endYear = yr(m[6]);
    const endMonth = Number(m[5]);
    const startMonth = m[2] ? Number(m[2]) : endMonth;
    const startYear = m[3] ? yr(m[3]) : endYear;
    let ci = toIso(Number(m[1]), startMonth, startYear, today);
    let co = toIso(Number(m[4]), endMonth, endYear, today);
    if (ci && co && co <= ci && endYear == null) {
      // przelom roku: 30.12-2.01
      co = toIso(Number(m[4]), endMonth, Number(ci.slice(0, 4)) + 1, today);
    }
    if (ci && co && co > ci) return { checkin: ci, checkout: co };
  }
  // 2a) "3 stycznia - 5 stycznia", "od 30 grudnia do 2 stycznia"
  m = /(?:^|\D)(\d{1,2})\s+([a-ząćęłńóśźż]{3,})\s*(?:-|do)\s*(\d{1,2})\s+([a-ząćęłńóśźż]{3,})(?:\s+(\d{4}))?/i.exec(t);
  if (m) {
    const m1 = monthFromWord(m[2]);
    const m2 = monthFromWord(m[4]);
    if (m1 && m2) {
      const ci = toIso(Number(m[1]), m1, yr(m[5]), today);
      let co = toIso(Number(m[3]), m2, yr(m[5]), today);
      if (ci && co && co <= ci && !m[5]) co = toIso(Number(m[3]), m2, Number(ci.slice(0, 4)) + 1, today);
      if (ci && co && co > ci) return { checkin: ci, checkout: co };
    }
  }
  // 2) zakres ze slownym miesiacem: 15-16 grudnia (2026)
  m = /(?:^|\D)(\d{1,2})\s*(?:-|do)\s*(\d{1,2})\s+([a-ząćęłńóśźż]{3,})(?:\s+(\d{4}))?/i.exec(t);
  if (m) {
    const mo = monthFromWord(m[3]);
    if (mo) {
      const ci = toIso(Number(m[1]), mo, yr(m[4]), today);
      const co = toIso(Number(m[2]), mo, yr(m[4]), today);
      if (ci && co && co > ci) return { checkin: ci, checkout: co };
    }
  }
  // 3) pojedyncza data po slowie wskazujacym przyjazd: "na 10.12", "od 10 grudnia", "dnia 10/12"
  m = /(?:^|\s)(?:na|od|dnia|w\s+dniu|on|from)\s+(\d{1,2})(?:[.\/](\d{1,2})(?:[.\/](\d{2,4}))?|\s+([a-ząćęłńóśźż]{3,}))(?!\d|[.,]\d)/i.exec(t);
  if (m) {
    const mo = m[2] ? Number(m[2]) : m[4] ? monthFromWord(m[4]) : null;
    if (mo) {
      const ci = toIso(Number(m[1]), mo, yr(m[3]), today);
      if (ci) return { checkin: ci };
    }
  }
  return null;
}

export interface FixedDates {
  checkin?: string;
  checkout?: string;
  pastError?: string;   // komunikat dla agenta, gdy data jest w przeszlosci i nie da sie jej poprawic
  oneNightAdded: boolean;
  weekend?: boolean;          // (18.11) daty policzone z "weekend"
  relativeUnresolved?: string; // (18.11) okreslenie czasu, ktorego serwer nie umie przeliczyc (np. "za tydzien")
}

// === WEEKEND I INNE OKRESLENIA CZASU (18.11, test Michala na prod) ===
// "hotele 4* w Warszawie na najblizszy weekend" - agent nie podal dat, serwer nie rozumial "weekend"
// i wzial daty z wczesniejszego pytania w czacie (10-11.12). Weekend = piatek-niedziela (2 noce),
// jak "weekend 27-29/11" w testach 13.11.
const WEEKEND_RE = /(^|[^\p{L}])(weekend\p{L}*|w[ił]ikend\p{L}*)([^\p{L}]|$)/iu;
const LONG_WEEKEND_RE = /d[lł]ug\p{L}*\s+(weekend|w[ił]ikend)/iu;
const NEXT_WEEKEND_RE = /(przysz[lł]\p{L}*|nast[eę]pn\p{L}*|kolejn\p{L}*)\s+(weekend|w[ił]ikend)|next\s+weekend/iu;
// Okreslenia, ktorych serwer nie przelicza - wtedy NIE bierzemy dat z pamieci rozmowy.
const RELATIVE_TIME_RE = new RegExp([
  "za\\s+(tydzie\\p{L}*|dwa\\s+tygodnie|\\d+\\s+(dni|tygodni\\p{L}*)|miesi\\p{L}*)",
  "(w\\s+)?(przysz[lł]\\p{L}*|nast[eę]pn\\p{L}*|kolejn\\p{L}*)\\s+(tydzie\\p{L}*|tygodni\\p{L}*|miesi\\p{L}*)",
  "(^|[^\\p{L}])(w|we|na|od|do|w\\s+t[eę]n|w\\s+t[aą])\\s+(poniedzia[lł]\\p{L}*|wtor\\p{L}*|[sś]rod(a|[eę]|y|zie)(?!\\p{L})|czwart\\p{L}*|pi[aą]t\\p{L}*|sobot\\p{L}*|niedziel\\p{L}*)",
  "(na|w|po|przed|przez|od)\\s+[sś]wi[eę]t(a|ach|ami|y)(?!\\p{L})", "sylwest\\p{L}*", "maj[oó]wk\\p{L}*", "d[lł]ug\\p{L}*\\s+(weekend|w[ił]ikend)",
  "ferie", "wielkanoc\\p{L}*", "next\\s+(week|month)", "in\\s+(a|two)\\s+weeks?",
].join("|"), "iu");

const PL_WEEKDAYS = ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"];

export function weekdayPl(iso: string): string {
  return PL_WEEKDAYS[new Date(iso + "T12:00:00Z").getUTCDay()];
}

// Najblizszy weekend (piatek-niedziela). Piatek: od dzis; sobota: sobota-niedziela (1 noc);
// niedziela: nastepny weekend. "przyszly/nastepny weekend" w piatek-niedziele = weekend za tydzien.
export function weekendFromText(text: string, today: string = warsawToday()): { checkin: string; checkout: string } | null {
  if (!text || !WEEKEND_RE.test(text) || LONG_WEEKEND_RE.test(text)) return null;
  const dow = new Date(today + "T12:00:00Z").getUTCDay(); // 0 nd ... 6 sob
  const next = NEXT_WEEKEND_RE.test(text);
  let friday: string;
  if (dow === 5) friday = next ? addDaysIso(today, 7) : today;
  else if (dow === 6) {
    if (!next) return { checkin: today, checkout: addDaysIso(today, 1) };
    friday = addDaysIso(today, 6);
  } else if (dow === 0) friday = addDaysIso(today, 5);
  else friday = addDaysIso(today, 5 - dow);
  return { checkin: friday, checkout: addDaysIso(friday, 2) };
}

export function relativeTimeInText(text: string): string | null {
  if (!text) return null;
  const m = RELATIVE_TIME_RE.exec(text);
  return m ? m[0].trim() : null;
}

// Komunikat dla agenta: okreslenie czasu, ktorego serwer nie przeliczyl.
export function relativeDatesMessage(phrase: string, today: string = warsawToday()): string {
  return "The request mentions a time (\"" + phrase + "\") that the server does not convert to dates. Today is " +
    today + " (" + weekdayPl(today) + ", Polish time). Work out the exact check-in and check-out dates from today and " +
    "call again with checkin and checkout. Do not reuse dates from earlier messages, and never say that Booking.com " +
    "did not apply the term. If the term is unclear (e.g. which holidays), ask the user for the dates.";
}

export function fixStayDates(checkinIn: string | undefined, checkoutIn: string | undefined,
                             userRequest: string | undefined, logPrefix = "=== DIAG daty"): FixedDates {
  let checkin = checkinIn;
  let checkout = checkoutIn;
  let oneNightAdded = false;
  const today = warsawToday();
  const req = typeof userRequest === "string" ? userRequest : "";

  // 0) Agent nie podal dat, a sa w tresci prosby -> bierzemy je z tekstu
  //    (przed datami z wczesniejszego pytania w czacie).
  if (!checkin && !checkout && req) {
    const fromText = parseDatesFromText(req, today);
    if (fromText) {
      checkin = fromText.checkin;
      checkout = fromText.checkout;
      console.error(logPrefix + ": agent nie podal dat - biore z tresci prosby: " + checkin +
        (checkout ? " - " + checkout : "") + ".");
    } else {
      const wk = weekendFromText(req, today);
      if (wk) {
        console.error(logPrefix + ": \"weekend\" w prosbie - " + wk.checkin + " (" + weekdayPl(wk.checkin) + ") - " +
          wk.checkout + " (" + weekdayPl(wk.checkout) + ").");
        return { checkin: wk.checkin, checkout: wk.checkout, oneNightAdded: false, weekend: true };
      }
      if (/(^|[^\p{L}])pojutrz\p{L}*/iu.test(req)) {
        checkin = addDaysIso(today, 2);
        checkout = addDaysIso(today, 3);
        console.error(logPrefix + ": \"pojutrze\" w prosbie - " + checkin + " - " + checkout + ".");
      } else if (!TODAY_RE.test(req) && !TOMORROW_RE.test(req)) {
        const rel = relativeTimeInText(req);
        if (rel) {
          console.error(logPrefix + ": okreslenie czasu \"" + rel + "\" bez dat - prosze agenta o daty (bez dat z rozmowy).");
          return { checkin: undefined, checkout: undefined, oneNightAdded: false, relativeUnresolved: rel };
        }
      }
    }
  }

  // 1) Daty wzgledne - tylko gdy agent nie podal przyszlej daty zameldowania
  //    ("dzis jest 5/11, chce hotel na 12.11" -> zostaje 12.11 od agenta).
  if (!checkin || checkin < today) {
    if (TODAY_RE.test(req)) {
      console.error(logPrefix + ": \"dzis\" w prosbie - zameldowanie " + today + " (czas polski)" +
        (checkin ? ", zamiast " + checkin + " od agenta" : "") + ".");
      checkin = today;
      if (!checkout || checkout <= checkin) checkout = addDaysIso(today, 1);
    } else if (TOMORROW_RE.test(req)) {
      const tomorrow = addDaysIso(today, 1);
      console.error(logPrefix + ": \"jutro\" w prosbie - zameldowanie " + tomorrow + " (czas polski)" +
        (checkin ? ", zamiast " + checkin + " od agenta" : "") + ".");
      checkin = tomorrow;
      if (!checkout || checkout <= checkin) checkout = addDaysIso(tomorrow, 1);
    }
  }

  // 2) Zamieniony dzien z miesiacem
  if (checkin && checkin < today) {
    const s = swapDayMonth(checkin);
    if (s && s >= today) {
      console.error(logPrefix + ": zameldowanie " + checkin + " jest w przeszlosci - zamieniam dzien z miesiacem -> " + s + ".");
      checkin = s;
    }
  }
  if (checkout && checkout <= (checkin ?? today)) {
    const s = swapDayMonth(checkout);
    if (s && s > (checkin ?? today)) {
      console.error(logPrefix + ": wymeldowanie " + checkout + " przed zameldowaniem - zamieniam dzien z miesiacem -> " + s + ".");
      checkout = s;
    }
  }

  // 3) Tylko jedna data
  if (checkin && !checkout) {
    checkout = addDaysIso(checkin, 1);
    oneNightAdded = true;
    console.error(logPrefix + ": tylko zameldowanie - 1 noc: " + checkin + " - " + checkout + ".");
  } else if (!checkin && checkout) {
    checkin = addDaysIso(checkout, -1);
    oneNightAdded = true;
    console.error(logPrefix + ": tylko wymeldowanie - 1 noc: " + checkin + " - " + checkout + ".");
  }

  // 4) Data z przeszlosci, ktorej nie da sie poprawic
  if (checkin && checkin < today) {
    console.error(logPrefix + ": zameldowanie " + checkin + " w przeszlosci (dzis " + today + ") - pytam o termin.");
    return {
      checkin, checkout, oneNightAdded,
      pastError: "The check-in date " + checkin + " is in the past - today is " + today + " (Polish time). " +
        "Suggested reply: ask the user to confirm the dates of the stay.",
    };
  }
  return { checkin, checkout, oneNightAdded };
}
