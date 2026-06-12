#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express_1 = __importDefault(require("express"));
const bookingClient_js_1 = require("./services/bookingClient.js");
const hotelSearch_js_1 = require("./tools/hotelSearch.js");
const listCities_js_1 = require("./tools/listCities.js");
const BOOKING_API_KEY = process.env.BOOKING_API_KEY ?? "";
const TRANSPORT = process.env.TRANSPORT ?? "stdio";
const PORT = parseInt(process.env.PORT ?? "3000", 10);
if (!BOOKING_API_KEY) {
    console.error("Warning: BOOKING_API_KEY not set. All API calls will fail.");
}
const server = new mcp_js_1.McpServer({ name: "booking-mcp-server", version: "1.0.0" });
const apiClient = new bookingClient_js_1.BookingApiClient(BOOKING_API_KEY);
(0, hotelSearch_js_1.registerHotelSearchTool)(server, apiClient, BOOKING_API_KEY);
(0, listCities_js_1.registerSearchCitiesTool)(server, BOOKING_API_KEY);
async function runHTTP() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.get("/health", (_req, res) => res.json({ status: "ok", server: "booking-mcp-server" }));
    app.post("/mcp", async (req, res) => {
        const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on("close", () => transport.close());
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });
    app.listen(PORT, () => console.error(`booking-mcp-server running on http://localhost:${PORT}/mcp`));
}
async function runStdio() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("booking-mcp-server running on stdio");
}
if (TRANSPORT === "http") {
    runHTTP().catch(err => { console.error(err); process.exit(1); });
}
else {
    runStdio().catch(err => { console.error(err); process.exit(1); });
}
//# sourceMappingURL=index.js.map