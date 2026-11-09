// Testy dat pobytu (05.11 Damian "na dziś", 06.11 Julia "15-16.12"), dzien odniesienia staly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDatesFromText, fixStayDates, addDaysIso, warsawToday } from "../dist/services/dates.js";

const T = "2026-11-06";

test("daty z tresci prosby", () => {
  const p = (s) => parseDatesFromText(s, T);
  assert.deepEqual(p("apartament koło Magazynowej 7, termin 15-16.12, 1 apartament"), { checkin: "2026-12-15", checkout: "2026-12-16" });
  assert.deepEqual(p("hotele w Raszynie ze śniadaniem 10–11.11"), { checkin: "2026-11-10", checkout: "2026-11-11" });
  assert.deepEqual(p("czy w terminie 10-11/11 w okolicy centrum"), { checkin: "2026-11-10", checkout: "2026-11-11" });
  assert.deepEqual(p("hotele 30.12-2.01 w Gdańsku"), { checkin: "2026-12-30", checkout: "2027-01-02" });
  assert.deepEqual(p("hotele 15-16 grudnia w Krakowie"), { checkin: "2026-12-15", checkout: "2026-12-16" });
  assert.deepEqual(p("od 3 stycznia do 5 stycznia"), { checkin: "2027-01-03", checkout: "2027-01-05" });
  assert.deepEqual(p("hotel na 10.12 w Poznaniu"), { checkin: "2026-12-10" });
  assert.deepEqual(p("hotele 3* 4 km od Wawelu 12–13.12"), { checkin: "2026-12-12", checkout: "2026-12-13" });
  assert.equal(p("hotele 3-4 km od Wawelu"), null);
  assert.equal(p("ocena 8.5-9 i cena 300-400 zł"), null);
  assert.equal(p("1-2 osoby, 2 pokoje"), null);
});

test("dzis/jutro i jedna data = 1 noc (05.11)", () => {
  const today = warsawToday();
  const r = fixStayDates(undefined, undefined, "sprawdz dostepność hoteli w warszawie na dzis, 4*");
  assert.equal(r.checkin, today);
  assert.equal(r.checkout, addDaysIso(today, 1));
  const j = fixStayDates(undefined, undefined, "hotel na jutro w Krakowie");
  assert.equal(j.checkin, addDaysIso(today, 1));
  const one = fixStayDates(addDaysIso(today, 30), undefined, "hotele");
  assert.equal(one.checkout, addDaysIso(today, 31));
});

test("zamieniony dzien z miesiacem i data z przeszlosci", () => {
  const today = warsawToday();
  const [y, m, d] = today.split("-");
  if (Number(d) <= 12 && d !== m) {
    // np. 2026-11-05 wyslane jako 2026-05-11
    const swapped = y + "-" + d + "-" + m;
    if (swapped < today) {
      const r = fixStayDates(swapped, undefined, "hotele");
      assert.equal(r.checkin, today);
    }
  }
  const past = fixStayDates(addDaysIso(today, -40).replace(/-(\d\d)$/, "-28"), undefined, "hotele 28.");
  assert.ok(past.pastError || past.checkin >= today);
});
