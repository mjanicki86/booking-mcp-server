#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { config } from "./config.js";
import { BookingApiClient } from "./services/bookingClient.js";
import { registerHotelSearchTool } from "./tools/hotelSearch.js";
import { registerSearchCitiesTool } from "./tools/listCities.js";
import { registerHotelDetailsTool } from "./tools/hotelDetails.js";
import { registerFindHotelTool } from "./tools/findHotel.js";
import { registerFindLandmarkTool } from "./tools/findLandmark.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

console.error("=== booking-mcp-server starting (stateless) ===");
console.error("=== Booking API URL: " + config.bookingApiBaseUrl + " ===");

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "booking-mcp-server" });
});

// ---------------------------------------------------------------------------
// TRYB BEZSTANOWY (stateless)
//
// POPRZEDNIO: sesje MCP byly trzymane w pamieci procesu (Map transports).
// Po kazdym deployu/restarcie kontenera mapa byla pusta, a Copilot Studio
// (kanal Teams) dalej wysylal stary naglowek mcp-session-id. Serwer tworzyl
// wtedy nowy, NIEZAINICJALIZOWANY transport i SDK po cichu odrzucal
// tools/call (400 "Server not initialized") - w logach bylo tylko "Body",
// a agent odpowiadal "API nie zwrocilo danych". Potwierdzone 2026-10-21 na
// booking-mcp-dev--0000069 (Trio Bialystok, id 13/14/15 bez initialize).
//
// TERAZ: kazde zadanie dostaje swiezy McpServer + transport bez sesji
// (sessionIdGenerator: undefined). Kazdy tools/call dziala niezaleznie od
// tego, czy klient wczesniej wyslal initialize do TEGO procesu - restart,
// deploy, skalowanie na wiele replik nie zrywaja rozmow.
//
// Cache (miasta, inwentarz hoteli, nazwy udogodnien) zyja na poziomie
// modulow, wiec NIE sa tracone miedzy zadaniami.
// ---------------------------------------------------------------------------

function buildServer(): McpServer {
  const server = new McpServer({ name: "booking-mcp-server", version: "1.0.0" });
  const apiClient = new BookingApiClient(config.bookingApiKey, config.bookingAffiliateId);

  registerHotelSearchTool(server, apiClient);
  registerSearchCitiesTool(server, apiClient);
  registerHotelDetailsTool(server, config.bookingApiKey, config.bookingAffiliateId);
  registerFindHotelTool(server, apiClient);
  registerFindLandmarkTool(server, apiClient);

  return server;
}

app.post("/mcp", async (req: Request, res: Response) => {
  const started = Date.now();
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

  const method = typeof body.method === "string" ? body.method : "?";
  const toolName = method === "tools/call" ? (body.params?.name ?? "?") : null;

  // Kazde zadanie konczy sie linia ze statusem HTTP i czasem - wczesniej
  // odrzucone zadania nie zostawialy w logach zadnego sladu.
  res.on("finish", () => {
    console.error("=== MCP " + method + (toolName ? " (" + toolName + ")" : "") +
      " -> HTTP " + res.statusCode + ", " + (Date.now() - started) + " ms ===");
  });

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("=== ERROR: " + (err instanceof Error ? err.stack : String(err)));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: body.id ?? null,
      });
    }
  }
});

// W trybie bezstanowym nie ma strumienia SSE (GET) ani sesji do zamkniecia
// (DELETE) - zgodnie ze specyfikacja MCP odpowiadamy 405.
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
});

app.listen(PORT, () => {
  console.error("booking-mcp-server running on http://localhost:" + PORT + "/mcp");
});