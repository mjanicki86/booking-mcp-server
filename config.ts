// src/config.ts
// Ten plik czyta ustawienia (adresy, hasła) ze zmiennych środowiskowych.
// Dzięki temu hasła NIE są zapisane w kodzie, tylko w ustawieniach Azure.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      "Brak wymaganej zmiennej środowiskowej: " + name +
      ". Ustaw ją w Azure Container Apps (Secrets / Environment variables)."
    );
  }
  return value;
}

export const config = {
  // Adres API Booking.com - produkcyjny jako domyślny.
  // Można go nadpisać w Azure zmienną BOOKING_API_BASE_URL (np. na sandbox).
  bookingApiBaseUrl:
    process.env.BOOKING_API_BASE_URL ?? "https://demandapi.booking.com/3.2",

  // Hasła - MUSZĄ być ustawione w Azure, inaczej serwer się nie uruchomi.
  bookingApiKey: requireEnv("BOOKING_API_KEY"),
  bookingAffiliateId: requireEnv("BOOKING_AFFILIATE_ID"),
};