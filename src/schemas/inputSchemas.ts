import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const HotelSearchInputSchema = z.object({
  city: z.string().min(2).max(100).optional()
    .describe('City name in English, e.g. "Warsaw", "Rome". For "hotels in [city]"; not needed with latitude/longitude.'),
  country: z.string().min(2).max(2).optional()
    .describe('Two-letter lowercase country code, e.g. "pl". Required with city.'),
  latitude: z.number().min(-90).max(90).optional()
    .describe('Usually omit - for a named place pass landmark_name instead. Only a latitude returned by a tool in this message, never typed from memory.'),
  longitude: z.number().min(-180).max(180).optional()
    .describe('Longitude, together with latitude.'),
  // Bez .default() - promien domyslny i poszerzanie ustala serwer (hotelSearch.ts, PROMIEN DOMYSLNY).
  radius_km: z.number().min(0.1).max(50).optional()
    .describe('Search radius in kilometres around latitude/longitude. Pass ONLY when the user stated a distance; otherwise omit - the server applies its default. Only used with coordinates.'),
  checkin: z.string().regex(dateRegex).optional()
    .describe('Check-in date YYYY-MM-DD. Optional - do not ask for dates; without them sample dates are used.'),
  checkout: z.string().regex(dateRegex).optional()
    .describe('Check-out date in YYYY-MM-DD format. OPTIONAL - omit if the user did not give dates.'),
  adults: z.number().int().min(1).max(30).default(1)
    .describe("Number of adult guests (default: 1)"),
  rooms: z.number().int().min(1).max(30).default(1)
    .describe("Number of rooms (default: 1)"),
  children_count: z.number().int().min(0).max(10).optional()
    .describe("Number of children - always together with children_ages."),
  children_ages: z.array(z.number().int().min(0).max(17)).optional()
    .describe("Age of each child, e.g. [3, 8]. Ask the user if ages are not known."),
  currency: z.string().min(3).max(3).default("PLN")
    .describe('3-letter currency code, e.g. "PLN", "EUR"'),
  max_price_per_night: z.number().positive().optional()
    .describe("Maximum price per night (not per stay) in the given currency."),
  min_price_per_night: z.number().positive().optional()
    .describe("Minimum price per night, only if the user gives a lower bound."),
  breakfast_only: z.boolean().default(false)
    .describe("Only hotels with breakfast included in the price - set only for 'śniadanie w cenie' / 'breakfast included', not for a plain 'ze śniadaniem'."),
  free_cancellation_only: z.boolean().default(false)
    .describe("Only return hotels with free cancellation"),
  min_stars: z.number().int().min(1).max(5).optional()
    .describe("Star category 1-5 (a minimum unless exact_stars is true)."),
  exact_stars: z.boolean().default(false)
    .describe("true when the user names one category ('hotele 3*', '4-gwiazdkowy'); false for 'co najmniej 3*', '3+'."),
  min_review_score: z.number().min(1).max(10).optional()
    .describe("Minimum guest rating out of 10, e.g. 'ocena powyżej 8' -> 8."),
  required_facilities: z.array(z.enum([
    "pool", "gym", "parking", "wifi", "air_conditioning", "spa", "restaurant", "sauna", "pets_allowed"
  ])).optional()
    .describe("Amenities the hotel must have, only these values: pool, gym, parking, wifi, air_conditioning, spa, restaurant, sauna, pets_allowed (pets -> pets_allowed)."),
  exclude_hostels: z.boolean().default(true)
    .describe("Hotels only (no hostels, apartments, villas, B&Bs). Default true; false only if the user accepts those."),
  results_limit: z.number().int().min(1).max(100).default(10)
    .describe("Only when the user asks for fewer than 10 hotels ('pokaż 5 najlepszych' -> 5). For more, results come in batches - do not set."),
  sort_by: z.string().default("popularity")
    .describe('price, review_score, distance (around a point), stars or popularity (default).'),
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