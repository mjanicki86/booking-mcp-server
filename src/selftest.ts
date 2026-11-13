// === AUTOTEST NA ZYWO (09.11) ===
// Kontener sam sprawdza kazde narzedzie prawdziwymi zapytaniami do Booking.com, przez wlasny
// endpoint /mcp (ta sama droga co Copilot Studio: klucz MCP, schemat, narzedzie, odpowiedz).
// Uruchamiany 2 min po starcie (po kazdym wdrozeniu) i potem co 24 h. Wynik w logu:
//   "=== SELFTEST OK <scenariusz>" / "=== SELFTEST BLAD <scenariusz>: <powod>"
//   "=== SELFTEST PODSUMOWANIE: 14/15 OK ..."
// Na zadanie w konsoli: node dist/probe.js selftest. Wylaczenie: zmienna SELFTEST=off.
// Klucze zostaja w zmiennych kontenera - nic nie wychodzi poza kontener poza zapytaniami do API.
import { addDaysIso, warsawToday } from "./services/dates.js";

type Result = { isError?: boolean; text: string; data: any };
type Log = (line: string) => void;

interface Scenario {
  name: string;
  tool: string;
  args: (ctx: Ctx) => Record<string, unknown> | null; // null = pomin (brak danych z poprzedniego kroku)
  check: (r: Result, ctx: Ctx) => string | null;      // null = OK, tekst = powod bledu
  delayMs?: number;                                   // odczekanie przed wywolaniem
}

interface Ctx {
  checkin: string;
  checkout: string;
  ddmm: string;            // "15-16.12" do tekstu prosby
  hotelId?: number;
  firstBatchTotal?: number;
}

function hotels(r: Result): any[] {
  return Array.isArray(r.data?.hotels) ? r.data.hotels : [];
}

const SCENARIOS: Scenario[] = [
  {
    name: "miasta: Krakow",
    tool: "booking_search_cities",
    args: () => ({ query: "Krakow", country: "pl" }),
    check: (r) => (Array.isArray(r.data?.cities) && r.data.cities.length > 0 ? null : "brak miast"),
  },
  {
    name: "wyszukiwanie: hotele 3* w Warszawie",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Warsaw", country: "pl", min_stars: 3, exact_stars: true, checkin: c.checkin, checkout: c.checkout,
      user_request: "hotele 3* w Warszawie" }),
    check: (r, c) => {
      const h = hotels(r);
      if (h.length < 3) return "za malo hoteli: " + h.length;
      const bad = h.filter((x) => x.stars != null && Number(x.stars) !== 3);
      if (bad.length) return "hotele spoza 3*: " + bad.map((x) => x.name + " " + x.stars + "*").join(", ");
      if (!h.every((x) => typeof x.price_total === "number")) return "hotel bez ceny";
      c.firstBatchTotal = Number(r.data?.total_matching ?? h.length);
      return null;
    },
  },
  {
    // Zabezpieczenie z 22.10: paczka szybciej niz 8 s po poprzedniej = model sam dociaga -> odmowa.
    name: "wyszukiwanie: dalej od razu = zablokowane (ochrona przed dociaganiem)",
    tool: "booking_search_hotels",
    args: (c) => (c.firstBatchTotal != null && c.firstBatchTotal > 10
      ? { city: "Warsaw", country: "pl", min_stars: 3, exact_stars: true, checkin: c.checkin, checkout: c.checkout,
        continue_previous: true, user_request: "dalej" } : null),
    check: (r) => (r.data?.status === "wait_for_user" ? null : "brak blokady, status: " + (r.data?.status ?? "lista")),
  },
  {
    name: "wyszukiwanie: dalej (kolejna paczka)",
    delayMs: 9000,
    tool: "booking_search_hotels",
    args: (c) => (c.firstBatchTotal != null && c.firstBatchTotal > 10
      ? { city: "Warsaw", country: "pl", min_stars: 3, exact_stars: true, checkin: c.checkin, checkout: c.checkout,
        continue_previous: true, user_request: "dalej" } : null),
    check: (r) => {
      const h = hotels(r);
      return h.length > 0 && h[0].position === 11 ? null : "pierwsza pozycja: " + (h[0]?.position ?? "brak");
    },
  },
  {
    name: "wyszukiwanie: kolo Wawelu (punkt, odleglosc)",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Krakow", country: "pl", landmark_name: "Wawel", checkin: c.checkin, checkout: c.checkout,
      user_request: "hotele koło Wawelu" }),
    check: (r) => {
      if (r.data?.status === "multiple_matches") return null; // pytanie o wybor miejsca tez jest poprawne
      const h = hotels(r);
      if (h.length === 0) return "brak hoteli";
      const d = h.map((x) => x.distance_km).filter((x) => typeof x === "number");
      if (d.length !== h.length) return "hotel bez odleglosci";
      if (Math.max(...d) > 10) return "hotel dalej niz 10 km: " + Math.max(...d);
      for (let i = 1; i < d.length; i++) if (d[i] + 0.05 < d[i - 1]) return "nieposortowane od najblizszego";
      return null;
    },
  },
  {
    name: "wyszukiwanie: tylko apartamenty (typ z prosby)",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Gdansk", country: "pl", checkin: c.checkin, checkout: c.checkout, user_request: "apartament w Gdańsku" }),
    check: (r) => {
      const h = hotels(r);
      if (h.length === 0) return "brak apartamentow";
      const bad = h.filter((x) => x.property_type && !/apart/i.test(String(x.property_type)));
      return bad.length ? "inne typy: " + bad.map((x) => x.name + " (" + x.property_type + ")").join(", ") : null;
    },
  },
  {
    name: "wyszukiwanie: nieznane udogodnienie nie blokuje (rooftop bar)",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Warsaw", country: "pl", checkin: c.checkin, checkout: c.checkout, required_facilities: ["rooftop bar"],
      user_request: "hotele z barem na dachu w Warszawie" }),
    check: (r) => {
      if (r.isError) return "blad: " + r.text.slice(0, 150);
      const u = r.data?.unsupported_filters;
      return Array.isArray(u) && u.includes("rooftop bar") ? null : "brak unsupported_filters";
    },
  },
  {
    name: "wyszukiwanie: bawialnia z tresci prosby (Gdansk, 2 doroslych + dziecko)",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Gdansk", country: "pl", checkin: c.checkin, checkout: c.checkout,
      user_request: "hotele w Gdańsku dla dwóch dorosłych z półtorarocznym dzieckiem, z atrakcjami dla dzieci, np. bawialnia" }),
    check: (r) => {
      if (r.isError) return "blad: " + r.text.slice(0, 150);
      const note = String(r.data?.filters_applied_note ?? "") + JSON.stringify(r.data?.zero_results_breakdown ?? "");
      if (!/kids_play/.test(note) && !/kids_play/.test(r.text)) return "filtr kids_play nie wlaczony";
      return null;
    },
  },
  {
    name: "wyszukiwanie: daty i goscie tylko z tresci prosby",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Poznan", country: "pl", user_request: "hotele w Poznaniu " + c.ddmm + " dla 2 dorosłych z 5-letnim dzieckiem" }),
    check: (r, c) => {
      const s = r.data?.active_search_state ?? r.data;
      if (r.data?.checkin !== c.checkin && s?.checkin !== c.checkin) return "daty nie z tekstu: " + (r.data?.checkin ?? s?.checkin);
      if (s?.adults !== 2) return "dorosli: " + s?.adults;
      return hotels(r).length > 0 ? null : "brak hoteli";
    },
  },
  {
    name: "wyszukiwanie: zagranica (Berlin)",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Berlin", country: "de", checkin: c.checkin, checkout: c.checkout, user_request: "hotele w Berlinie" }),
    check: (r) => (hotels(r).length >= 3 ? null : "za malo hoteli: " + hotels(r).length),
  },
  {
    name: "wyszukiwanie: data z przeszlosci = czytelna informacja",
    tool: "booking_search_hotels",
    args: () => ({ city: "Warsaw", country: "pl", checkin: addDaysIso(warsawToday(), -40), user_request: "hotele w Warszawie" }),
    check: (r) => (r.isError && /past/i.test(r.text) ? null : "brak informacji o dacie z przeszlosci"),
  },
  {
    name: "znajdz hotel: Hampton by Hilton Krakow",
    tool: "booking_find_hotel",
    args: () => ({ hotel_name: "Hampton by Hilton Krakow", city: "Krakow", country: "pl" }),
    check: (r, c) => {
      const id = r.data?.hotel?.hotel_id ?? r.data?.candidates?.[0]?.hotel_id;
      if (!id) return "status " + (r.data?.status ?? "?") + ", brak hotel_id";
      c.hotelId = id;
      return r.data?.status === "single_match" || r.data?.status === "multiple_matches" ? null : "status " + r.data?.status;
    },
  },
  {
    name: "szczegoly hotelu",
    tool: "booking_get_hotel_details",
    args: (c) => (c.hotelId ? { hotel_id: c.hotelId } : null),
    check: (r) => (r.data?.name && r.data?.url ? null : "brak nazwy lub linku"),
  },
  {
    name: "szczegoly: kontakt z Google (telefon i strona hotelu)",
    tool: "booking_get_hotel_details",
    args: (c) => (c.hotelId ? { hotel_id: c.hotelId, user_request: "podaj telefon do hotelu" } : null),
    check: (r) => {
      if (r.isError) return "blad: " + r.text.slice(0, 150);
      if (r.data?.hotel_contact === undefined) return null; // brak klucza Google w kontenerze - nie blad serwera
      return r.data.hotel_contact?.phone ? null : "brak telefonu z Google";
    },
  },
  {
    name: "szczegoly: parking ze strony hotelu",
    tool: "booking_get_hotel_details",
    args: (c) => (c.hotelId ? { hotel_id: c.hotelId, question_about: "parking", user_request: "jaki parking ma ten hotel?" } : null),
    check: (r) => {
      if (r.isError) return "blad: " + r.text.slice(0, 150);
      if (!r.data?.parking_summary) return "brak parking_summary z Booking.com";
      const w = r.data?.parking_from_website;
      return w === undefined || ["found", "not_found", "blocked"].includes(w.status) ? null : "status strony: " + w?.status;
    },
  },
  {
    name: "dostepnosc hotelu (daty, 2 doroslych)",
    tool: "booking_check_hotel_availability",
    args: (c) => (c.hotelId ? { hotel_id: c.hotelId, checkin: c.checkin, checkout: c.checkout, adults: 2 } : null),
    check: (r) => {
      const res = r.data?.results;
      if (!Array.isArray(res) || res.length !== 1) return "wynikow: " + (Array.isArray(res) ? res.length : "brak");
      return res[0].error ? "blad API: " + res[0].error : null;
    },
  },
  {
    name: "dostepnosc: hotel i daty z rozmowy",
    tool: "booking_check_hotel_availability",
    args: (c) => (c.hotelId ? { user_request: "a ten hotel ma wolne pokoje?" } : null),
    check: (r, c) => {
      if (r.isError) return "blad: " + r.text.slice(0, 150);
      if (r.data?.hotel_id !== c.hotelId) return "inny hotel: " + r.data?.hotel_id;
      return r.data?.results?.[0]?.checkin === c.checkin ? null : "daty nie z rozmowy";
    },
  },
  {
    name: "znajdz hotel: cale slowo w nazwie (Moderno, Poznan)",
    tool: "booking_find_hotel",
    args: () => ({ hotel_name: "Moderno", city: "Poznan", country: "pl" }),
    check: (r) => (r.data?.status === "single_match" && /moderno/i.test(String(r.data?.hotel?.name ?? ""))
      ? null : "status " + (r.data?.status ?? "?")),
  },
  {
    name: "znajdz hotel: link Booking.com spoza API (Poleczki) -> not_found",
    tool: "booking_find_hotel",
    args: () => ({ hotel_name: "Poleczki Residence", city: "Warsaw", country: "pl",
      booking_url: "https://www.booking.com/hotel/pl/poleczki-residence-apartments.pl.html" }),
    check: (r) => (r.data?.status === "not_found" || r.data?.status === "single_match"
      ? null : "status " + (r.data?.status ?? "?")),
  },
  {
    name: "wyszukiwanie: Trojmiasto = Gdansk + Sopot + Gdynia",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Gdansk", country: "pl", checkin: c.checkin, checkout: c.checkout, user_request: "hotele w Trójmieście" }),
    check: (r) => {
      const h = hotels(r);
      if (h.length === 0) return "brak hoteli";
      // (13.11) przy obszarze bez odleglosci; obszar rozpoznany = location_note o calym obszarze
      if (!/whole area/i.test(String(r.data?.location_note ?? ""))) return "szukanie po miescie zamiast obszaru";
      if (h.some((x) => typeof x.distance_km === "number")) return "odleglosc przy obszarze";
      if (!/za \d+ noc/.test(String(h[0]?.price_label ?? ""))) return "brak price_label";
      if (!String(r.data?.closing_line ?? "").includes("Znaleziono")) return "brak closing_line";
      // (13.11) w pierwszej paczce co najmniej 2 miasta i nazwa miasta przy hotelu
      const cities = new Set(h.map((x) => x.city).filter((c) => !!c));
      return cities.size >= 2 ? null : "w paczce miasta: " + (Array.from(cities).join(", ") || "brak pola city");
    },
  },
  {
    name: "wyszukiwanie: limit od agenta bez prosby o liczbe -> paczka 10",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Warsaw", country: "pl", checkin: c.checkin, checkout: c.checkout, results_limit: 5,
      user_request: "hotele w Warszawie" }),
    check: (r) => (hotels(r).length > 5 ? null : "tylko " + hotels(r).length + " hoteli (limit agenta zastosowany)"),
  },
  {
    name: "wyszukiwanie: aglomeracja slaska (kilka miast)",
    tool: "booking_search_hotels",
    args: (c) => ({ city: "Katowice", country: "pl", checkin: c.checkin, checkout: c.checkout, user_request: "hotele w aglomeracji śląskiej" }),
    check: (r) => {
      const h = hotels(r);
      if (h.length === 0) return "brak hoteli";
      const cities = new Set(h.map((x) => x.city).filter((c) => !!c));
      return cities.size >= 2 ? null : "w paczce miasta: " + (Array.from(cities).join(", ") || "brak pola city");
    },
  },
  {
    name: "znajdz hotel: sam link, bez miasta i kraju (miasto z Google)",
    tool: "booking_find_hotel",
    args: () => ({ hotel_name: "Poleczki Residence Apartments",
      booking_url: "https://www.booking.com/hotel/pl/poleczki-residence-apartments.pl.html" }),
    check: (r) => (r.data?.status === "not_found" || r.data?.status === "single_match"
      ? null : "status " + (r.data?.status ?? "?")),
  },
  {
    name: "znajdz hotel: bez kandydatow z samego 'Residence' (Poleczki)",
    tool: "booking_find_hotel",
    args: () => ({ hotel_name: "Poleczki Residence", city: "Warsaw", country: "pl" }),
    check: (r) => (r.data?.status === "no_match" || r.data?.status === "not_found" || r.data?.status === "single_match"
      ? null : "status " + (r.data?.status ?? "?") + " (kandydaci z czesci nazwy)"),
  },
  {
    name: "znajdz hotel: miasto z nazwy (Faltom Gdynia -> Rumia)",
    tool: "booking_find_hotel",
    args: () => ({ hotel_name: "Hotel Spa Faltom Gdynia Rumia", city: "Gdynia", country: "pl" }),
    check: (r) => (r.data?.status === "single_match" && /faltom/i.test(String(r.data?.hotel?.name ?? ""))
      ? null : "status " + (r.data?.status ?? "?") + ", " + (r.data?.hotel?.name ?? r.data?.candidates?.[0]?.name ?? "brak")),
  },
  {
    // Faltom (87169): Booking.com API nie zwraca ofert w zadnym terminie (test 09.11).
    name: "dostepnosc: hotel bez ofert w API = offers_in_api false (Faltom)",
    tool: "booking_check_hotel_availability",
    args: (c) => ({ hotel_id: 87169, checkin: c.checkin, checkout: c.checkout, adults: 2 }),
    check: (r) => {
      if (r.data?.results?.[0]?.available) return null; // hotel zaczal udostepniac oferty - tez poprawnie
      return r.data?.offers_in_api === false ? null : "offers_in_api: " + r.data?.offers_in_api;
    },
  },
  {
    name: "info o pokazanych hotelach",
    tool: "booking_get_shown_hotels_info",
    args: () => ({ which: "all_shown" }),
    check: (r) => {
      const h = Array.isArray(r.data?.hotels) ? r.data.hotels : [];
      return h.length > 0 && "checkin_from" in h[0] ? null : "brak hoteli z rozmowy";
    },
  },
  {
    name: "miejsce: Wawel",
    tool: "booking_find_landmark",
    args: () => ({ landmark_name: "Wawel", city: "Krakow", country: "pl" }),
    check: (r) => (["single_match", "multiple_matches"].includes(r.data?.status) ? null : "status " + (r.data?.status ?? "?")),
  },
];

async function callTool(port: number, convId: string, id: number, tool: string, args: Record<string, unknown>): Promise<Result> {
  const r = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-access-key": process.env.MCP_ACCESS_KEY ?? "",
      "conversation-id": convId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(60000),
  });
  const j: any = await r.json();
  if (j?.error) return { isError: true, text: String(j.error.message ?? JSON.stringify(j.error)), data: null };
  const res = j?.result ?? {};
  const text = String(res?.content?.[0]?.text ?? "");
  let data = res?.structuredContent ?? null;
  if (!data) {
    try { data = JSON.parse(text.split("\n\n---")[0]); } catch { data = null; }
  }
  return { isError: !!res?.isError, text, data };
}

export async function runSelftest(port: number, log: Log = (l) => console.error(l)): Promise<{ ok: number; total: number }> {
  const started = Date.now();
  const checkin = addDaysIso(warsawToday(), 30);
  const checkout = addDaysIso(checkin, 1);
  const ctx: Ctx = {
    checkin, checkout,
    ddmm: checkin.slice(8, 10) + "-" + checkout.slice(8, 10) + "." + checkout.slice(5, 7),
  };
  // przelom miesiaca: "30.11-01.12" zamiast "30-01.12"
  if (checkin.slice(5, 7) !== checkout.slice(5, 7)) {
    ctx.ddmm = checkin.slice(8, 10) + "." + checkin.slice(5, 7) + "-" + checkout.slice(8, 10) + "." + checkout.slice(5, 7);
  }
  // osobny "czat" dla kazdego przebiegu (pamiec rozmowy nie miesza sie z konsultantami)
  const convId = "selftest-" + Date.now().toString(36);
  let ok = 0;
  let total = 0;
  const failed: string[] = [];
  log("=== SELFTEST start: " + SCENARIOS.length + " scenariuszy, daty " + checkin + " - " + checkout);
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    const args = s.args(ctx);
    if (!args) { log("=== SELFTEST POMINIETY " + s.name + " (brak danych z poprzedniego kroku)"); continue; }
    total++;
    if (s.delayMs) await new Promise((res) => setTimeout(res, s.delayMs));
    const t0 = Date.now();
    try {
      const r = await callTool(port, convId, 9000 + i, s.tool, args);
      const why = s.check(r, ctx);
      if (why) {
        failed.push(s.name);
        log("=== SELFTEST BLAD " + s.name + ": " + why + " (" + (Date.now() - t0) + " ms)");
      } else {
        ok++;
        log("=== SELFTEST OK " + s.name + " (" + (Date.now() - t0) + " ms)");
      }
    } catch (err) {
      failed.push(s.name);
      log("=== SELFTEST BLAD " + s.name + ": wyjatek " + (err instanceof Error ? err.message : String(err)));
    }
  }
  log("=== SELFTEST PODSUMOWANIE: " + ok + "/" + total + " OK" + (failed.length ? " | nie przeszly: " + failed.join("; ") : "") +
    " | " + Math.round((Date.now() - started) / 1000) + " s");
  return { ok, total };
}

// Harmonogram w serwerze: 2 min po starcie (po prewarm), potem co 24 h.
export function scheduleSelftest(port: number): void {
  if ((process.env.SELFTEST ?? "").toLowerCase() === "off") {
    console.error("=== SELFTEST wylaczony (SELFTEST=off).");
    return;
  }
  const run = () => runSelftest(port).catch((e) => console.error("=== SELFTEST BLAD przebiegu: " + (e instanceof Error ? e.message : String(e))));
  setTimeout(run, 2 * 60 * 1000);
  setInterval(run, 24 * 60 * 60 * 1000);
}
