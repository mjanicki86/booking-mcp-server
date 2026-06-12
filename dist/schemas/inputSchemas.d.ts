import { z } from "zod";
export declare const HotelSearchInputSchema: z.ZodEffects<z.ZodObject<{
    city: z.ZodString;
    checkin: z.ZodEffects<z.ZodString, string, string>;
    checkout: z.ZodEffects<z.ZodString, string, string>;
    adults: z.ZodDefault<z.ZodNumber>;
    rooms: z.ZodDefault<z.ZodNumber>;
    children_ages: z.ZodOptional<z.ZodArray<z.ZodNumber, "many">>;
    currency: z.ZodDefault<z.ZodString>;
    breakfast_only: z.ZodDefault<z.ZodBoolean>;
    free_cancellation_only: z.ZodDefault<z.ZodBoolean>;
    min_stars: z.ZodOptional<z.ZodNumber>;
    results_limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
    sort_by: z.ZodDefault<z.ZodEnum<["price", "review_score", "distance", "popularity"]>>;
}, "strict", z.ZodTypeAny, {
    city: string;
    checkin: string;
    checkout: string;
    adults: number;
    currency: string;
    rooms: number;
    breakfast_only: boolean;
    free_cancellation_only: boolean;
    results_limit: number;
    offset: number;
    sort_by: "price" | "review_score" | "distance" | "popularity";
    children_ages?: number[] | undefined;
    min_stars?: number | undefined;
}, {
    city: string;
    checkin: string;
    checkout: string;
    adults?: number | undefined;
    currency?: string | undefined;
    rooms?: number | undefined;
    children_ages?: number[] | undefined;
    breakfast_only?: boolean | undefined;
    free_cancellation_only?: boolean | undefined;
    min_stars?: number | undefined;
    results_limit?: number | undefined;
    offset?: number | undefined;
    sort_by?: "price" | "review_score" | "distance" | "popularity" | undefined;
}>, {
    city: string;
    checkin: string;
    checkout: string;
    adults: number;
    currency: string;
    rooms: number;
    breakfast_only: boolean;
    free_cancellation_only: boolean;
    results_limit: number;
    offset: number;
    sort_by: "price" | "review_score" | "distance" | "popularity";
    children_ages?: number[] | undefined;
    min_stars?: number | undefined;
}, {
    city: string;
    checkin: string;
    checkout: string;
    adults?: number | undefined;
    currency?: string | undefined;
    rooms?: number | undefined;
    children_ages?: number[] | undefined;
    breakfast_only?: boolean | undefined;
    free_cancellation_only?: boolean | undefined;
    min_stars?: number | undefined;
    results_limit?: number | undefined;
    offset?: number | undefined;
    sort_by?: "price" | "review_score" | "distance" | "popularity" | undefined;
}>;
export type HotelSearchInput = z.infer<typeof HotelSearchInputSchema>;
export declare const SearchCitiesInputSchema: z.ZodObject<{
    query: z.ZodString;
    limit: z.ZodDefault<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    query: string;
    limit: number;
}, {
    query: string;
    limit?: number | undefined;
}>;
export type SearchCitiesInput = z.infer<typeof SearchCitiesInputSchema>;
//# sourceMappingURL=inputSchemas.d.ts.map