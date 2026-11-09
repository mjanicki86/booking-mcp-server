// === SKRYPT DIAGNOSTYCZNY (09.11, Etap 1) ===
// Konsola Azure psuje dlugie wklejane komendy, wiec testy API sa wbudowane w obraz.
// Uzycie w konsoli kontenera (Azure -> booking-mcp-dev -> Konsola, /bin/sh):
//   node dist/probe.js hotel 87169 2026-11-11 2026-11-13 [dorosli] [wiek_dzieci np. 1,5]
//   node dist/probe.js facilities kid
//   node dist/probe.js text "hotele w Trojmiescie dla 2 doroslych z poltorarocznym dzieckiem 11-13.11"
//   node dist/probe.js selftest               (autotest wszystkich narzedzi na zywo, jak po wdrozeniu)
//   node dist/probe.js places-test            (pomiar Google Places + strony hoteli, 22 hotele z listy 02.11)
//   node dist/probe.js places "Hotel X" "ulica, miasto"
// Klucz API nie jest nigdzie wypisywany.
import { config } from "./config.js";
import { parseDatesFromText, fixStayDates } from "./services/dates.js";
import { findPlace, googlePlacesEnabled } from "./services/googlePlaces.js";
import { runSelftest } from "./selftest.js";
import { parkingFromWebsite } from "./services/hotelWebsite.js";
import { parseGuestsFromText, requestedAccommodationTypes, breakfastIntent, wantsParking, parseUserDistanceKm } from "./services/textParsing.js";

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(config.bookingApiBaseUrl + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Affiliate-Id": config.bookingAffiliateId,
      "Authorization": "Bearer " + config.bookingApiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return r.json();
}

async function hotel(args: string[]): Promise<void> {
  const [idS, checkin, checkout, adultsS, agesS] = args;
  const id = Number(idS);
  if (!id || !checkin || !checkout) {
    console.log("Uzycie: node dist/probe.js hotel <hotel_id> <RRRR-MM-DD> <RRRR-MM-DD> [dorosli] [wiek,wiek]");
    return;
  }
  const adults = Number(adultsS ?? 2) || 2;
  const ages = agesS ? agesS.split(",").map(Number).filter((n) => n >= 0 && n <= 17) : [];
  const d = await post("/accommodations/details", { accommodations: [id], languages: ["pl", "en-gb"] });
  const h = Array.isArray(d?.data) ? d.data[0] : null;
  console.log("Szczegoly: " + (h ? (h.name?.pl ?? h.name?.["en-gb"]) + ", miasto id " + h.location?.city +
    ", typ " + h.accommodation_type + ", adres " + (h.location?.address?.pl ?? "?") : "BRAK w API (data: [])"));
  const variants: [string, any][] = [
    ["zadane", { number_of_adults: adults, number_of_rooms: 1, ...(ages.length ? { children: ages } : {}) }],
    ["1 dorosly", { number_of_adults: 1, number_of_rooms: 1 }],
    ["2 doroslych", { number_of_adults: 2, number_of_rooms: 1 }],
  ];
  for (const country of ["pl", "gb"]) {
    for (const [label, guests] of variants) {
      const r = await post("/accommodations/search", {
        booker: { country, platform: "desktop" }, currency: "PLN", accommodations: [id], checkin, checkout, guests,
        extras: ["products"],
      });
      const x = Array.isArray(r?.data) ? r.data[0] : null;
      console.log("Szukanie [kraj " + country + ", " + label + "]: " +
        (r?.errors ? "BLAD " + JSON.stringify(r.errors).slice(0, 200)
          : x ? "DOSTEPNY, cena " + (x.price?.book ?? x.price?.total) + " " + (x.currency ?? "") + ", ofert " + (x.products?.length ?? "?")
          : "brak ofert"));
    }
  }
}

async function facilities(args: string[]): Promise<void> {
  const q = (args[0] ?? "").toLowerCase();
  const c = await post("/accommodations/constants", { languages: ["pl", "en-gb"] });
  for (const f of c?.data?.accommodation_facilities ?? []) {
    const en = f?.name?.["en-gb"] ?? "";
    const pl = f?.name?.pl ?? "";
    if (!q || en.toLowerCase().includes(q) || pl.toLowerCase().includes(q)) console.log(f.id + "\t" + en + "\t" + pl);
  }
}

function text(args: string[]): void {
  const t = args.join(" ");
  console.log("Daty z tekstu: " + JSON.stringify(parseDatesFromText(t)));
  console.log("Daty po poprawkach: " + JSON.stringify(fixStayDates(undefined, undefined, t, "  log")));
  console.log("Goscie: " + JSON.stringify(parseGuestsFromText(t)));
  console.log("Typy obiektow: " + JSON.stringify(requestedAccommodationTypes(t)));
  console.log("Sniadanie: " + breakfastIntent(t) + ", parking: " + wantsParking(t) + ", promien km: " + parseUserDistanceKm(t));
}

// Lista testowa od Michala (02.11, dokument projektu "parking-ze-stron-hoteli-lista-testowa").
const TEST_HOTELS: [string, string][] = [
  ["Park-Hotel Hagenbeck", "Hagenbeckstraße 150, 22527 Hamburg"],
  ["Hampton by Hilton Krakow", "Dąbska 5, 31-572 Kraków"],
  ["Varsovia Apartamenty Kasprzaka", "Marcina Kasprzaka 31, 01-234 Warszawa"],
  ["Four Points by Sheraton Wroclaw", "Gajowicka 130, 53-322 Wrocław"],
  ["Kyriad Stargard", "Spichrzowa 2, 73-110 Stargard"],
  ["Scandic Hamburg Emporio", "Dammtorwall 19, 20355 Hamburg"],
  ["Hotel Duo", "Teplická 492, 190 00 Praha 9"],
  ["Airporthotel Berlin Adlershof", "Rudower Chaussee 14, 12489 Berlin"],
  ["Hotel Moderno", "Kolejowa 29, 60-718 Poznań"],
  ["ibis Styles Warszawa West", "Poznańska 33, 05-850 Mory"],
  ["Park Hotel Diament Katowice", "Wita Stwosza 37, 40-042 Katowice"],
  ["Tallink Hotel Riga", "Elizabetes iela 24, Rīga, LV-1050"],
  ["Best Western Hotel Halle-Merseburg", "Christianenstraße 25, 06217 Merseburg"],
  ["Clarion Congress Hotel Prague", "Freyova 945/33, 190 00 Praha"],
  ["PURO Łódź Centrum", "Ogrodowa 16, 91-065 Łódź"],
  ["Golden Tulip Gdańsk Residence", "Piastowska 160, 80-358 Gdańsk"],
  ["Hotel The Loom", "Ogrodowa 21, 91-065 Łódź"],
  ["NH Collection Olomouc Congress", "Legionářská 21, 779 00 Olomouc"],
  ["Hotel Grand Vígľaš", "Vígľaš 602, 962 02 Vígľaš"],
  ["Hotel Partner", "Marywilska 16, 03-228 Warszawa"],
  ["Hotel Sante", "Jagiellońska 55A, 03-301 Warszawa"],
  ["Grein Hotel", "Al. Tadeusza Rejtana 1, 35-326 Rzeszów"],
];

async function placesOne(name: string, address: string, verbose: boolean): Promise<{ place: boolean; web: boolean; phone: boolean; fetched: boolean; parking: boolean }> {
  const p = await findPlace(name, address);
  const r = { place: !!p, web: !!p?.website, phone: !!p?.phone, fetched: false, parking: false };
  console.log("\n### " + name + " (" + address + ")");
  if (!p) { console.log("  Google: NIE ZNALEZIONO"); return r; }
  console.log("  Google: " + p.name + " | " + (p.address ?? "-") + (p.is_lodging ? "" : " | UWAGA: nie oznaczony jako hotel"));
  console.log("  Telefon: " + (p.phone ?? "brak") + " | WWW: " + (p.website ?? "brak"));
  if (!p.website) return r;
  const w = await parkingFromWebsite(p.website);
  r.fetched = w.fetched;
  r.parking = w.parking_snippets.length > 0;
  console.log("  Strona: " + (w.fetched ? "pobrana, " + w.text_chars + " znakow" + (w.js_only ? " (MALO TEKSTU - pewnie JavaScript)" : "")
    : "NIE POBRANO (" + (w.error ?? "?") + ")") + " | podstrony: " + Math.max(0, w.pages_checked.length - 1));
  console.log("  Parking na stronie: " + (r.parking ? "TAK" : "nie znaleziono") +
    (r.parking ? " | cena: " + (w.found.price ? "tak" : "nie") + ", wysokosc: " + (w.found.height ? "tak" : "nie") +
      ", EV: " + (w.found.ev ? "tak" : "nie") + ", LPG: " + (w.found.lpg ? "tak" : "nie") + ", bus: " + (w.found.bus ? "tak" : "nie") : ""));
  const show = verbose ? w.parking_snippets : w.parking_snippets.slice(0, 3);
  for (const s of show) console.log("    - " + s.replace(/\s+/g, " ").slice(0, 220));
  return r;
}

async function placesTest(): Promise<void> {
  if (!googlePlacesEnabled()) { console.log("Brak GOOGLE_PLACES_API_KEY w zmiennych kontenera - patrz instrukcja w Azure."); return; }
  const sum = { place: 0, web: 0, phone: 0, fetched: 0, parking: 0 };
  for (const [name, address] of TEST_HOTELS) {
    const r = await placesOne(name, address, false);
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) if (r[k]) sum[k]++;
  }
  const n = TEST_HOTELS.length;
  console.log("\n=== PODSUMOWANIE (" + n + " hoteli): znaleziony w Google " + sum.place + ", ma strone WWW " + sum.web +
    ", ma telefon " + sum.phone + ", strona pobrana " + sum.fetched + ", parking na stronie " + sum.parking + ".");
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "hotel") await hotel(args);
  else if (cmd === "facilities") await facilities(args);
  else if (cmd === "text") text(args);
  else if (cmd === "places-test") await placesTest();
  else if (cmd === "selftest") await runSelftest(parseInt(process.env.PORT ?? "8080", 10), (l) => console.log(l));
  else if (cmd === "places") { if (args[0]) await placesOne(args[0], args[1] ?? "", true); }
  else {
    console.log("Komendy:\n  node dist/probe.js hotel <hotel_id> <checkin> <checkout> [dorosli] [wiek,wiek]\n" +
      "  node dist/probe.js facilities <slowo>\n  node dist/probe.js text \"<tresc prosby>\"\n" +
      "  node dist/probe.js selftest\n  node dist/probe.js places-test\n  node dist/probe.js places \"<nazwa hotelu>\" \"<adres>\"");
  }
}

main().catch((e) => console.log("BLAD: " + (e instanceof Error ? e.message : String(e))));
