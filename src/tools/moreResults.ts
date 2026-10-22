import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getResultSet, getPage, totalPages } from "../services/resultStore.js";

// ---------------------------------------------------------------------------
// KOLEJNE PACZKI WYNIKOW (2026-10-21, v2)
//
// v1 wymagala od modelu podania numeru strony. Test w Copilot Studio: model
// dwa razy wyslal te sama strone, podpisal ja "21-30", a "ostatni hotel"
// wzial z pierwszej paczki. Teraz SERWER pamieta, ktora paczke juz wydal
// (lastServedPage) - model wola narzedzie tylko z result_set_id i dostaje
// nastepna paczke. page zostaje opcjonalne, wylacznie dla prosby typu
// "pokaz jeszcze raz pozycje 11-20".
// Kazdy hotel ma stale pole "position" (1..N) - model ma pokazac dokladnie
// te numery, wiec przepisanie starej paczki od razu widac.
// ---------------------------------------------------------------------------

const MoreResultsInputSchema = z.object({
  result_set_id: z.string().min(8).max(100)
    .describe("The 'result_set_id' from the booking_search_hotels response. Always the same id for the whole search."),
  page: z.number().int().min(1).max(20).optional()
    .describe("LEAVE EMPTY for 'dalej'/'next'/'more' - the server knows which batch comes next. Set it ONLY if the user explicitly asks to see a specific batch again (e.g. 'pokaż jeszcze raz 11-20' -> page 2)."),
});

type MoreResultsInput = z.infer<typeof MoreResultsInputSchema>;

export function registerMoreResultsTool(server: McpServer): void {
  server.registerTool(
    "booking_get_more_results",
    {
      title: "Show More Hotels From Last Search",
      description:
        "Return the NEXT batch of hotels from a search already done with booking_search_hotels. Use it when " +
        "the user asks for more/next/the rest ('dalej', 'pokaż kolejne', 'więcej', 'pokaż resztę', 'daj wszystkie'). " +
        "Call it with ONLY result_set_id (do not pass page) - the server tracks which batch is next. " +
        "It does NOT call Booking.com, so do NOT call booking_search_hotels again just to see more results. " +
        "DISPLAY: show EXACTLY the hotels in this response, each numbered with its 'position' field " +
        "(e.g. 21., 22., ...). Never re-use hotels from an earlier batch and never invent the list - if you " +
        "notice the hotels look the same as before, still show only what this response contains. " +
        "If status is 'no_more_results', say all results were already shown. If status is 'expired', re-run " +
        "booking_search_hotels with the last active_search_state and then call this tool with the new result_set_id.",
      inputSchema: MoreResultsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params: MoreResultsInput) => {
      const entry = getResultSet(params.result_set_id);

      if (!entry) {
        console.error("=== DIAG more_results: zestaw " + params.result_set_id + " wygasl lub nie istnieje.");
        const output = {
          status: "expired",
          message: "This result set is no longer available (older than 1 hour or the server restarted). " +
            "Re-run booking_search_hotels with the last active_search_state from this conversation, then call " +
            "booking_get_more_results with the new result_set_id. Do not mention this technical detail to the user.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const pages = totalPages(entry);
      const total = entry.hotels.length;
      const requestedPage = params.page ?? entry.lastServedPage + 1;

      if (requestedPage > pages) {
        console.error("=== DIAG more_results: zestaw " + params.result_set_id + " - brak kolejnych (strona " +
          requestedPage + " > " + pages + ").");
        const output = {
          status: "no_more_results",
          total_matching: total,
          message: "All " + total + " matching hotels have already been shown (positions 1-" + total + "). " +
            "Tell the user there are no more results for this search. Do NOT list any hotels.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const hotels = getPage(entry, requestedPage);
      entry.lastServedPage = Math.max(entry.lastServedPage, requestedPage);
      const from = (requestedPage - 1) * entry.page_size + 1;
      const to = from + hotels.length - 1;
      const hasMore = requestedPage < pages;
      const remaining = total - to;

      console.error("=== DIAG more_results: zestaw " + params.result_set_id + ", strona " + requestedPage +
        "/" + pages + (params.page != null ? " (podana przez model)" : " (automatycznie nastepna)") +
        ", pozycje " + from + "-" + to + " z " + total + ": pierwszy=\"" + (hotels[0]?.name ?? "-") +
        "\", ostatni=\"" + (hotels[hotels.length - 1]?.name ?? "-") + "\", bez zapytan do API.");

      const output: any = {
        status: "ok",
        result_set_id: params.result_set_id,
        batch: requestedPage,
        total_batches: pages,
        showing_positions: from + "-" + to,
        total_matching: total,
        remaining: remaining,
        has_more: hasMore,
        hotels: hotels,
        ...entry.meta,
        display_instruction: "Show ONLY these " + hotels.length + " hotels, numbered with their 'position' " +
          "field (" + from + "-" + to + "), in this exact order, in the same format as before. " +
          (hasMore
            ? "Then say " + remaining + " more remain and the user can write 'dalej'."
            : "Then say these were the last results of this search (all " + total + " shown)."),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API" }],
        structuredContent: output,
      };
    }
  );
}