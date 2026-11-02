// Ostatni hotel ustalony w czacie (booking_find_hotel albo sprawdzenie dostepnosci).
// Pozwala na "a w styczniu?" / "a od kiedy jest otwarty?" bez ponownego szukania
// hotelu - agent nie widzi wynikow poprzednich wiadomosci. 60 min od ostatniego uzycia.
const TTL_MS = 60 * 60 * 1000;
const lastHotel = new Map<string, { id: number; name: string | null; at: number }>();

export function rememberChatHotel(scope: string, id: number, name: string | null): void {
  if (!scope || !id) return;
  lastHotel.set(scope, { id, name, at: Date.now() });
  if (lastHotel.size > 2000) {
    const oldest = lastHotel.keys().next().value;
    if (oldest !== undefined) lastHotel.delete(oldest);
  }
}

export function recentChatHotel(scope: string): { id: number; name: string | null } | null {
  if (!scope) return null;
  const hit = lastHotel.get(scope);
  if (!hit || Date.now() - hit.at > TTL_MS) return null;
  hit.at = Date.now();
  return { id: hit.id, name: hit.name };
}
