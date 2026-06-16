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
  console.error("Warning: BOOKING_API_KEY not set.");
}
if (!BOOKING_AFFILIATE_ID) {
  console.error("Warning: BOOKING_AFFILIATE_ID not set.");
}

const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "booking-mcp-server" });
});

app.post("/mcp", async (req: Request, res: Response) => {
  console.error("=== POST /mcp received ===");
  console.error("Body:", JSON.stringify(req.body));

  const body: any = req.body;
  const isJsonRpc = body && typeof body === "object" && body.jsonrpc !== undefined;

  if (!isJsonRpc) {
    console.error("=== Ignoring probe request ===");
    res.status(202).end();
    return;
  }

  req.headers["accept"] = "application/json, text/event-stream";
  req.headers["content-type"] = "application/json";

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    } else {
      const server = new McpServer({ name: "booking-mcp-server", version: "1.0.0" });
      const apiClient = new BookingApiClient(BOOKING_API_KEY, BOOKING_AFFILIATE_ID);

      registerHotelSearchTool(server, apiClient);
      registerSearchCitiesTool(server);

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
        console.error("=== Session created: " + transport.sessionId + " ===");
      }
    }
  } catch (err) {
    console.error("=== ERROR: " + (err instanceof Error ? err.stack : String(err)));
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session ID" });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

app.listen(PORT, () => {
  console.error("booking-mcp-server running on http://localhost:" + PORT + "/mcp");
});