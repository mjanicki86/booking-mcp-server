import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BookingApiClient } from "../services/bookingClient.js";
import { RequestContext } from "../services/requestContext.js";
import { rememberChatHotel, recentChatHotel } from "../services/chatHotel.js";
import { DEFAULT_BOOKER_COUNTRY, DEFAULT_BOOKER_PLATFORM } from "../constants.js";
import { resolveStay, childAgesQuestion } from "../services/stayContext.js";

// === DOSTEPNOSC JEDNEGO HOTELU (02.11, zgloszenie Emilii: "czy w grudniu hotel
// Sumratin w Dubrowniku przyjmuje gosci?") ===
// Booking.com nie ma pola "hotel zamkniety w sezonie", ale /accommodations/search
// mozna zawezic do jednego obiektu (accommodations: [id]). Brak wolnych pokoi we
// wszystkich sprawdzonych terminach = hotel wyprzedany albo zamkniety sezonowo.

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const InputSchema = z.object({
  hotel_id: z.number().int().positive().optional()
    .describe("hotel_id from booking_find_hotel in this message. Omit in a follow-up about the same hotel ('a w styczniu?') - the server remembers the hotel of this conversation."),
  checkin: z.string().regex(dateRegex).optional()
    .describe("Check-in YYYY-MM-DD, when the user gave exact dates."),
  checkout: z.string().regex(dateRegex).optional()
    .describe("Check-out YYYY-MM-DD (default: checkin + 1 night)."),
  month: z.number().int().min(1).max(12).optional()
    .describe("Month 1-12 when the user asks about a month without exact dates ('w grudniu' -> 12). The server checks several dates in that month."),
  year: z.number().int().min(2024).max(2100).optional()
    .describe("Year for month; omit - the nearest future occurrence of the month is used."),
  find_first_available: z.boolean().optional()
    .describe("true for 'od kiedy jest otwarty?' / 'kiedy najbliższy wolny termin?': the server checks one date per month for the next 12 months."),
  // Goscie i tresc prosby (09.11, zgloszenie Damiana: dziecko zginelo przy dostepnosci Faltomu) -
  // ustalane wspolnie z wyszukiwaniem (services/stayContext.ts): agent -> tresc prosby -> rozmowa.
  adults: z.number().int().min(1).max(30).optional()
    .describe("Number of adults. Omit if the user did not say - the server uses user_request or the conversation."),
  rooms: z.number().int().min(1).max(30).optional(),
  children_count: z.number().int().min(0).max(10).optional(),
  children_ages: z.array(z.number().int().min(0).max(17)).optional()
    .describe("Age of each child, e.g. [1] for a 1.5-year-old."),
  user_request: z.string().max(2000).optional()
    .describe("The user's request, verbatim - the server reads dates and guests from it when parameters are missing."),
  currency: z.string().min(3).max(3).default("PLN"),
  breakfast_only: z.boolean().default(false)
    .describe("true for 'ze śniadaniem' - prices of offers with breakfast included."),
});
type Input = z.infer<typeof InputSchema>;

function iso(d: Date): string {
  return d.toISOString().split("T")[0];
}
function addDays(s: string, n: number): string {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
function todayIso(): string {
  return iso(new Date());
}

// Terminy do sprawdzenia w miesiacu: 1, 8, 15, 22 i 28 dzien (1 noc), bez dat z przeszlosci.
function datesInMonth(month: number, year?: number): { checkin: string; checkout: string }[] {
  const now = new Date();
  let y = year ?? now.getUTCFullYear();
  if (year == null && month < now.getUTCMonth() + 1) y += 1;
  const today = todayIso();
  const out: { checkin: string; checkout: string }[] = [];
  for (const day of [1, 8, 15, 22, 28]) {
    const ci = y + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    if (ci < today) continue;
    out.push({ checkin: ci, checkout: addDays(ci, 1) });
  }
  return out;
}

// Po jednym terminie (15. dzien) w kazdym z 12 kolejnych miesiecy.
function monthlyProbe(): { checkin: string; checkout: string }[] {
  const now = new Date();
  const out: { checkin: string; checkout: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 15, 12));
    const ci = iso(d);
    if (ci < todayIso()) continue;
    out.push({ checkin: ci, checkout: addDays(ci, 1) });
  }
  return out;
}

interface CheckResult {
  checkin: string;
  checkout: string;
  available: boolean;
  price_total: number | null;
  currency: string | null;
  breakfast_included: boolean | null;
  free_cancellation: boolean | null;
  error?: string;
}

interface Guests { adults: number; rooms: number; children_ages: number[] }

async function checkOne(client: BookingApiClient, id: number, p: Input, g: Guests, checkin: string, checkout: string): Promise<CheckResult> {
  const guests: any = { number_of_adults: g.adults, number_of_rooms: g.rooms };
  if (g.children_ages.length > 0) guests.children = g.children_ages;
  const body: any = {
    booker: { country: DEFAULT_BOOKER_COUNTRY, platform: DEFAULT_BOOKER_PLATFORM },
    checkin, checkout,
    guests,
    currency: p.currency,
    accommodations: [id],
    extras: ["products"],
  };
  if (p.breakfast_only) body.meal_plan = "breakfast_included";
  try {
    const raw: any = await client.post<any>("/accommodations/search", body);
    const h = Array.isArray(raw?.data) ? raw.data.find((x: any) => x?.id === id) : null;
    if (!h) {
      return { checkin, checkout, available: false, price_total: null, currency: null, breakfast_included: null, free_cancellation: null };
    }
    const prod = Array.isArray(h.products) ? h.products[0] : null;
    const plan = prod?.policies?.meal_plan?.plan ?? null;
    const cancel = prod?.policies?.cancellation?.type ?? null;
    return {
      checkin, checkout, available: true,
      price_total: typeof h.price?.book === "number" ? h.price.book : (typeof h.price?.total === "number" ? h.price.total : null),
      currency: h.currency ?? p.currency,
      breakfast_included: plan ? plan !== "no_plan" : null,
      free_cancellation: cancel ? cancel === "free_cancellation" : null,
    };
  } catch (err) {
    return {
      checkin, checkout, available: false, price_total: null, currency: null, breakfast_included: null,
      free_cancellation: null, error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

export function registerHotelAvailabilityTool(server: McpServer, client: BookingApiClient, ctx: RequestContext): void {
  const scope = ctx.chatId ?? "";
  server.registerTool(
    "booking_check_hotel_availability",
    {
      title: "Availability of one hotel",
      description: "Availability and price of ONE specific hotel for given dates, a month, or the next free date. " +
        "Use it for: 'czy hotel X ma wolne pokoje 12-13.12', 'ile kosztuje hotel X w terminie…', 'czy hotel X przyjmuje " +
        "gości w grudniu' (month: 12), 'od kiedy hotel X jest otwarty' / 'najbliższy wolny termin' (find_first_available). " +
        "First get hotel_id with booking_find_hotel in this message; in a follow-up about the same hotel omit hotel_id. " +
        "Report each checked date: available with price (total for the stay) or no free rooms. If no date is " +
        "available, follow note exactly: offers_in_api false = Booking.com does not share this hotel's offers with the " +
        "assistant (give booking_url); otherwise the dates are sold out. Never say the hotel is closed or seasonal. " +
        "Always copy the user's request verbatim into user_request and pass children_ages when children travel " +
        "(the server keeps guests and dates of this conversation).",
      inputSchema: InputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: Input) => {
      const started = Date.now();
      let id = params.hotel_id;
      let name: string | null = null;
      const remembered = recentChatHotel(scope);
      if (!id && remembered) {
        id = remembered.id;
        name = remembered.name;
        console.error("=== DIAG dostepnosc: hotel z wczesniejszej wiadomosci w tym czacie: " + id + " (" + (name ?? "?") + ").");
      } else if (id && remembered && remembered.id === id) {
        name = remembered.name;
      }
      if (!id) {
        return {
          content: [{ type: "text", text: "No hotel_id. Call booking_find_hotel first (hotel name + city), then call this tool with the returned hotel_id." }],
          isError: true,
        };
      }

      // Miesiac / najblizszy wolny termin maja pierwszenstwo - wtedy daty z tresci prosby i rozmowy
      // nie sa brane (ale goscie tak).
      const toolPicksDates = !params.checkin && !!(params.month || params.find_first_available);
      const stay = resolveStay(scope, params, "dostepnosc", { ignoreDates: toolPicksDates });
      if (stay.pastError) {
        return { content: [{ type: "text", text: stay.pastError }], isError: true };
      }
      if (stay.children_without_age > 0) {
        return { content: [{ type: "text", text: childAgesQuestion(stay) }], isError: true };
      }
      const guests: Guests = { adults: stay.adults, rooms: stay.rooms, children_ages: stay.children_ages };

      let dates: { checkin: string; checkout: string }[];
      let mode: string;
      if (stay.checkin && !toolPicksDates) {
        const ci = stay.checkin;
        const co = stay.checkout && stay.checkout > ci ? stay.checkout : addDays(ci, 1);
        dates = [{ checkin: ci, checkout: co }];
        mode = "dates";
      } else if (params.month) {
        dates = datesInMonth(params.month, params.year);
        mode = "month";
      } else if (params.find_first_available) {
        dates = monthlyProbe();
        mode = "first_available";
      } else {
        return {
          content: [{ type: "text", text: "Give checkin (exact dates), month, or find_first_available. If the user did not say when, ask for the dates or month." }],
          isError: true,
        };
      }
      if (dates.length === 0) {
        return { content: [{ type: "text", text: "All dates in that month are in the past - ask the user which month or year they mean." }], isError: true };
      }

      const results = await Promise.all(dates.map((d) => checkOne(client, id!, params, guests, d.checkin, d.checkout)));
      rememberChatHotel(scope, id, name);
      const availableCount = results.filter((r) => r.available).length;
      const firstAvailable = results.find((r) => r.available) ?? null;
      console.error("=== DIAG dostepnosc: hotel " + id + ", tryb " + mode + ", " + dates.length + " terminow, wolne: " +
        availableCount + " [" + results.map((r) => r.checkin + (r.available ? "=" + r.price_total : "=brak")).join(", ") +
        "], " + (Date.now() - started) + " ms");

      // === BRAK OFERT: WYPRZEDANY TERMIN czy HOTEL NIEDOSTEPNY W API? (10.11, Faltom id 87169:
      // 0 ofert w kazdym terminie i dla kazdej liczby gosci, a strona Booking.com pokazuje pokoje) ===
      // Przy zerze sprawdzamy po cichu 2 terminy za ~1 i ~2 mies. (1 noc, 1 dorosly, bez filtra
      // sniadania). Sa oferty -> brak pokoi w terminie; nigdzie -> Booking.com nie udostepnia ofert.
      let apiUnavailable = false;
      let bookingUrl: string | null = null;
      if (availableCount === 0) {
        let probesAvailable = 0;
        if (mode !== "first_available") {
          const probeGuests: Guests = { adults: 1, rooms: 1, children_ages: [] };
          const probeDates = [30, 60].map((n) => addDays(todayIso(), n));
          const probes = await Promise.all(probeDates.map((ci) =>
            checkOne(client, id!, { ...params, breakfast_only: false } as Input, probeGuests, ci, addDays(ci, 1))));
          probesAvailable = probes.filter((r) => r.available).length;
          console.error("=== DIAG dostepnosc: 0 ofert w zadanych terminach - kontrola " + probeDates.join(", ") +
            " (1 noc, 1 dorosly): " + (probesAvailable > 0 ? "sa oferty -> termin wyprzedany" : "brak ofert -> hotel niedostepny w API"));
        }
        apiUnavailable = probesAvailable === 0;
        if (apiUnavailable) {
          try {
            const d: any = await client.post<any>("/accommodations/details", { accommodations: [id], languages: ["pl"] });
            const u = Array.isArray(d?.data) ? d.data[0]?.url : null;
            bookingUrl = typeof u === "string" ? u : null;
          } catch { bookingUrl = null; }
        }
      }

      let note: string;
      if (availableCount === 0 && apiUnavailable) {
        note = "Booking.com returns NO offers for this hotel through the API used by this assistant - not in the " +
          "requested dates and not in control dates about 1 and 2 months ahead. This usually means the hotel's rooms " +
          "are not shared with partners (they may still be visible on the Booking.com website). Suggested wording: " +
          "Booking.com does not share offers of this hotel with the assistant, so availability cannot be checked here - " +
          "check it on the Booking.com website" + (bookingUrl ? " (booking_url)" : "") + " or with the hotel. " +
          "Do NOT say the hotel is closed, sold out or seasonal.";
      } else if (availableCount === 0) {
        note = "No free rooms in the requested dates (list them), while the hotel does have offers on other dates - " +
          "so these dates are sold out or restricted. Suggested wording: no free rooms in these dates; offer to check " +
          "other dates (find_first_available or another date).";
      } else if (mode === "first_available") {
        note = "Say the first checked date with free rooms (" + firstAvailable!.checkin + ") and that dates before it had " +
          "no free rooms (one date per month was checked, so availability may start earlier within that month).";
      } else {
        note = "List each checked date: available with total price for the stay, or no free rooms." +
          (mode === "month" ? " Say these are sample dates in the month (1 night each)." : "");
      }
      const out: any = {
        hotel_id: id,
        hotel_name: name,
        mode,
        adults: guests.adults,
        children_ages: guests.children_ages.length > 0 ? guests.children_ages : undefined,
        rooms: guests.rooms,
        breakfast_only: params.breakfast_only,
        results,
        offers_in_api: availableCount > 0 ? true : apiUnavailable ? false : true,
        booking_url: bookingUrl ?? undefined,
        note,
        data_source: "Booking.com API",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out) + "\n\n---\nSource: Booking.com API" }],
        structuredContent: out,
      };
    },
  );
}
