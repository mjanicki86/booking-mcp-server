import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const HotelSearchInputSchema = z.object({
  city: z.string().min(2).max(100).optional()
    .describe('City name IN ENGLISH, e.g. "Warsaw" (not "Warszawa"), "Amsterdam", "Rome" (not "Roma"). Always translate to English. ONLY for general "hotels in [city]" requests. OPTIONAL if latitude/longitude are provided instead.'),
  country: z.string().min(2).max(2).optional()
    .describe('Two-letter lowercase country code (ISO 3166-1), e.g. "pl", "nl". REQUIRED when city is used; infer from the city name.'),
  latitude: z.number().min(-90).max(90).optional()
    .describe('Latitude of a specific point (landmark, station, address). MANDATORY (together with longitude) whenever the user mentions a specific place or distance, e.g. "near the Palace of Culture", "within 2 km of the airport". You must supply the REAL coordinates yourself - never fall back to a plain city search and claim proximity.'),
  longitude: z.number().min(-180).max(180).optional()
    .describe('Longitude of a specific point. Must be used together with latitude.'),
  radius_km: z.number().min(0.1).max(50).default(3)
    .describe('Search radius in kilometres around latitude/longitude (default 3). Only used with coordinates.'),
  checkin: z.string().regex(dateRegex).optional()
    .describe('Check-in date in YYYY-MM-DD format. OPTIONAL - if the user did not give dates, DO NOT ask them; omit this and a default date about 3 months ahead will be used.'),
  checkout: z.string().regex(dateRegex).optional()
    .describe('Check-out date in YYYY-MM-DD format. OPTIONAL - omit if the user did not give dates.'),
  adults: z.number().int().min(1).max(30).default(1)
    .describe("Number of adult guests (default: 1)"),
  rooms: z.number().int().min(1).max(30).default(1)
    .describe("Number of rooms (default: 1)"),
  children_count: z.number().int().min(0).max(10).optional()
    .describe("Number of children staying. Set together with children_ages when the user mentions travelling with children."),
  children_ages: z.array(z.number().int().min(0).max(17)).optional()
    .describe("Age of each child, e.g. [3, 8] for two children aged 3 and 8. Length must match children_count."),
  currency: z.string().min(3).max(3).default("PLN")
    .describe('3-letter currency code, e.g. "PLN", "EUR"'),
  max_price_per_night: z.number().positive().optional()
    .describe("Maximum price PER NIGHT the user is willing to pay, in the given currency. Set this whenever the user mentions a price limit. This is per night, not total stay."),
  min_price_per_night: z.number().positive().optional()
    .describe("Minimum price PER NIGHT, in the given currency. Set only if the user gives a lower bound, e.g. 'at least 200 PLN a night'."),
  breakfast_only: z.boolean().default(false)
    .describe("Only return hotels where breakfast is INCLUDED in the room price at no extra cost. " +
      "IMPORTANT: set this ONLY when the user explicitly says breakfast must be included/free/bundled " +
      "in the price (e.g. 'breakfast included', 'ze śniadaniem w cenie', 'free breakfast'). " +
      "Do NOT set this for a generic mention of breakfast without that qualifier (e.g. plain " +
      "'with breakfast' / 'ze śniadaniem') - most hotels offer breakfast as a PAID add-on, which " +
      "this filter would incorrectly exclude. If unsure whether the user means included-only or " +
      "breakfast-available-for-a-fee-is-fine, leave this false and mention in your answer which " +
      "hotels include breakfast vs charge extra for it, rather than filtering them out."),
  free_cancellation_only: z.boolean().default(false)
    .describe("Only return hotels with free cancellation"),
  min_stars: z.number().int().min(1).max(5).optional()
    .describe("Minimum hotel star rating (1-5). Only set if user explicitly requests it."),
  min_review_score: z.number().min(1).max(10).optional()
    .describe("Minimum guest review score out of 10. Set whenever the user asks for well-reviewed/highly-rated hotels, e.g. 'reviews above 8' -> 8."),
  required_facilities: z.array(z.enum([
    "pool", "gym", "parking", "wifi", "air_conditioning", "spa", "restaurant", "sauna", "pets_allowed"
  ])).optional()
    .describe("List of amenities the hotel MUST have, enforced by the server. Set this whenever the user asks for hotels with a specific amenity. MUST use EXACTLY these string values (nothing else is valid): \"pool\", \"gym\", \"parking\", \"wifi\", \"air_conditioning\", \"spa\", \"restaurant\", \"sauna\", \"pets_allowed\". Examples: 'hotels with a pool' -> [\"pool\"], 'with pool and gym' -> [\"pool\", \"gym\"], 'that accept pets' / 'pet-friendly' / 'dog-friendly' -> [\"pets_allowed\"] (NOT \"pets\" - that value does not exist and will be rejected). Do NOT try to verify amenities by calling booking_get_hotel_details on each result instead - use this parameter so the search itself is filtered correctly."),
  exclude_hostels: z.boolean().default(false)
    .describe("Exclude hostels/dormitory-style accommodations from results. Set to true when the user wants a 'proper hotel' or explicitly says no hostels, or implicitly seems to want higher-quality lodging despite a low budget."),
  results_limit: z.number().int().min(1).max(100).default(10)
    .describe("Maximum number of hotels to return, up to 100. Set this when the user asks for a specific number of results, e.g. 'show me 50 hotels' -> 50."),
  sort_by: z.string().default("popularity")
    .describe('Sort by: "price", "review_score", "distance", "stars", or "popularity". "distance" works best with coordinates.'),
});

export type HotelSearchInput = z.infer<typeof HotelSearchInputSchema>;

export const SearchCitiesInputSchema = z.object({
  query: z.string().min(2).max(100)
    .describe('City name or partial name IN ENGLISH, e.g. "War", "Amsterdam"'),
  country: z.string().min(2).max(2)
    .describe('Two-letter lowercase country code to search in, e.g. "pl", "nl"'),
  limit: z.number().int().min(1).max(20).default(10)
    .describe("Maximum number of results to return (default: 10)"),
});

export type SearchCitiesInput = z.infer<typeof SearchCitiesInputSchema>;

export const FindLandmarkInputSchema = z.object({
  landmark_name: z.string().min(2).max(150)
    .describe('Name of the landmark, station, attraction or point of interest, e.g. "Fontanna Neptuna", "Central Station", "Eiffel Tower".'),
  city: z.string().min(2).max(100)
    .describe('City the landmark is located in, IN ENGLISH, e.g. "Warsaw", "Amsterdam".'),
  country: z.string().min(2).max(2)
    .describe('Two-letter lowercase country code, e.g. "pl", "nl".'),
});

export type FindLandmarkInput = z.infer<typeof FindLandmarkInputSchema>;