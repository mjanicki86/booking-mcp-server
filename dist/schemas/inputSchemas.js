"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchCitiesInputSchema = exports.HotelSearchInputSchema = void 0;
const zod_1 = require("zod");
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = (label) => zod_1.z.string()
    .regex(dateRegex, `${label} must be in YYYY-MM-DD format (e.g. "2024-12-12")`)
    .refine((d) => !isNaN(new Date(d).getTime()), `${label} must be a valid date`);
exports.HotelSearchInputSchema = zod_1.z.object({
    city: zod_1.z.string().min(2).max(100)
        .describe('City name in any language, e.g. "Warszawa", "Tokyo", "New York", "Barcelona"'),
    checkin: dateSchema("checkin")
        .describe('Check-in date in YYYY-MM-DD format, e.g. "2024-12-12"'),
    checkout: dateSchema("checkout")
        .describe('Check-out date in YYYY-MM-DD format, e.g. "2024-12-17"'),
    adults: zod_1.z.number().int().min(1).max(30).default(1)
        .describe("Number of adult guests (default: 1)"),
    rooms: zod_1.z.number().int().min(1).max(30).default(1)
        .describe("Number of rooms (default: 1)"),
    children_ages: zod_1.z.array(zod_1.z.number().int().min(0).max(17)).max(10).optional()
        .describe("Ages of children travelling, e.g. [5, 10]"),
    currency: zod_1.z.string().length(3).toUpperCase().default("PLN")
        .describe('3-letter currency code, e.g. "PLN", "EUR", "USD"'),
    breakfast_only: zod_1.z.boolean().default(false)
        .describe("Only return hotels that include breakfast"),
    free_cancellation_only: zod_1.z.boolean().default(false)
        .describe("Only return hotels with free cancellation"),
    min_stars: zod_1.z.number().int().min(1).max(5).optional()
        .describe("Minimum hotel star rating (1–5)"),
    results_limit: zod_1.z.number().int().min(1).max(100).default(20)
        .describe("Maximum number of hotels to return (default: 20)"),
    offset: zod_1.z.number().int().min(0).default(0)
        .describe("Number of results to skip for pagination (default: 0)"),
    sort_by: zod_1.z.enum(["price", "review_score", "distance", "popularity"]).default("popularity")
        .describe('Sort results by: "price", "review_score", "distance", or "popularity"'),
}).strict().refine((d) => new Date(d.checkout) > new Date(d.checkin), { message: "checkout must be after checkin", path: ["checkout"] });
exports.SearchCitiesInputSchema = zod_1.z.object({
    query: zod_1.z.string().min(2).max(100)
        .describe('City name or partial name, e.g. "War", "Tokyo", "New York"'),
    limit: zod_1.z.number().int().min(1).max(20).default(10)
        .describe("Maximum number of results to return (default: 10)"),
}).strict();
//# sourceMappingURL=inputSchemas.js.map