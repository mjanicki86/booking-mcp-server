import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const HotelSearchInputSchema = z.object({
  city: z.string().min(2).max(100)
    .describe('City name in any language, e.g. "Warszawa", "Tokyo", "New York", "Barcelona"'),
  checkin: z.string().regex(dateRegex)
    .describe('Check-in date in YYYY-MM-DD format, e.g. "2024-12-12"'),
  checkout: z.string().regex(dateRegex)
    .describe('Check-out date in YYYY-MM-DD format, e.g. "2024-12-17"'),
  adults: z.number().int().min(1).max(30).default(1)
    .describe("Number of adult guests (default: 1)"),
  rooms: z.number().int().min(1).max(30).default(1)
    .describe("Number of rooms (default: 1)"),
  currency: z.string().length(3).default("PLN")
    .describe('3-letter currency code, e.g. "PLN", "EUR", "USD"'),
  breakfast_only: z.boolean().default(false)
    .describe("Only return hotels that include breakfast"),
  free_cancellation_only: z.boolean().default(false)
    .describe("Only return hotels with free cancellation"),
  min_stars: z.number().int().min(1).max(5).optional()
    .describe("Minimum hotel star rating (1-5)"),
  results_limit: z.number().int().min(1).max(100).default(20)
    .describe("Maximum number of hotels to return (default: 20)"),
  sort_by: z.string().default("popularity")
    .describe('Sort results by one of: "price", "review_score", "distance", "popularity". Default: popularity'),
});

export type HotelSearchInput = z.infer<typeof HotelSearchInputSchema>;

export const SearchCitiesInputSchema = z.object({
  query: z.string().min(2).max(100)
    .describe('City name or partial name, e.g. "War", "Tokyo", "New York"'),
  limit: z.number().int().min(1).max(20).default(10)
    .describe("Maximum number of results to return (default: 10)"),
});

export type SearchCitiesInput = z.infer<typeof SearchCitiesInputSchema>;