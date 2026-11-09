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
