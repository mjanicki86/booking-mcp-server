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

export interface FixedDates {
  checkin?: string;
  checkout?: string;
  pastError?: string;   // komunikat dla agenta, gdy data jest w przeszlosci i nie da sie jej poprawic
  oneNightAdded: boolean;
}

export function fixStayDates(checkinIn: string | undefined, checkoutIn: string | undefined,
                             userRequest: string | undefined, logPrefix = "=== DIAG daty"): FixedDates {
  let checkin = checkinIn;
  let checkout = checkoutIn;
  let oneNightAdded = false;
  const today = warsawToday();
  const req = typeof userRequest === "string" ? userRequest : "";

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
