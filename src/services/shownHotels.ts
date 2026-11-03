// === HOTELE POKAZANE W ROZMOWIE (03.11, zgloszenie Damiana: "godziny recepcji we
// wszystkich wskazanych hotelach" - agent nie widzi wynikow poprzednich wiadomosci,
// wiec po kilku turach mial ID tylko ostatnich hoteli, a w koncu zadnego) ===
// search: hotele z ostatniego wyszukiwania w kolejnosci pozycji (paczki z "dalej" dopisywane),
// extras: pojedyncze hotele z booking_find_hotel / dostepnosci. 60 min od ostatniego uzycia.
const TTL_MS = 60 * 60 * 1000;

interface Shown { id: number; name: string; position?: number }
interface ChatShown { searchKey: string; search: Shown[]; extras: Shown[]; at: number }

const byChat = new Map<string, ChatShown>();

function get(scope: string): ChatShown | null {
  const e = byChat.get(scope);
  if (!e || Date.now() - e.at > TTL_MS) return null;
  return e;
}

function ensure(scope: string): ChatShown {
  let e = get(scope);
  if (!e) {
    e = { searchKey: "", search: [], extras: [], at: Date.now() };
    byChat.set(scope, e);
    if (byChat.size > 2000) {
      const oldest = byChat.keys().next().value;
      if (oldest !== undefined) byChat.delete(oldest);
    }
  }
  e.at = Date.now();
  return e;
}

// Paczka z wyszukiwania. Nowe wyszukiwanie (inny klucz listy) zastepuje liste z wyszukiwania;
// kolejna paczka tej samej listy ("dalej") jest dopisywana.
export function rememberSearchBatch(scope: string, searchKey: string, hotels: { hotel_id: number; name: string; position?: number }[]): void {
  if (!scope || hotels.length === 0) return;
  const e = ensure(scope);
  if (e.searchKey !== searchKey) { e.searchKey = searchKey; e.search = []; }
  for (const h of hotels) {
    if (!e.search.some((s) => s.id === h.hotel_id)) e.search.push({ id: h.hotel_id, name: h.name, position: h.position });
  }
  e.extras = e.extras.filter((x) => !e.search.some((s) => s.id === x.id));
}

export function rememberExtraHotel(scope: string, id: number, name: string | null): void {
  if (!scope || !id) return;
  const e = ensure(scope);
  if (e.search.some((s) => s.id === id) || e.extras.some((s) => s.id === id)) return;
  e.extras.push({ id, name: name ?? ("hotel " + id) });
  if (e.extras.length > 30) e.extras.shift();
}

export function shownHotels(scope: string): { search: Shown[]; extras: Shown[] } | null {
  if (!scope) return null;
  const e = get(scope);
  if (!e) return null;
  e.at = Date.now();
  return { search: e.search.slice(), extras: e.extras.slice() };
}
