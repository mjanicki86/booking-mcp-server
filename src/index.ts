#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { BookingApiClient } from "./services/bookingClient.js";
import { registerHotelSearchTool } from "./tools/hotelSearch.js";
import { registerSearchCitiesTool } from "./tools/listCities.js";

const BOOKING_API_KEY = process.env.BOOKING_API_KEY ?? "";
const BOOKING_AFFILIATE_ID = process.env.BOOKING_AFFILIATE_ID ?? "";
const PORT = parseInt(process.env.PORT ?? "8080", 10);

if (!BOOKING_API_KEY) {
  console.error("Warning: BOOKING_API_KEY not set. All API calls will fail.");
}

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) =>
  res.json({ status: "ok", server: "booking-mcp-server" })
);

app.post("/mcp", async (req: Request, res: Response) => {
  const server = new McpServer({ name: "booking-mcp-server", version: "1.0.0" });
  const apiClient = new BookingApiClient(BOOKING_API_KEY, BOOKING_AFFILIATE_ID);

  registerHotelSearchTool(server, apiClient, BOOKING_API_KEY);
  registerSearchCitiesTool(server, BOOKING_API_KEY);

  const acceptHeader = req.headers["accept"] ?? "";
  const useSSE = acceptHeader.includes("text/event-stream");

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: !useSSE,
  });

  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () =>
  console.error(`booking-mcp-server running on http://localhost:${PORT}/mcp`)
);