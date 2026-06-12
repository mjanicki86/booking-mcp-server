import { AccommodationSearchRequest, BookingApiError, FormattedHotel, Hotel, SearchResult } from "../types.js";
export declare class BookingApiClient {
    private readonly apiKey;
    constructor(apiKey: string);
    post<T>(endpoint: string, body: unknown): Promise<T>;
    searchAccommodations(request: AccommodationSearchRequest): Promise<SearchResult>;
}
export declare class BookingApiRequestError extends Error {
    readonly apiError: BookingApiError;
    constructor(apiError: BookingApiError);
}
export declare function formatHotel(hotel: Hotel, currency: string): FormattedHotel;
//# sourceMappingURL=bookingClient.d.ts.map