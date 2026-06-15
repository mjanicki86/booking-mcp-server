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

// Store transports by session ID for Copilot Studio session management
const transports = new Map<string, StreamableHTTPServerTransport>();

app.get("/health", (_req: Request, res: Response) =>
  res.json({ status: "ok", server: "booking-mcp-server" })
);

app.post("/mcp", async (req: Request, res: Response) => {
  console.error("=== POST /mcp received ===");
  console.error("Headers:", JSON.stringify(req.headers));
  console.error("Body:", JSON.stringify(req.body));

  // Handle empty/probe requests that don't match JSON-RPC format
  // (Copilot Studio sometimes sends these as connectivity checks)
  if (!req.body || typeof req.body !== "object" || !("jsonrpc" in req.body)) {
    console.error("=== Ignoring non-JSON-RPC probe request, responding 202 ===");
    res.status(202).end();
    return;
  }

  // Force correct headers before MCP SDK validates them
  req.headers["accept"] = "application/json, text/event-stream";
  req.headers["content-type"] = "application/json";

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  try {
    if (sessionId && transports.has(sessionId)) {
      // Reuse existing session
      transport = transports.get(sessionId)!;
    } else {
      // Create new session
      const server = new McpServer({ name: "booking-mcp-server", version: "1.0.0" });
      const apiClient = new BookingApiClient(BOOKING_API_KEY, BOOKING_AFFILIATE_ID);

      registerHotelSearchTool(server, apiClient, BOOKING_API_KEY);
      registerSearchCitiesTool(server, BOOKING_API_KEY);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      });

      await server.connect(transport);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("=== ERROR in POST /mcp ===");
    console.error(err instanceof Error ? err.stack : String(err));
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error", details: err instanceof Error ? err.message : String(err) });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  console.error("=== GET /mcp received ===");
  console.error("Headers:", JSON.stringify(req.headers));

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  console.error("=== DELETE /mcp received ===");
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

app.listen(PORT, () =>
  console.error(`booking-mcp-server running on http://localhost:${PORT}/mcp`)
);