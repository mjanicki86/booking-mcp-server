// Wspolny kontekst pobytu (09.11): agent -> tresc prosby -> pamiec rozmowy -> domyslne.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStay, _resetStayMemory } from "../dist/services/stayContext.js";
import { addDaysIso, warsawToday } from "../dist/services/dates.js";

const ci = addDaysIso(warsawToday(), 20);
const co = addDaysIso(warsawToday(), 22);

test("dziecko z wyszukiwania przechodzi do dostepnosci (Faltom 09.11)", () => {
  _resetStayMemory();
  const s1 = resolveStay("czat1", { checkin: ci, checkout: co, adults: 2, children_ages: [1],
    user_request: "hotele w Trójmieście dla dwóch dorosłych z półtorarocznym dzieckiem" }, "test", {});
  assert.deepEqual(s1.children_ages, [1]);
  const s2 = resolveStay("czat1", { checkin: ci, checkout: co, adults: 2, user_request: "a Hotel Spa Faltom Gdynia Rumia?" }, "test", {});
  assert.deepEqual(s2.children_ages, [1]);
  assert.equal(s2.sources.children, "rozmowa");
});

test("daty z rozmowy, gdy agent i tekst ich nie maja", () => {
  _resetStayMemory();
  resolveStay("czat2", { checkin: ci, checkout: co, user_request: "hotele w Gdańsku" }, "test", {});
  const s = resolveStay("czat2", { user_request: "a koło dworca?" }, "test", {});
  assert.equal(s.checkin, ci);
  assert.equal(s.dates_source, "rozmowa");
});

test("rozmowy sa rozdzielone", () => {
  _resetStayMemory();
  resolveStay("czatA", { checkin: ci, checkout: co, adults: 3 }, "test", {});
  const b = resolveStay("czatB", { user_request: "hotele w Gdańsku" }, "test", {});
  assert.equal(b.adults, 1);
  assert.equal(b.checkin, undefined);
});

test("dziecko bez wieku = pytanie o wiek; 'bez dzieci' czysci", () => {
  _resetStayMemory();
  const s = resolveStay("czat3", { user_request: "hotel dla rodziny z dzieckiem" }, "test", {});
  assert.equal(s.children_without_age, 1);
  resolveStay("czat3", { children_ages: [5] }, "test", {});
  const n = resolveStay("czat3", { user_request: "a teraz bez dzieci" }, "test", {});
  assert.deepEqual(n.children_ages, []);
});

test("ignoreDates: dostepnosc w miesiacu nie bierze dat z tekstu", () => {
  _resetStayMemory();
  const s = resolveStay("czat4", { user_request: "czy w grudniu 10-11.12 hotel przyjmuje gości?" }, "test", { ignoreDates: true });
  assert.equal(s.checkin, undefined);
});
