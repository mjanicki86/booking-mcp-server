// Hotel z rozmowy (13.11): numer z listy, nazwa z rozmowy, ostatni hotel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConversationHotel, rememberConversationHotel, nameMatches, hotelSourceNote } from "../dist/services/conversationHotel.js";
import { rememberSearchBatch } from "../dist/services/shownHotels.js";

test("nazwy hoteli z odmiana", () => {
  assert.equal(nameMatches("Hilton", "Hilton Gdansk"), true);
  assert.equal(nameMatches("w Hiltonie", "Hilton Gdansk"), true);
  assert.equal(nameMatches("Radisson w Sopocie", "Radisson Blu Hotel Sopot"), true);
  assert.equal(nameMatches("Hilton", "Hampton By Hilton Gdansk Old Town"), true);
  assert.equal(nameMatches("Scandic", "Hilton Gdansk"), false);
  assert.equal(nameMatches("hotel", "Hilton Gdansk"), false);
});

test("hotel z rozmowy: pozycja, nazwa, ostatni, bledy", () => {
  const s = "czat-test-1";
  assert.equal(resolveConversationHotel(s, {}).ok, false);
  rememberSearchBatch(s, "k1", [
    { hotel_id: 11, name: "PURO Gdańsk Stare Miasto", position: 1 },
    { hotel_id: 12, name: "Hilton Gdansk", position: 2 },
    { hotel_id: 13, name: "Hampton By Hilton Gdansk Old Town", position: 3 },
  ]);
  const p = resolveConversationHotel(s, { position: 3 });
  assert.equal(p.ok && p.id, 13);
  assert.equal(resolveConversationHotel(s, { position: 7 }).status, "position_not_found");
  const amb = resolveConversationHotel(s, { hotel_name: "Hilton" });
  assert.equal(amb.status, "ambiguous_name");
  const n = resolveConversationHotel(s, { hotel_name: "PURO" });
  assert.equal(n.ok && n.id, 11);
  assert.equal(resolveConversationHotel(s, { hotel_name: "Marriott" }).status, "name_not_in_conversation");
  rememberConversationHotel(s, 12, "Hilton Gdansk");
  const last = resolveConversationHotel(s, {});
  assert.equal(last.ok && last.id, 12);
  assert.equal(last.ok && last.source, "rozmowa");
  const ag = resolveConversationHotel(s, { hotel_id: 99 });
  assert.equal(ag.ok && ag.source, "agent");
  assert.equal(hotelSourceNote("agent", "x"), null);
  assert.match(hotelSourceNote("pozycja", "Hilton Gdansk"), /Hilton Gdansk/);
});
