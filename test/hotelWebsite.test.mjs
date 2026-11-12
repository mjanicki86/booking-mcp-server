// Parking ze strony hotelu (09.11): podstrona "Anfahrt & Parken" z menu, fragment z cena,
// wysokoscia, busami i EV; menu nawigacji nie trafia do fragmentow. Strony podstawione (bez sieci).
import { test } from "node:test";
import assert from "node:assert/strict";

const pages = {
  "https://hotel.example/": `<html><body><nav><a href="/anfahrt">Anfahrt &amp; Parken</a><a href="/zimmer">Zimmer</a>
    <a href="https://other.com/parking">obca strona</a></nav><p>Willkommen im Hotel. ${"Lorem ipsum dolor sit amet. ".repeat(30)}</p></body></html>`,
  "https://hotel.example/anfahrt": `<html><body><h2>Parken</h2><p>Unsere Tiefgarage bietet 40 Stellplätze.</p>
    <p>Preis: 18 € pro Tag. Max. Durchfahrtshöhe 2,05 m – nicht für Reisebusse geeignet.</p><p>E-Auto Ladestation vorhanden.</p></body></html>`,
};
globalThis.fetch = async (url) => ({
  status: pages[url] ? 200 : 404, url, headers: new Map([["content-type", "text/html"]]), text: async () => pages[url] ?? "",
});
const { parkingFromWebsite } = await import("../dist/services/hotelWebsite.js");

test("parking z podstrony hotelu", async () => {
  const r = await parkingFromWebsite("https://hotel.example/");
  assert.equal(r.fetched, true);
  assert.equal(r.pages_checked.length, 2);
  assert.equal(r.parking_snippets.length, 1);
  assert.match(r.parking_snippets[0], /Tiefgarage.*18 €.*2,05 m.*Reisebusse.*Ladestation/);
  assert.deepEqual(r.found, { height: true, ev: true, lpg: false, price: true, bus: true });
});

// Prawdziwe fragmenty z pomiaru 12.11 (22 hotele): menu, opinie i listy udogodnien odrzucane,
// konkrety (cena, busy, EV, liczba miejsc, zasady) zostaja i maja wyzszy priorytet.
const { isNoise, snippetScore } = await import("../dist/services/hotelWebsite.js");

test("odsiewanie szumu (pomiar 12.11)", () => {
  for (const s of [
    "Parking Eventy Konferencje Restauracja Sante",
    "Parking OCENA Hotelu Sante 4.5 ( 312 opinii ) OCENA Booking 9.1 / 10",
    "Parking Zwierzęta mile widziane Transfer Restauracja",
    "Parking monitorowany Fitness Internet w pokoju Zwierzęta akceptowane",
    "Parken Art Preis pro Tag Entfernung",
  ]) assert.equal(isNoise(s), true, s);
  for (const s of [
    "Duży parking (70 zł/dobę) Parking dla samochodów typu bus/van – 150 zł/dobę Xbox Stanowisko do ładowania samochodów elektrycznych",
    "Parken Unser Hotel in Berlin-Adlershof verfügt über 6 hauseigene Parkplätze, die je nach Verfügbarkeit kostenfrei genutzt werden können.",
    "Dodatkowo oferujemy duży bezpłatny parking, który pomieści zarówno samochody osobowe, busy oraz autokary.",
    "Parking at the hotel Hotel parking is subject to availability. Reservations are not accepted.",
  ]) assert.equal(isNoise(s), false, s);
  assert.ok(snippetScore("Duży parking (70 zł/dobę) bus/van – 150 zł/dobę, ładowanie samochodów elektrycznych") >
    snippetScore("Parking at the hotel is subject to availability."));
});

test("dekodowanie znakow HTML (PURO, Grein)", async () => {
  pages["https://puro.example/"] = `<html><body><p>Czy na terenie hotelu znajduje si&#x119; parking? PURO &#x141;&#xF3;d&#x17A; oferuje 17 miejsc parkingowych w gara&#x17C;u. Parking pomie&#347;ci busy &oacute;smioosobowe.</p></body></html>`;
  const r = await parkingFromWebsite("https://puro.example/");
  assert.match(r.parking_snippets[0], /się parking\? PURO Łódź oferuje 17 miejsc parkingowych w garażu/);
  assert.match(r.parking_snippets[0], /pomieści busy ósmioosobowe/);
});
