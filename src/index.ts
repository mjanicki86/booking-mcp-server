#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { BookingApiClient } from "./services/bookingClient.js";
import { registerHotelSearchTool } from "./tools/hotelSearch.js";
import { registerSearchCitiesTool } from "./tools/listCities.js";

const BOOKING_API_KEY = process.env.BOOKING_API_KEY ?? "";
const BOOKING_AFFILIATE_ID = process.env.BOOKING_AFFILIATE_ID ?? "";
const PORT = parseInt(process.env.PORT ?? "8080", 10);

console.error(`Starting in HTTP mode on port ${PORT}`);
console.error(`API KEY set: ${BOOKING_API_KEY ? "YES" : "NO"}`);

if (!BOOKING_API_KEY) {
  console.error("Warning: BOOKING_API_KEY not set. All API calls will fail.");
}

const server = new McpServer({ name: "booking-mcp-server", version: "1.0.0" });
const apiClient = new BookingApiClient(BOOKING_API_KEY, BOOKING_AFFILIATE_ID);

registerHotelSearchTool(server, apiClient, BOOKING_API_KEY);
registerSearchCitiesTool(server, BOOKING_API_KEY);

const app = express();
app.use(express.json());

app.get("/health", (_req, res) =>
  res.json({ status: "ok", server: "booking-mcp-server" })
);

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () =>
  console.error(`booking-mcp-server running on http://localhost:${PORT}/mcp`)
);