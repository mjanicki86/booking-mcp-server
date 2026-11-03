import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BookingApiClient } from "../services/bookingClient.js";
import { RequestContext } from "../services/requestContext.js";
import { shownHotels } from "../services/shownHotels.js";
import { normalizeText } from "../services/textNormalize.js";
import { config } from "../config.js";
import { loadFacilityNames, parkingInfoFromDetails } from "./hotelDetails.js";

// === INFORMACJE O WIELU HOTELACH NARAZ (03.11, zgloszenie Damiana) ===
// "godziny recepcji / parking we wszystkich wskazanych hotelach": serwer pamieta hotele
// pokazane w rozmowie (shownHotels) i pobiera ich dane JEDNYM zapytaniem /details.

const RECEPTION_24H_FACILITY = 8;

const InputSchema = z.object({
  which: z.enum(["all_shown", "search_list", "positions", "names"]).default("all_shown")
    .describe("all_shown: every hotel shown in this conversation (list + hotels asked about separately) - for 'wszystkie wskazane hotele'. search_list: only the last search list. positions: hotels at given list positions ('pierwsze trzy' -> [1,2,3]). names: hotels whose names the user gave."),
  positions: z.array(z.number().int().min(1).max(200)).optional()
    .describe("List positions for which=positions."),
  names: z.array(z.string().min(2).max(200)).optional()
    .describe("Hotel names (or parts of names) for which=names - matched against hotels shown in this conversation."),
});
type Input = z.infer<typeof InputSchema>;

function clock(t: unknown): string | null {
  return typeof t === "string" && t.length >= 5 ? t.slice(0, 5) : null;
}

export function registerHotelsInfoTool(server: McpServer, client: BookingApiClient, ctx: RequestContext): void {
  const scope = ctx.chatId ?? "";
  server.registerTool(
    "booking_get_shown_hotels_info",
    {
      title: "Info for several hotels shown in this conversation",
      description: "Check-in/check-out times, 24-hour reception and parking for SEVERAL hotels at once - the hotels " +
        "already shown in this conversation (search lists, 'dalej' batches and hotels the user asked about " +
        "separately). The server remembers them, no hotel_id needed. Use it for questions about many hotels: " +
        "'godziny recepcji we wszystkich hotelach', 'parking w tych hotelach', 'pierwsze trzy' (positions). " +
        "Answer as one compact list with one line per hotel. For one hotel use booking_get_hotel_details.",
      inputSchema: InputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: Input) => {
      const started = Date.now();
      const shown = shownHotels(scope);
      if (!shown || (shown.search.length === 0 && shown.extras.length === 0)) {
        return {
          content: [{ type: "text", text: "No hotels have been shown in this conversation in the last hour. Suggested " +
            "reply: a question which hotels the user means (name and city), or a new search." }],
          isError: true,
        };
      }
      let picked: { id: number; name: string; position?: number }[];
      if (params.which === "search_list") {
        picked = shown.search;
      } else if (params.which === "positions") {
        const pos = new Set(params.positions ?? []);
        picked = shown.search.filter((h) => h.position != null && pos.has(h.position));
      } else if (params.which === "names") {
        const all = [...shown.search, ...shown.extras];
        const qs = (params.names ?? []).map((n) => normalizeText(n));
        picked = all.filter((h) => qs.some((q) => normalizeText(h.name).includes(q) || q.includes(normalizeText(h.name))));
      } else {
        picked = [...shown.search, ...shown.extras];
      }
      if (picked.length === 0) {
        return {
          content: [{ type: "text", text: "None of the hotels shown in this conversation match. Shown hotels: " +
            [...shown.search, ...shown.extras].map((h) => (h.position ? h.position + ". " : "") + h.name).join("; ") +
            ". Suggested reply: a question which of these hotels the user means." }],
          isError: true,
        };
      }
      picked = picked.slice(0, 100);
      const names = await loadFacilityNames(config.bookingApiKey, config.bookingAffiliateId);
      let raw: any;
      try {
        raw = await client.post<any>("/accommodations/details", {
          accommodations: picked.map((h) => h.id),
          extras: ["facilities"],
          languages: ["pl", "en-gb"],
        });
      } catch (err) {
        return {
          content: [{ type: "text", text: "Booking.com details could not be fetched (" +
            (err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)) + ")." }],
          isError: true,
        };
      }
      const byId = new Map<number, any>();
      for (const d of (Array.isArray(raw?.data) ? raw.data : [])) if (typeof d?.id === "number") byId.set(d.id, d);
      const hotels = picked.map((h) => {
        const d = byId.get(h.id);
        if (!d) return { position: h.position ?? null, name: h.name, data: "not available on Booking.com" };
        const t = d.checkin_checkout_times ?? {};
        const ids = Array.isArray(d.facilities) ? d.facilities.map((f: any) => (typeof f === "number" ? f : f?.id)) : [];
        const parking = parkingInfoFromDetails(d, names);
        return {
          position: h.position ?? null,
          name: h.name,
          checkin_from: clock(t.checkin_from),
          checkin_until: clock(t.checkin_to),
          checkout_from: clock(t.checkout_from),
          checkout_until: clock(t.checkout_to),
          reception_24h: ids.includes(RECEPTION_24H_FACILITY),
          parking_summary: parking.summary,
          url: typeof d.url === "string" ? d.url : null,
        };
      });
      console.error("=== DIAG wiele hoteli: which=" + params.which + ", " + picked.length + " hoteli (" +
        shown.search.length + " z listy, " + shown.extras.length + " osobno), " + (Date.now() - started) + " ms");
      const out = {
        hotels,
        note: "One line per hotel: check-in from-until, check-out until, reception 24h yes/no (if not 24h and no hours " +
          "are given, Booking.com does not report reception hours), parking. null = Booking.com does not provide it. " +
          "A 24-hour reception does not mean check-in at any time - use checkin_from / checkin_until.",
        data_source: "Booking.com API",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out) + "\n\n---\nSource: Booking.com API" }],
        structuredContent: out,
      };
    },
  );
}
