"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCityId = resolveCityId;
exports.searchCities = searchCities;
const constants_js_1 = require("../constants.js");
// In-memory cache — avoids calling the API twice for the same city
const cityCache = new Map();
/**
 * Look up a city by name using the Booking.com Locations API.
 * Returns the best match, or null if nothing found.
 */
async function resolveCityId(cityName, apiKey) {
    const cacheKey = cityName.toLowerCase().trim();
    if (cityCache.has(cacheKey)) {
        return cityCache.get(cacheKey) ?? null;
    }
    const url = `${constants_js_1.BOOKING_API_BASE_URL}/locations/cities?name=${encodeURIComponent(cityName)}&limit=5`;
    let response;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                "X-Affiliate-Id": apiKey,
                "Authorization": `Bearer ${apiKey}`,
            },
            signal: AbortSignal.timeout(10_000),
        });
    }
    catch (err) {
        throw new Error(`Network error while looking up city "${cityName}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
        if (response.status === 404) {
            cityCache.set(cacheKey, null);
            return null;
        }
        throw new Error(`City lookup failed (HTTP ${response.status}): ${response.statusText}. ` +
            `Check that your BOOKING_API_KEY has access to the locations endpoint.`);
    }
    const data = await response.json();
    const results = data.result ?? data.data ?? data.cities ?? data ?? [];
    if (!Array.isArray(results) || results.length === 0) {
        cityCache.set(cacheKey, null);
        return null;
    }
    // Prefer exact name match, otherwise take first result
    const normalised = cityName.toLowerCase().trim();
    const best = results.find((r) => (r.name ?? r.city_name ?? "").toLowerCase() === normalised) ?? results[0];
    const resolved = {
        city_id: best.city_id ?? best.id ?? best.dest_id,
        name: best.name ?? best.city_name ?? cityName,
        country: best.country ?? best.country_code ?? "",
        region: best.region ?? best.state ?? undefined,
    };
    cityCache.set(cacheKey, resolved);
    return resolved;
}
/**
 * Search for cities matching a partial name — used by booking_search_cities tool.
 */
async function searchCities(query, apiKey, limit = 10) {
    const url = `${constants_js_1.BOOKING_API_BASE_URL}/locations/cities?name=${encodeURIComponent(query)}&limit=${limit}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "X-Affiliate-Id": apiKey,
            "Authorization": `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
        throw new Error(`City search failed (HTTP ${response.status}): ${response.statusText}`);
    }
    const data = await response.json();
    const results = data.result ?? data.data ?? data.cities ?? data ?? [];
    if (!Array.isArray(results))
        return [];
    return results.map((r) => ({
        city_id: r.city_id ?? r.id ?? r.dest_id,
        name: r.name ?? r.city_name ?? query,
        country: r.country ?? r.country_code ?? "",
        region: r.region ?? r.state ?? undefined,
    }));
}
//# sourceMappingURL=cityResolver.js.map