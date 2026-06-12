export interface CitySearchResult {
    city_id: number;
    name: string;
    country: string;
    region?: string;
}
/**
 * Look up a city by name using the Booking.com Locations API.
 * Returns the best match, or null if nothing found.
 */
export declare function resolveCityId(cityName: string, apiKey: string): Promise<CitySearchResult | null>;
/**
 * Search for cities matching a partial name — used by booking_search_cities tool.
 */
export declare function searchCities(query: string, apiKey: string, limit?: number): Promise<CitySearchResult[]>;
//# sourceMappingURL=cityResolver.d.ts.map