// === HOTEL Z ROZMOWY (13.11, po zgloszeniu Damiana "a jak tam z parkingiem?") ===
// Agent nie widzi wynikow poprzednich wiadomosci, wiec przy pytaniach uzupelniajacych nie ma hotel_id.
// Jedno miejsce, ktore ustala hotel z rozmowy - dla szczegolow, dostepnosci i "w poblizu tego hotelu":
//   hotel_id od agenta > numer z ostatniej listy ("trzeci", "nr 14") > nazwa hotelu pokazanego
//   w rozmowie ("a Hilton?") > ostatni hotel rozmowy (o ktory pytano ostatnio).
import { recentChatHotel, rememberChatHotel } from "./chatHotel.js";
import { shownHotels, rememberExtraHotel } from "./shownHotels.js";
import { normalizeText } from "./textNormalize.js";

export interface HotelRef {
  hotel_id?: number | null;
  position?: number | null;
  hotel_name?: string | null;
}

export type HotelSource = "agent" | "pozycja" | "nazwa" | "rozmowa";

export type ResolvedHotel =
  | { ok: true; id: number; name: string | null; source: HotelSource }
  | { ok: false; status: "need_hotel" | "position_not_found" | "name_not_in_conversation" | "ambiguous_name"; message: string; candidates?: string[] };

const NAME_STOP = new Set(["hotel", "hotelu", "hotelem", "hotelach", "the", "w", "we", "a", "ten", "ta", "to", "tego",
  "tym", "z", "ze", "i", "na", "do", "przy", "ktory", "ktorym"]);

function tokens(s: string): string[] {
  return normalizeText(s).split(/[^a-z0-9]+/).filter((t) => t.length > 0 && !NAME_STOP.has(t));
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// "hiltonie" ~ "hilton", "sopocie" ~ "sopot", "radissona" ~ "radisson"; krotkie slowa tylko dokladnie.
function tokenLike(q: string, n: string): boolean {
  if (q === n) return true;
  const shorter = Math.min(q.length, n.length);
  if (shorter < 4) return false;
  return commonPrefix(q, n) >= Math.max(4, shorter - 2);
}

export function nameMatches(query: string, hotelName: string): boolean {
  const q = tokens(query);
  if (q.length === 0) return false;
  const n = tokens(hotelName);
  return q.every((qt) => n.some((nt) => tokenLike(qt, nt)));
}

export function resolveConversationHotel(scope: string, ref: HotelRef): ResolvedHotel {
  const shown = shownHotels(scope);
  const all = shown ? [...shown.search, ...shown.extras] : [];

  if (ref.hotel_id != null) {
    const known = all.find((h) => h.id === ref.hotel_id);
    const recent = recentChatHotel(scope);
    return { ok: true, id: ref.hotel_id, name: known?.name ?? (recent?.id === ref.hotel_id ? recent.name : null), source: "agent" };
  }

  if (ref.position != null) {
    const list = shown?.search ?? [];
    const hit = list.find((h) => h.position === ref.position);
    if (hit) return { ok: true, id: hit.id, name: hit.name, source: "pozycja" };
    const maxPos = list.reduce((m, h) => Math.max(m, h.position ?? 0), 0);
    return {
      ok: false, status: "position_not_found",
      message: list.length === 0
        ? "There is no hotel list in this conversation yet. Suggested reply: ask which hotel (name and city) the user means."
        : "The last list in this conversation has hotels 1-" + maxPos + " shown, there is no number " + ref.position +
          ". Suggested reply: ask which hotel the user means.",
    };
  }

  if (ref.hotel_name && ref.hotel_name.trim().length >= 2) {
    const matches = all.filter((h) => nameMatches(ref.hotel_name!, h.name));
    if (matches.length === 1) return { ok: true, id: matches[0].id, name: matches[0].name, source: "nazwa" };
    if (matches.length > 1) {
      return {
        ok: false, status: "ambiguous_name",
        message: "Several hotels shown in this conversation match \"" + ref.hotel_name + "\". Suggested reply: ask which " +
          "one the user means (list the names below), or use the list number (position).",
        candidates: matches.slice(0, 6).map((h) => h.name + (h.position ? " (nr " + h.position + ")" : "")),
      };
    }
    return {
      ok: false, status: "name_not_in_conversation",
      message: "\"" + ref.hotel_name + "\" is not among hotels shown in this conversation. Call booking_find_hotel " +
        "with this name and the city, then call this tool again with the returned hotel_id.",
    };
  }

  const recent = recentChatHotel(scope);
  if (recent) return { ok: true, id: recent.id, name: recent.name, source: "rozmowa" };
  return {
    ok: false, status: "need_hotel",
    message: "No hotel was discussed in this conversation yet. Suggested reply: one plain question in Polish about which " +
      "hotel (name and city) the user means; then call booking_find_hotel.",
  };
}

// Ten hotel staje sie "ostatnim hotelem rozmowy" (i trafia do hoteli pokazanych).
export function rememberConversationHotel(scope: string, id: number, name: string | null): void {
  rememberChatHotel(scope, id, name);
  rememberExtraHotel(scope, id, name);
}

// Notatka dla agenta, gdy hotel ustalil serwer (zeby bylo widac, ktorego hotelu dotyczy odpowiedz).
export function hotelSourceNote(source: HotelSource, name: string | null): string | null {
  if (source === "agent") return null;
  const how = source === "pozycja" ? "the list number the user gave" : source === "nazwa"
    ? "the hotel name among hotels shown in this conversation" : "the hotel discussed last in this conversation";
  return "Hotel taken from " + how + (name ? " (" + name + ")" : "") + " - start the answer with the hotel name.";
}
