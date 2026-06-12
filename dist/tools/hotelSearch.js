"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHotelSearchTool = registerHotelSearchTool;
const bookingClient_js_1 = require("../services/bookingClient.js");
const cityResolver_js_1 = require("../services/cityResolver.js");
const inputSchemas_js_1 = require("../schemas/inputSchemas.js");
const constants_js_1 = require("../constants.js");
function registerHotelSearchTool(server, client, apiKey) {
    server.registerTool("booking_search_hotels", {
        title: "Search Hotels on Booking.com",
        description: `Search for available hotels using Booking.com. Works for any city worldwide.
Args: city (any language), checkin (YYYY-MM-DD), checkout (YYYY-MM-DD), adults, rooms,
children_ages, currency, breakfast_only, free_cancellation_only, min_stars, results_limit, offset, sort_by.
Returns list of hotels with prices, ratings, distances, and booking URLs.`,
        inputSchema: inputSchemas_js_1.HotelSearchInputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async (params) => {
        // 1. Resolve city name → city_id via API
        let cityResult;
        try {
            cityResult = await (0, cityResolver_js_1.resolveCityId)(params.city, apiKey);
        }
        catch (err) {
            return {
                content: [{
                        type: "text",
                        text: `Error looking up city "${params.city}": ${err instanceof Error ? err.message : String(err)}`,
                    }],
                isError: true,
            };
        }
        if (!cityResult) {
            return {
                content: [{
                        type: "text",
                        text: `City "${params.city}" not found. Try calling booking_search_cities with a partial name to find the correct spelling.`,
                    }],
                isError: true,
            };
        }
        const { city_id: cityId, name: resolvedCityName, country } = cityResult;
        const nights = Math.round((new Date(params.checkout).getTime() - new Date(params.checkin).getTime()) / 86400000);
        try {
            const result = await client.searchAccommodations({
                booker: { country: constants_js_1.DEFAULT_BOOKER_COUNTRY, platform: constants_js_1.DEFAULT_BOOKER_PLATFORM },
                checkin: params.checkin,
                checkout: params.checkout,
                city: cityId,
                guests: {
                    number_of_adults: params.adults,
                    number_of_rooms: params.rooms,
                    ...(params.children_ages?.length
                        ? { number_of_children: params.children_ages.length, children_ages: params.children_ages }
                        : {}),
                },
                currency: params.currency,
                extras: ["hotel_info", "price_breakdown", "meal_plan"],
                rows: params.results_limit,
                offset: params.offset,
            });
            let hotels = result.hotels;
            if (params.breakfast_only)
                hotels = hotels.filter(h => h.meal_plans?.some(mp => mp.code === "breakfast_included" || mp.name?.toLowerCase().includes("breakfast")));
            if (params.free_cancellation_only)
                hotels = hotels.filter(h => h.free_cancellation);
            if (params.min_stars)
                hotels = hotels.filter(h => h.star_rating != null && h.star_rating >= params.min_stars);
            if (params.sort_by === "price")
                hotels.sort((a, b) => (a.price?.amount ?? 999999) - (b.price?.amount ?? 999999));
            else if (params.sort_by === "review_score")
                hotels.sort((a, b) => (b.review_score ?? 0) - (a.review_score ?? 0));
            else if (params.sort_by === "distance")
                hotels.sort((a, b) => (a.location?.distance_to_center ?? 999) - (b.location?.distance_to_center ?? 999));
            const currency = result.currency ?? params.currency;
            const formatted = hotels.slice(0, params.results_limit).map(h => (0, bookingClient_js_1.formatHotel)(h, currency));
            if (!formatted.length) {
                return {
                    content: [{
                            type: "text",
                            text: `No hotels found in "${resolvedCityName}, ${country}" for ${params.checkin}–${params.checkout}. Try relaxing your filters.`,
                        }],
                };
            }
            const output = {
                success: true,
                city: resolvedCityName,
                city_id: cityId,
                checkin: params.checkin,
                checkout: params.checkout,
                nights,
                adults: params.adults,
                total_found: result.total_count,
                hotels: formatted,
                currency,
            };
            const text = JSON.stringify(output, null, 2);
            return {
                content: [{
                        type: "text",
                        text: text.length > constants_js_1.CHARACTER_LIMIT
                            ? text.slice(0, constants_js_1.CHARACTER_LIMIT) + "\n...[truncated]"
                            : text,
                    }],
                structuredContent: output,
            };
        }
        catch (err) {
            if (err instanceof bookingClient_js_1.BookingApiRequestError) {
                return {
                    content: [{
                            type: "text",
                            text: `Booking.com API error (${err.apiError.status}): ${err.apiError.message}`,
                        }],
                    isError: true,
                };
            }
            return {
                content: [{
                        type: "text",
                        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                    }],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=hotelSearch.js.map