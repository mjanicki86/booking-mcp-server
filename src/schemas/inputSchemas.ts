import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const HotelSearchInputSchema = z.object({
  city: z.string().min(2).max(100)
    .describe('City name, e.g. "Warszawa", "Amsterdam"'),
  checkin: z.string().regex(dateRegex)
    .describe('Check-in date in YYYY-MM-DD format, e.g. "2026-07-13"'),
  checkout: z.string().regex(dateRegex)
    .describe('Check-out date in YYYY-MM-DD format, e.g. "2026-07-17"'),
  adults: z.number().int().min(1).max(30).default(1)
    .describe("Number of adult guests (default: 1)"),
  rooms: z.number().int().min(1).max(30).default(1)
    .describe("Number of rooms (default: 1)"),
  currency: z.string().min(3).max(3).default("PLN")
    .describe('3-letter currency code, e.g. "PLN", "EUR"'),
  breakfast_only: z.boolean().default(false)
    .describe("Only return hotels that include breakfast"),
  free_cancellation_only: z.boolean().default(false)
    .describe("Only return hotels with free cancellation"),
  min_stars: z.number().int().min(1).max(5).optional()
    .describe("Minimum hotel star rating (1-5). Only set if user explicitly requests it."),
  results_limit: z.number().int().min(1).max(100).default(10)
    .describe("Maximum number of hotels to return (default: 10)"),
  sort_by: z.string().default("popularity")
    .describe('Sort by: "price", "review_score", "distance", or "popularity"'),
});

export type HotelSearchInput = z.infer<typeof HotelSearchInputSchema>;

export const SearchCitiesInputSchema = z.object({
  query: z.string().min(2).max(100)
    .describe('City name or partial name, e.g. "War", "Amsterdam"'),
  limit: z.number().int().min(1).max(20).default(10)
    .describe("Maximum number of results to return (default: 10)"),
});

export type SearchCitiesInput = z.infer<typeof SearchCitiesInputSchema>;