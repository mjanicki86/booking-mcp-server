// === SKRYPT DIAGNOSTYCZNY (09.11, Etap 1) ===
// Konsola Azure psuje dlugie wklejane komendy, wiec testy API sa wbudowane w obraz.
// Uzycie w konsoli kontenera (Azure -> booking-mcp-dev -> Konsola, /bin/sh):
//   node dist/probe.js hotel 87169 2026-11-11 2026-11-13 [dorosli] [wiek_dzieci np. 1,5]
//   node dist/probe.js facilities kid
//   node dist/probe.js text "hotele w Trojmiescie dla 2 doroslych z poltorarocznym dzieckiem 11-13.11"
// Klucz API nie jest nigdzie wypisywany.
import { config } from "./config.js";
import { parseDatesFromText, fixStayDates } from "./services/dates.js";
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

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "hotel") await hotel(args);
  else if (cmd === "facilities") await facilities(args);
  else if (cmd === "text") text(args);
  else {
    console.log("Komendy:\n  node dist/probe.js hotel <hotel_id> <checkin> <checkout> [dorosli] [wiek,wiek]\n" +
      "  node dist/probe.js facilities <slowo>\n  node dist/probe.js text \"<tresc prosby>\"");
  }
}

main().catch((e) => console.log("BLAD: " + (e instanceof Error ? e.message : String(e))));
