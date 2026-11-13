// Testy regresji (09.11, Etap 1): przypadki z realnych zgloszen testerow od 29.10.
// Uruchamiane w obrazie Dockera po kompilacji (npm test) - blad testu zatrzymuje wdrozenie.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestedAccommodationTypes, parseUserDistanceKm, isNextBatchRequest, NEAR_PLACE_RE,
  OTHER_ACCOMMODATION_RE, NEGATED_TYPE_RE, breakfastIntent, wantsParking, parseGuestsFromText,
  normalizeFacilities, alternativeNamesFromRequest, kidsFacilitiesFromText, parseBookingUrl, bookingSlug,
} from "../dist/services/textParsing.js";

const types = (t) => requestedAccommodationTypes(t)?.labels ?? null;

test("typy obiektow (06.11 Julia, decyzja: robimy to, o co user prosi)", () => {
  assert.deepEqual(types("znajdz mi apartament kolo adresu magazynowa 7 w warszawie, termin 15-16.12, 1 apartament"), ["apartamenty"]);
  assert.deepEqual(types("tylko hostele w Krakowie"), ["hostele"]);
  assert.deepEqual(types("pensjonat albo B&B w Zakopanem"), ["B&B", "pensjonaty"]);
  assert.deepEqual(types("hotel lub apartament koło Magazynowej 7"), ["hotele", "apartamenty"]);
  assert.deepEqual(types("hostel albo hotel w Berlinie"), ["hotele", "hostele"]);
  assert.deepEqual(types("domki w Zakopanem na weekend"), ["domy wakacyjne"]);
  assert.equal(types("hotele 3* koło Wawelu bez hosteli"), null);
  assert.equal(types("znajdź hotel ze śniadaniem w okolicy Ossendrecht"), null);
  assert.equal(types("hotel nie apartament"), null);
});

test("inne obiekty noclegowe (06.11 Ossendrecht) i zaprzeczenia", () => {
  const strip = (t) => t.replace(NEGATED_TYPE_RE, " ");
  assert.ok(OTHER_ACCOMMODATION_RE.test(strip("czy są też inne obiekty noclegowe?")));
  assert.ok(OTHER_ACCOMMODATION_RE.test(strip("dowolny nocleg w Gdańsku")));
  assert.ok(!OTHER_ACCOMMODATION_RE.test(strip("hotele 3* koło Wawelu bez hosteli")));
  assert.ok(!OTHER_ACCOMMODATION_RE.test(strip("hotele w promieniu 1 km od Sukiennic")));
});

test("promien z tekstu (29.10 Balice/Sukiennice)", () => {
  assert.equal(parseUserDistanceKm("hotele 3* 4 km od Wawelu"), 4);
  assert.equal(parseUserDistanceKm("do 500 m od dworca"), 0.5);
  assert.equal(parseUserDistanceKm("w promieniu 2,5 km"), 2.5);
  assert.equal(parseUserDistanceKm("Wyszukaj hotele 5-gwiazdkowe w okolicy lotniska Balice"), null);
});

test("kolejna paczka (22.10) - 'dalej' tak, nowe kryteria nie", () => {
  assert.ok(isNextBatchRequest("dalej"));
  assert.ok(isNextBatchRequest("pokaż kolejne"));
  assert.ok(!isNextBatchRequest("teraz 4 gwiazdki"));
  assert.ok(!isNextBatchRequest("więcej hoteli 5* w promieniu 3 km od rynku"));
});

test("prosba o miejsce (koło/przy/dworzec)", () => {
  assert.ok(NEAR_PLACE_RE.test("hotele koło stacji kolejowej w Krakowie"));
  assert.ok(NEAR_PLACE_RE.test("hotel przy lotnisku FRA"));
  assert.ok(!NEAR_PLACE_RE.test("hotele we Frankfurcie 10-11.11"));
});

test("sniadanie (02.11 Green Garden, 06.11 B&B)", () => {
  assert.equal(breakfastIntent("hotele w Raszynie ze śniadaniem 10–11.11"), "on");
  assert.equal(breakfastIntent("teraz bez śniadania"), "off");
  assert.equal(breakfastIntent("pensjonat albo B&B w Zakopanem"), null);
  assert.equal(breakfastIntent("hotele w Raszynie 10–11.11"), null);
});

test("parking (05.11 Wroclaw)", () => {
  assert.ok(wantsParking("hotele we Wrocławiu ze śniadaniem i parkingiem"));
  assert.ok(wantsParking("hotel z garażem"));
  assert.ok(!wantsParking("parking niepotrzebny, hotel w centrum"));
  assert.ok(!wantsParking("hotele w Raszynie"));
});

test("goscie z tekstu (09.11 Damian - dziecko 1,5 roku)", () => {
  assert.deepEqual(parseGuestsFromText("Znajdź hotele w Trójmiescie na pobyt dla dwoch doroslych z półtorarocznym dzieckiem"),
    { adults: 2, children_ages: [1], children_count: 1 });
  assert.deepEqual(parseGuestsFromText("2 osoby + dzieci 3 i 7 lat"), { adults: 2, children_ages: [3, 7], children_count: 2 });
  assert.deepEqual(parseGuestsFromText("hotel dla 3 osób, 2 pokoje"), { adults: 3, rooms: 2 });
  assert.deepEqual(parseGuestsFromText("rodzina z dzieckiem"), { children_count: 1 });
  assert.deepEqual(parseGuestsFromText("pokoje gościnne w Gdańsku"), {});
  assert.deepEqual(parseGuestsFromText("hotele 4* w Warszawie 10-11.11"), {});
  assert.deepEqual(parseGuestsFromText("1 pokój single room"), { rooms: 1 });
});

test("udogodnienia od agenta (09.11 playroom, 10.11 filtr dla dzieci)", () => {
  assert.deepEqual(normalizeFacilities(["parking", "Swimming pool", "fitness"]), { known: ["parking", "pool", "gym"], unsupported: [] });
  assert.deepEqual(normalizeFacilities(["playroom", "spa"]), { known: ["kids_play", "spa"], unsupported: [] });
  assert.deepEqual(normalizeFacilities(["Kids' club", "rooftop bar"]), { known: ["kids_play"], unsupported: ["rooftop bar"] });
  assert.deepEqual(normalizeFacilities(["family room", "brodzik"]), { known: ["family_rooms", "kids_pool"], unsupported: [] });
  assert.deepEqual(normalizeFacilities(undefined), { known: [], unsupported: [] });
});

test("udogodnienia dla dzieci z tresci prosby (10.11 Damian - Trojmiasto)", () => {
  assert.deepEqual(kidsFacilitiesFromText("Hotel z atrakcjami dla dzieci, np. bawialnia. Musi być dostępny w terminie 11-13.11"), ["kids_play"]);
  assert.deepEqual(kidsFacilitiesFromText("hotel z placem zabaw i basenem dla dzieci"), ["kids_play", "kids_pool"]);
  assert.deepEqual(kidsFacilitiesFromText("pokój rodzinny w Zakopanem"), ["family_rooms"]);
  assert.deepEqual(kidsFacilitiesFromText("hotele w Gdańsku dla 2 dorosłych z dzieckiem"), []);
});

test("druga nazwa miejsca z prosby (03.11 Weigla 5 / Szpital Wojskowy)", () => {
  assert.deepEqual(alternativeNamesFromRequest("hotel koło ul. Weigla 5, to jest 4 Szpital Wojskowy", "ul. Weigla 5"), ["4 Szpital Wojskowy"]);
});

import { detailsTopic } from "../dist/services/textParsing.js";

test("temat pytania o hotel: kontakt / parking (12.11 Google Places)", () => {
  assert.deepEqual(detailsTopic(undefined, "znajdź dane kontaktowe do hotelu Bedford Swan"), { contact: true, parking: false });
  assert.deepEqual(detailsTopic(undefined, "podaj numer telefonu do recepcji Hampton Kraków"), { contact: true, parking: false });
  assert.deepEqual(detailsTopic(undefined, "czy bus się zmieści na parkingu hotelu Diament?"), { contact: false, parking: true });
  assert.deepEqual(detailsTopic("parking", "a co z autem?"), { contact: false, parking: true });
  assert.deepEqual(detailsTopic(undefined, "o której jest zameldowanie w hotelu Moderno?"), { contact: false, parking: false });
});

import { regionFromText, unsupportedAmenitiesFromText } from "../dist/services/textParsing.js";

test("Trojmiasto jako jeden obszar (12.11)", () => {
  const r = regionFromText("Znajdź hotele w Trójmieście na pobyt dla dwóch dorosłych z dzieckiem 11-13.12");
  assert.ok(r && r.radiusKm === 15 && Math.abs(r.lat - 54.44) < 0.05);
  assert.ok(regionFromText("hotele w Trojmiescie"));
  assert.equal(regionFromText("hotele w Gdańsku 11-13.12"), null);
});

test("nieobslugiwane udogodnienia z tresci prosby (12.11 bar na dachu)", () => {
  assert.deepEqual(unsupportedAmenitiesFromText("hotel z barem na dachu w Warszawie"), ["bar / taras na dachu"]);
  assert.deepEqual(unsupportedAmenitiesFromText("hotel z widokiem na morze w Sopocie"), ["widok z pokoju"]);
  assert.deepEqual(unsupportedAmenitiesFromText("hotele 4* w Warszawie z parkingiem"), []);
});

test("link Booking.com (12.11, Poleczki): slug, nazwa, kraj", () => {
  const r = parseBookingUrl("zobacz https://www.booking.com/hotel/pl/poleczki-residence-apartments.pl.html?aid=123&checkin=2026-12-01");
  assert.deepEqual(r, { slug: "poleczki-residence-apartments", name: "Poleczki Residence Apartments", country: "pl" });
  assert.equal(bookingSlug("https://www.booking.com/hotel/pl/poleczki-residence-apartments.html"), "poleczki-residence-apartments");
  assert.equal(bookingSlug("https://www.booking.com/hotel/gb/swan-bedford.en-gb.html"), "swan-bedford");
  assert.equal(parseBookingUrl("Hotel Poleczki Warszawa"), null);
});

test("obszary (13.11): Trojmiasto i aglomeracja slaska, samo 'Slask' nie", () => {
  assert.match(regionFromText("hotele w Trójmieście 11-13.12").label, /Trójmiasto/);
  for (const t of ["hotel w aglomeracji śląskiej", "Aglomeracja Śląska 4*", "hotele na terenie GZM",
                   "Górnośląski Związek Metropolitalny", "metropolia śląska", "hotel w konurbacji górnośląskiej"]) {
    assert.match(regionFromText(t)?.label ?? "brak: " + t, /aglomeracja śląska/, t);
  }
  assert.equal(regionFromText("hotel na Śląsku w Katowicach"), null);
  assert.equal(regionFromText("hotel w Katowicach"), null);
});

import { userAskedForCount, priceLabel, closingLine } from "../dist/services/textParsing.js";
test("limit tylko na prosbe (13.11)", () => {
  for (const t of ["5 najlepszych hoteli w Krakowie", "pokaż 3 hotele w Gdańsku", "top 10 hoteli w Warszawie",
                   "daj mi kilka propozycji w Sopocie", "trzy najtańsze hotele w Poznaniu", "podaj 5 hoteli 4*"]) {
    assert.equal(userAskedForCount(t), true, t);
  }
  for (const t of ["hotel z barem na dachu w Warszawie", "hotele w Gdańsku 15-17.12 hotele", "hotele 4* na weekend 27-29/11",
                   "hotele w Gdańsku dla dwóch dorosłych z półtorarocznym dzieckiem 15-17.12", "hotel dla 2 osób 3 noce",
                   "hotele 3* 4 km od Wawelu 12–13.12"]) {
    assert.equal(userAskedForCount(t), false, t);
  }
});
test("opis ceny i zdanie konczace liste (13.11)", () => {
  assert.equal(priceLabel(1198.76, 2, "PLN"), "1198,76 PLN za 2 noce (599,38 PLN/noc)");
  assert.equal(priceLabel(620, 1, "PLN"), "620 PLN za 1 noc");
  assert.equal(priceLabel(1000, 5, "EUR"), "1000 EUR za 5 nocy (200 EUR/noc)");
  assert.equal(priceLabel(null, 2, "PLN"), null);
  assert.equal(closingLine(1, 1, 10, true), "Znaleziono 1 obiekt spełniający kryteria – to wszystkie wyniki.");
  assert.equal(closingLine(18, 10, 10, true), "Znaleziono 18 obiektów spełniających kryteria – napisz „dalej”, aby zobaczyć kolejne 8.");
  assert.equal(closingLine(18, 18, 10, false), "To już wszystkie wyniki (18).");
  assert.equal(closingLine(3, 3, 10, true), "Znaleziono 3 obiekty spełniające kryteria – to wszystkie wyniki.");
});

import { cityFromAddress } from "../dist/services/textParsing.js";
test("miasto z adresu Google (13.11, sam link)", () => {
  assert.equal(cityFromAddress("Galopu 7, 02-822 Warszawa, Polska"), "Warszawa");
  assert.equal(cityFromAddress("Hagenbeckstraße 150, 22527 Hamburg, Niemcy"), "Hamburg");
  assert.equal(cityFromAddress("Freyova 945/33, 190 00 Praha 9, Czechy"), "Praha");
  assert.equal(cityFromAddress("Elizabetes iela 24, Centra rajons, Rīga, LV-1050, Łotwa"), "Rīga");
  assert.equal(cityFromAddress("1 High St, Bedford MK40 1RW, Wielka Brytania"), "Bedford");
  assert.equal(cityFromAddress("Wita Stwosza 37, 40-042 Katowice, Polska"), "Katowice");
  assert.equal(cityFromAddress(""), null);
});
