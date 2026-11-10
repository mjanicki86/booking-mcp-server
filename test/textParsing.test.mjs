// Testy regresji (09.11, Etap 1): przypadki z realnych zgloszen testerow od 29.10.
// Uruchamiane w obrazie Dockera po kompilacji (npm test) - blad testu zatrzymuje wdrozenie.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestedAccommodationTypes, parseUserDistanceKm, isNextBatchRequest, NEAR_PLACE_RE,
  OTHER_ACCOMMODATION_RE, NEGATED_TYPE_RE, breakfastIntent, wantsParking, parseGuestsFromText,
  normalizeFacilities, alternativeNamesFromRequest, kidsFacilitiesFromText,
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
