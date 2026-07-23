import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const HotelSearchInputSchema = z.object({
  city: z.string().min(2).max(100).optional()
    .describe('City name IN ENGLISH, e.g. "Warsaw" (not "Warszawa"), "Amsterdam", "Rome" (not "Roma"). Always translate to English. Use ONLY for general "hotels in [city]" requests. OPTIONAL if latitude/longitude are provided instead.'),
  country: z.string().min(2).max(2).optional()
    .describe('Two-letter lowercase country code (ISO 3166-1), e.g. "pl", "nl". REQUIRED when city is used; infer from the city name.'),
  latitude: z.number().min(-90).max(90).optional()
    .describe('Latitude of a specific point (landmark, station, address). MANDATORY (together with longitude) whenever the user mentions a specific place or distance, e.g. "near the Palace of Culture", "within 2 km of the airport", "close to the train station". Do NOT just search by city and claim proximity - you MUST supply real coordinates for the named place, e.g. 52.2318 for the Palace of Culture in Warsaw. If you do not know the exact coordinates of the place, say so instead of guessing or silently falling back to a city search.'),
  longitude: z.number().min(-180).max(180).optional()
    .describe('Longitude of a specific point. Must be used together with latitude, e.g. 21.0060 for the Palace of Culture in Warsaw. See latitude description - this is mandatory whenever the user asks for hotels near/within X km of a named place.'),
  radius_km: z.number().min(0.1).max(50).default(3)
    .describe('Search radius in kilometres around latitude/longitude (default 3). Set from the user request, e.g. "within 1 km" -> 1, "within 2 km" -> 2. Only used with coordinates.'),
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
    .describe('Sort by: "price", "review_score", "distance", or "popularity". "distance" works best with coordinates.'),
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