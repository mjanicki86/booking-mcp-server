import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const HotelSearchInputSchema = z.object({
  city: z.string().min(2).max(100)
    .describe('City name IN ENGLISH, e.g. "Warsaw" (not "Warszawa"), "Amsterdam", "Munich" (not "Muenchen"), "Rome" (not "Roma"). Always translate the city name to English before calling.'),
  country: z.string().min(2).max(2)
    .describe('Two-letter lowercase country code (ISO 3166-1) of the city, e.g. "pl" for Poland, "nl" for Netherlands. Infer it from the city name if the user does not state it.'),
  checkin: z.string().regex(dateRegex).optional()
    .describe('Check-in date in YYYY-MM-DD format. OPTIONAL - if the user did not give dates, DO NOT ask them; omit this and a default date about 3 months ahead will be used.'),
  checkout: z.string().regex(dateRegex).optional()
    .describe('Check-out date in YYYY-MM-DD format. OPTIONAL - omit if the user did not give dates.'),
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
    .describe("Maximum number of hotels to return, up to 100. Set this when the user asks for a specific number of results, e.g. 'show me 50 hotels' -> 50."),
  sort_by: z.string().default("popularity")
    .describe('Sort by: "price", "review_score", "distance", or "popularity"'),
});

export type HotelSearchInput = z.infer<typeof HotelSearchInputSchema>;

export const SearchCitiesInputSchema = z.object({
  query: z.string().min(2).max(100)
    .describe('City name or partial name IN ENGLISH, e.g. "Warsaw", "Amsterdam"'),
  country: z.string().min(2).max(2)
    .describe('Two-letter lowercase country code to search in, e.g. "pl", "nl"'),
  limit: z.number().int().min(1).max(20).default(10)
    .describe("Maximum number of results to return (default: 10)"),
});

export type SearchCitiesInput = z.infer<typeof SearchCitiesInputSchema>;