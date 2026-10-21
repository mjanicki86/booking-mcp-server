import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// PAMIEC WYNIKOW WYSZUKIWANIA (2026-10-21)
//
// booking_search_hotels pobiera i filtruje pelna liste (np. 55 hoteli), ale
// modelowi oddaje tylko pierwsza paczke - dluga lista nie miescila sie ani
// w CHARACTER_LIMIT odpowiedzi narzedzia, ani w limicie dlugosci odpowiedzi
// agenta w Copilot Studio (model pisal "lista wszystkich 55" i wstawial "...").
// Pelna, juz posortowana lista trafia tutaj pod result_set_id, a kolejne
// paczki wydaje booking_get_more_results - BEZ zapytan do Booking.com.
//
// Pamiec procesu: po restarcie/deployu lista znika - wtedy narzedzie kaze
// modelowi powtorzyc wyszukiwanie z active_search_state (jedyny przypadek,
// gdy "kolejne wyniki" wolaja API).
// ---------------------------------------------------------------------------

export const RESULT_PAGE_SIZE = 10;

const RESULT_TTL_MS = 60 * 60 * 1000;
const MAX_STORED_SETS = 500;

export interface StoredResultSet {
  hotels: any[];                 // juz sformatowane (formatHotel + distance_km), w finalnej kolejnosci
  page_size: number;
  meta: Record<string, unknown>; // location, checkin, checkout, active_search_state, notatki itd.
  createdAt: number;
}

const store = new Map<string, StoredResultSet>();

function evictExpired(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.createdAt >= RESULT_TTL_MS) store.delete(id);
  }
  // Twardy limit pamieci - Map zachowuje kolejnosc wstawiania, wiec
  // usuwamy najstarsze.
  while (store.size > MAX_STORED_SETS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function saveResultSet(hotels: any[], pageSize: number, meta: Record<string, unknown>): string {
  evictExpired();
  const id = randomUUID();
  store.set(id, { hotels, page_size: pageSize, meta, createdAt: Date.now() });
  return id;
}

export function getResultSet(id: string): StoredResultSet | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt >= RESULT_TTL_MS) {
    store.delete(id);
    return null;
  }
  return entry;
}

export function totalPages(entry: StoredResultSet): number {
  return Math.max(1, Math.ceil(entry.hotels.length / entry.page_size));
}

// page liczone od 1
export function getPage(entry: StoredResultSet, page: number): any[] {
  const start = (page - 1) * entry.page_size;
  return entry.hotels.slice(start, start + entry.page_size);
}