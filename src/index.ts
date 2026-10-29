#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { BookingApiClient } from "./services/bookingClient.js";
import { registerHotelSearchTool } from "./tools/hotelSearch.js";
import { registerSearchCitiesTool } from "./tools/listCities.js";
import { registerHotelDetailsTool, loadFacilityNames } from "./tools/hotelDetails.js";
import { registerFindHotelTool, prewarmCity } from "./tools/findHotel.js";
import { registerFindLandmarkTool } from "./tools/findLandmark.js";
import { RequestContext, contextFromHeaders } from "./services/requestContext.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

// ---------------------------------------------------------------------------
// UWIERZYTELNIENIE (2026-10-29, przeglad kodu pkt 1)
// Klucz przychodzi w naglowku "mcp-key" z polaczenia konektora Copilot Studio
// (uwierzytelnianie kluczem API w konektorze - klucz zaszyfrowany w polaczeniu,
// nie w definicji agenta). Po stronie serwera: sekret Azure -> MCP_ACCESS_KEY.
// MCP_AUTH_MODE:
//   "log" (domyslnie) - tylko logujemy zgodnosc klucza, przepuszczamy wszystko,
//   "enforce"         - bez poprawnego klucza odpowiadamy 401.
// Brak MCP_ACCESS_KEY = brak sprawdzania (jak przed zmiana).
// ---------------------------------------------------------------------------
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY ?? "";
const MCP_AUTH_MODE = (process.env.MCP_AUTH_MODE ?? "log").trim().toLowerCase();

type KeyCheck = "zgodny" | "niezgodny" | "brak" | string;

// Klucz moze przyjsc z polaczenia konektora ("mcp-key") albo z danych wejsciowych
// narzedzia w Copilot Studio ("mcp-access-key" - inna nazwa, bo parametru o nazwie
// "mcp-key" Copilot Studio nie pokazuje w Inputs, gdy polaczenie ma juz taki klucz).
function accessKeyHeader(req: Request): unknown {
  const fromInputs = req.headers["mcp-access-key"];
  if (typeof fromInputs === "string" && fromInputs.length > 0) return fromInputs;
  return req.headers["mcp-key"];
}

// Copilot Studio kopiuje dane wejsciowe narzedzia (w tym klucz) do
// params.sessionContext w initialize - log z 2026-10-29 14:22 mial klucz jawnym
// tekstem. Przed zapisaniem body do logu maskujemy wszystko, co wyglada na sekret.
const SECRET_FIELD_RE = /key|secret|token|password|authorization/i;

function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_FIELD_RE.test(k) && typeof v === "string" ? "***(" + v.length + ")" : maskSecrets(v, depth + 1);
  }
  return out;
}

function checkAccessKey(header: unknown): KeyCheck {
  if (typeof header !== "string" || header.length === 0) return "brak";
  // Bez MCP_ACCESS_KEY nie ma z czym porownac, ale logujemy, czy klucz w ogole przychodzi.
  if (!MCP_ACCESS_KEY) return ("nie sprawdzam, naglowek jest (" + header.length + " znakow)") as KeyCheck;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(MCP_ACCESS_KEY, "utf8");
  return a.length === b.length && timingSafeEqual(a, b) ? "zgodny" : "niezgodny";
}

console.error("=== booking-mcp-server starting (stateless) ===");
console.error("=== Uwierzytelnienie: " + (MCP_ACCESS_KEY ? "klucz ustawiony, tryb " + MCP_AUTH_MODE : "brak MCP_ACCESS_KEY - nie sprawdzam") + " ===");
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

function buildServer(ctx: RequestContext): McpServer {
  const server = new McpServer({ name: "booking-mcp-server", version: "1.0.0" });
  const apiClient = new BookingApiClient(config.bookingApiKey, config.bookingAffiliateId);

  registerHotelSearchTool(server, apiClient, ctx);
  registerSearchCitiesTool(server, apiClient);
  registerHotelDetailsTool(server, config.bookingApiKey, config.bookingAffiliateId);
  registerFindHotelTool(server, apiClient);
  registerFindLandmarkTool(server, apiClient, ctx);

  return server;
}

app.post("/mcp", async (req: Request, res: Response) => {
  const started = Date.now();
  console.error("=== POST /mcp received ===");
  // (2026-10-29) Test nagłówków z konektora Copilot Studio: klucz dostępu (tylko
  // czy jest i jaką ma długość - nigdy wartość) oraz identyfikator rozmowy.
  const keyCheck = checkAccessKey(accessKeyHeader(req));
  const convHeader = req.headers["conversation-id"];
  const keySource = typeof req.headers["mcp-access-key"] === "string" && (req.headers["mcp-access-key"] as string).length > 0
    ? "mcp-access-key" : (typeof req.headers["mcp-key"] === "string" && (req.headers["mcp-key"] as string).length > 0 ? "mcp-key" : "-");
  console.error("=== DIAG naglowki: klucz=" + keyCheck + " (z naglowka " + keySource + ", tryb " + MCP_AUTH_MODE + ")" +
    ", conversation-id=" + (typeof convHeader === "string" && convHeader.length > 0 ? "\"" + convHeader + "\"" : "brak"));
  if (MCP_AUTH_MODE === "enforce" && MCP_ACCESS_KEY && keyCheck !== "zgodny") {
    console.error("=== Odrzucone: brak poprawnego klucza mcp-key (" + keyCheck + ") ===");
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: (req.body && typeof req.body === "object" && (req.body as any).id) ?? null,
    });
    return;
  }
  console.error("Body:", JSON.stringify(maskSecrets(req.body)));

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

  const server = buildServer(contextFromHeaders(req.headers));
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
app.get("/mcp", (req: Request, res: Response) => {
  // Zakladka "Testuj" konektora w Power Apps wysyla GET - logujemy naglowki,
  // zeby sprawdzic, czy polaczenie dokleja mcp-key.
  const convHeader = req.headers["conversation-id"];
  console.error("=== GET /mcp (405) - DIAG naglowki: mcp-key=" + checkAccessKey(accessKeyHeader(req)) +
    ", conversation-id=" + (typeof convHeader === "string" && convHeader.length > 0 ? "\"" + convHeader + "\"" : "brak"));
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

// ---------------------------------------------------------------------------
// PREWARM: po starcie ladujemy w tle slownik udogodnien oraz miasta i listy
// hoteli dla najczesciej uzywanych miast. Bez tego pierwszy konsultant po
// kazdym deployu/restarcie czekal dodatkowe sekundy (2026-10-21: samo
// rozwiazanie "Bialystok" ~2 s, lista Gdanska ~2 s). Miasta po kolei, zeby
// nie obciazac API naraz; serwer odpowiada normalnie w trakcie.
// Lista do edycji: PREWARM_CITIES w zmiennych srodowiskowych, format
// "Warsaw:pl,Krakow:pl" - jesli brak, uzywamy domyslnej.
// ---------------------------------------------------------------------------
const DEFAULT_PREWARM_CITIES = "Warsaw:pl,Krakow:pl,Gdansk:pl,Wroclaw:pl,Poznan:pl,Katowice:pl,Lodz:pl";

async function prewarm(): Promise<void> {
  const started = Date.now();
  const client = new BookingApiClient(config.bookingApiKey, config.bookingAffiliateId);
  await loadFacilityNames(config.bookingApiKey, config.bookingAffiliateId);

  const list = (process.env.PREWARM_CITIES ?? DEFAULT_PREWARM_CITIES)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of list) {
    const [city, country] = item.split(":");
    if (city && country) await prewarmCity(client, city, country);
  }
  console.error("=== PREWARM: zakonczony w " + (Date.now() - started) + " ms ===");
}

app.listen(PORT, () => {
  console.error("booking-mcp-server running on http://localhost:" + PORT + "/mcp");
  prewarm().catch((err) => {
    console.error("=== PREWARM: blad (serwer dziala dalej): " + (err instanceof Error ? err.message : String(err)));
  });
});