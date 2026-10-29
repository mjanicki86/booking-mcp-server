import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// PAMIEC WYNIKOW WYSZUKIWANIA - PACZKI (2026-10-22, v3)
//
// v1/v2 trzymaly liste pod losowym result_set_id. Test 2026-10-22 pokazal, ze
// Copilot Studio NIE przekazuje modelowi wynikow narzedzi z poprzednich tur
// - przy "dalej" model nie znal identyfikatora i go WYMYSLAL
// ("b2e2e1e2-7c2a-4e2a-8e2e-2e2e2e2e2e2e"), dostawal "wygasl", robil nowe
// wyszukiwanie i znow dostawal pozycje 11-20.
//
// v3: kluczem jest SKROT PARAMETROW WYSZUKIWANIA (miasto/wspolrzedne, daty,
// filtry, sortowanie). Te parametry model pamieta z tekstu rozmowy i podaje
// identycznie - wiec "dalej" = to samo wyszukiwanie + continue_previous:true
// trafia w zapisana liste i dostaje nastepna paczke, bez zapytan do API.
//
// Ograniczenie: dwoch konsultantow z IDENTYCZNYM wyszukiwaniem (te same daty,
// filtry, miasto) w tej samej godzinie dzieli licznik paczek. Nowe
// wyszukiwanie zawsze zaczyna od paczki 1, wiec skutek to najwyzej
// przeskoczona paczka - akceptowalne.
//
// Pamiec procesu: po restarcie/deployu lista znika - "dalej" robi wtedy
// nowe wyszukiwanie i zaczyna od poczatku (z informacja dla usera).
// ---------------------------------------------------------------------------

export const RESULT_PAGE_SIZE = 10;

const RESULT_TTL_MS = 60 * 60 * 1000;
const MAX_STORED_SETS = 500;

export interface StoredResultSet {
  hotels: any[];                 // sformatowane, z polem position (1..N), w finalnej kolejnosci
  page_size: number;
  meta: Record<string, unknown>;
  createdAt: number;
  lastServedPage: number;        // ostatnio wydana paczka (1 = pierwsza)
  lastAccess: number;            // ostatnie uzycie (zapis albo wydanie paczki)
  scope: string;                 // czat Teams (z naglowka conversation-id); "" = brak naglowka
}

const store = new Map<string, StoredResultSet>();

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.createdAt >= RESULT_TTL_MS) store.delete(key);
  }
  while (store.size > MAX_STORED_SETS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// Stabilny klucz z parametrow wyszukiwania: klucze obiektu sortowane, tablice
// sortowane, wartosci puste pomijane - zeby kolejnosc pol w wywolaniu modelu
// albo brak domyslnego pola nie zmienialy klucza.
export function makeSearchKey(params: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm).sort();
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const val = (v as any)[k];
        if (val === undefined || val === null || (Array.isArray(val) && val.length === 0)) continue;
        o[k] = norm(val);
      }
      return o;
    }
    if (typeof v === "string") return v.trim().toLowerCase();
    return v;
  };
  return createHash("sha1").update(JSON.stringify(norm(params))).digest("hex").slice(0, 16);
}

export function saveResultSet(key: string, hotels: any[], pageSize: number, meta: Record<string, unknown>, scope = ""): void {
  evictExpired();
  const numbered = hotels.map((h, i) => ({ position: i + 1, ...h }));
  store.delete(key); // nowe wyszukiwanie = od poczatku i "najmlodszy" wpis
  const now = Date.now();
  store.set(key, { hotels: numbered, page_size: pageSize, meta, createdAt: now, lastServedPage: 1, lastAccess: now, scope });
}

export function getResultSet(key: string): StoredResultSet | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt >= RESULT_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry;
}

// 2026-10-22: przy "dalej" model wysylal SAMO continue_previous:true, bez
// miasta/dat/filtrow - nie da sie wtedy policzyc klucza. Bierzemy liste
// uzyta najpozniej (w ciagu maxAgeMs). Przy kilku konsultantach naraz moze
// to trafic w cudza liste - dlatego krotkie okno i jawna informacja w
// odpowiedzi, ktorego wyszukiwania dotyczy paczka (meta.location/daty).
// (2026-10-29) scope: tylko listy z tego samego czatu - wczesniej "dalej" bez
// parametrow moglo trafic w liste innego konsultanta.
export function getMostRecentResultSet(maxAgeMs: number, scope = ""): { key: string; entry: StoredResultSet } | null {
  let best: { key: string; entry: StoredResultSet } | null = null;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.createdAt >= RESULT_TTL_MS) continue;
    if (now - entry.lastAccess > maxAgeMs) continue;
    if (entry.scope !== scope) continue;
    if (!best || entry.lastAccess > best.entry.lastAccess) best = { key, entry };
  }
  return best;
}

export function totalPages(entry: StoredResultSet): number {
  return Math.max(1, Math.ceil(entry.hotels.length / entry.page_size));
}

// page liczone od 1
export function getPage(entry: StoredResultSet, page: number): any[] {
  const start = (page - 1) * entry.page_size;
  return entry.hotels.slice(start, start + entry.page_size);
}