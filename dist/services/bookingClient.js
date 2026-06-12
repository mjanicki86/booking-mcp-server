"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookingApiRequestError = exports.BookingApiClient = void 0;
exports.formatHotel = formatHotel;
const constants_js_1 = require("../constants.js");
class BookingApiClient {
    apiKey;
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    async post(endpoint, body) {
        const url = `${constants_js_1.BOOKING_API_BASE_URL}${endpoint}`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Affiliate-Id": this.apiKey,
                "Authorization": `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => "Unknown error");
            throw new BookingApiRequestError({
                status: response.status,
                message: `Booking.com API error ${response.status}: ${response.statusText}`,
                details: errorText,
            });
        }
        return response.json();
    }
    async searchAccommodations(request) {
        const raw = await this.post("/accommodations/search", request);
        const rawHotels = raw.result ?? raw.data ?? raw.hotels ?? [];
        return {
            hotels: rawHotels.map(normalizeHotel),
            total_count: raw.total_count ?? raw.count ?? rawHotels.length,
            currency: raw.currency,
        };
    }
}
exports.BookingApiClient = BookingApiClient;
class BookingApiRequestError extends Error {
    apiError;
    constructor(apiError) {
        super(apiError.message);
        this.name = "BookingApiRequestError";
        this.apiError = apiError;
    }
}
exports.BookingApiRequestError = BookingApiRequestError;
function normalizeHotel(raw) {
    return {
        hotel_id: raw.hotel_id ?? raw.id ?? 0,
        name: raw.name ?? "Unknown",
        star_rating: raw.class,
        review_score: raw.review_score,
        review_count: raw.review_nr,
        review_score_word: raw.review_score_word,
        price: raw.min_total_price != null ? {
            amount: raw.price_breakdown?.all_inclusive_price ?? raw.min_total_price,
            currency: raw.price_breakdown?.currency ?? raw.currency_code ?? "PLN",
            amount_per_night: raw.price_breakdown?.sum_gross_price_per_night,
        } : undefined,
        currency: raw.currency_code,
        location: {
            address: raw.address,
            city: raw.city,
            distance_to_center: raw.distance,
        },
        meal_plans: raw.meal_plan ? [raw.meal_plan] : undefined,
        url: raw.url,
        property_type: raw.accommodation_type_name,
        free_cancellation: raw.is_free_cancellable ?? raw.has_free_cancellation ?? false,
    };
}
function formatHotel(hotel, currency) {
    return {
        hotel_id: hotel.hotel_id,
        name: hotel.name,
        stars: hotel.star_rating ?? null,
        review_score: hotel.review_score ?? null,
        review_count: hotel.review_count ?? null,
        review_word: hotel.review_score_word ?? null,
        price_total: hotel.price?.amount ?? null,
        price_per_night: hotel.price?.amount_per_night ?? null,
        currency: hotel.price?.currency ?? hotel.currency ?? currency,
        address: hotel.location?.address ?? hotel.location?.city ?? null,
        distance_to_center_km: hotel.location?.distance_to_center != null
            ? Math.round(hotel.location.distance_to_center * 10) / 10 : null,
        breakfast_included: hotel.meal_plans?.some(mp => mp.code === "breakfast_included" || mp.name?.toLowerCase().includes("breakfast")) ?? false,
        free_cancellation: hotel.free_cancellation ?? false,
        property_type: hotel.property_type ?? null,
        booking_url: hotel.url ?? null,
    };
}
//# sourceMappingURL=bookingClient.js.map