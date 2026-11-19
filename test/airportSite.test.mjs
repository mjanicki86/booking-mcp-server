// Asystent AL (19.11): oficjalna domena lotniska z Google Places. Odpowiedzi Google podstawione (bez sieci).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_PLACES_API_KEY = "test-key";
// config.js wymaga kluczy Booking.com - w budowaniu obrazu ich nie ma, wiec podstawiamy atrapy.
process.env.BOOKING_API_KEY ??= "test";
process.env.BOOKING_AFFILIATE_ID ??= "test";
let calls = 0;
let reply = {};
globalThis.fetch = async (_url, init) => {
  calls++;
  const body = JSON.parse(init.body);
  assert.equal(body.includedType, "airport");
  assert.equal(init.headers["X-Goog-FieldMask"].includes("places.internationalPhoneNumber"), false);
  return { ok: true, status: 200, json: async () => reply };
};
const { findAirportSite, domainFromUrl, isUnofficialDomain } = await import("../dist/services/airportSite.js");

test("domena z adresu", () => {
  assert.equal(domainFromUrl("https://www.heathrow.com/"), "heathrow.com");
  assert.equal(domainFromUrl("https://suvarnabhumi.airportthai.co.th/"), "suvarnabhumi.airportthai.co.th");
  assert.equal(domainFromUrl("https://www.aena.es/en/adolfo-suarez-madrid-barajas.html"), "aena.es");
  assert.equal(domainFromUrl(""), null);
});

test("nieoficjalne serwisy odrzucone, oficjalne z '-airport' przepuszczone", () => {
  assert.equal(isUnofficialDomain("bangkokairportonline.com"), true);
  assert.equal(isUnofficialDomain("istanbul-airport-online.com"), true);
  assert.equal(isUnofficialDomain("en.wikipedia.org"), true);
  assert.equal(isUnofficialDomain("frankfurt-airport.com"), false);
  assert.equal(isUnofficialDomain("katowice-airport.com"), false);
  assert.equal(isUnofficialDomain("krakowairport.pl"), false);
});

test("BKK: domena z Google, potem z pamieci", async () => {
  reply = { places: [{ id: "x", displayName: { text: "Suvarnabhumi Airport" }, types: ["international_airport", "airport"],
    websiteUri: "https://suvarnabhumi.airportthai.co.th/" }] };
  const a = await findAirportSite("bkk", "Suvarnabhumi");
  assert.equal(a.found, true);
  assert.equal(a.domain, "suvarnabhumi.airportthai.co.th");
  assert.equal(a.source, "google");
  const before = calls;
  const b = await findAirportSite("BKK", "inna nazwa");
  assert.equal(b.source, "cache");
  assert.equal(calls, before);
});

test("nieoficjalna strona w profilu Google -> found=false", async () => {
  reply = { places: [{ displayName: { text: "X Airport" }, types: ["airport"], websiteUri: "https://www.bangkokairportonline.com/" }] };
  const a = await findAirportSite("DMK", "");
  assert.equal(a.found, false);
  assert.equal(a.reason, "unofficial");
});

test("brak wynikow i zly kod", async () => {
  reply = {};
  assert.equal((await findAirportSite("ZZZ", "")).reason, "not_found");
  assert.equal((await findAirportSite("12", "")).reason, "bad_request");
});
