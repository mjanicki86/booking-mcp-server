import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getResultSet, getPage, totalPages } from "../services/resultStore.js";

const MoreResultsInputSchema = z.object({
  result_set_id: z.string().min(8).max(100)
    .describe("The 'result_set_id' from the most recent booking_search_hotels response (or from a previous booking_get_more_results response)."),
  page: z.number().int().min(2).max(20)
    .describe("Page number to show, starting at 2 for the second batch. Use 'next_page' from the previous response."),
});

type MoreResultsInput = z.infer<typeof MoreResultsInputSchema>;

export function registerMoreResultsTool(server: McpServer): void {
  server.registerTool(
    "booking_get_more_results",
    {
      title: "Show More Hotels From Last Search",
      description:
        "Return the NEXT batch of hotels from a search that was already done with booking_search_hotels. " +
        "Use it when the user asks for more/next/the rest/all results ('pokaż kolejne', 'dalej', 'więcej', " +
        "'pokaż resztę', 'daj wszystkie'). It does NOT call Booking.com - the hotels, prices and order are " +
        "exactly those of the original search, so do NOT call booking_search_hotels again just to see more " +
        "results. Args: result_set_id and page (use next_page from the previous response). " +
        "Display the returned batch in the same format as before, numbered continuing from the previous " +
        "batch (e.g. 11-20), and end with how many remain and that the user can write 'dalej' for more. " +
        "If status is 'expired', silently re-run booking_search_hotels with the provided active_search_state " +
        "(if available) and then show the requested batch from the new result_set_id.",
      inputSchema: MoreResultsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
            "Re-run booking_search_hotels with the same parameters (active_search_state from the last search " +
            "in this conversation) and show the requested batch from the new result_set_id. Do not tell " +
            "the user about this technical detail unless the new search returns different hotels.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const pages = totalPages(entry);
      const total = entry.hotels.length;

      if (params.page > pages) {
        const output = {
          status: "no_more_results",
          total_matching: total,
          total_pages: pages,
          message: "All " + total + " matching hotels have already been shown. Tell the user there are no more results for this search.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const hotels = getPage(entry, params.page);
      const from = (params.page - 1) * entry.page_size + 1;
      const to = from + hotels.length - 1;
      const hasMore = params.page < pages;

      console.error("=== DIAG more_results: zestaw " + params.result_set_id + ", strona " + params.page +
        "/" + pages + " (hotele " + from + "-" + to + " z " + total + "), bez zapytan do API.");

      const output: any = {
        status: "ok",
        result_set_id: params.result_set_id,
        page: params.page,
        total_pages: pages,
        showing_from: from,
        showing_to: to,
        total_matching: total,
        has_more: hasMore,
        next_page: hasMore ? params.page + 1 : null,
        hotels: hotels,
        ...entry.meta,
        display_instruction: "Show hotels " + from + "-" + to + " of " + total + ", numbered " + from + "-" + to +
          ", in exactly this order and in the same format as the previous batch. " +
          (hasMore
            ? "Then tell the user " + (total - to) + " more remain and they can write 'dalej' to see the next batch."
            : "Then tell the user these were the last results of this search."),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) + "\n\n---\nSource: Booking.com API" }],
        structuredContent: output,
      };
    }
  );
}