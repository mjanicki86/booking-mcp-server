// Kontekst jednego zadania HTTP /mcp - dane z naglowkow konektora Copilot Studio.
//
// conversation-id (test 2026-10-29) ma postac "<id czatu Teams>_<guid>":
// - czesc przed ostatnim "_" to czat Teams z botem - stala w kolejnych turach
//   (ta sama wartosc rano i po poludniu 29.10),
// - guid po "_" zmienia sie z kazda tura (jedno wywolanie agenta MCP).
// W okienku testowym Copilot Studio przychodzi sam guid.
export interface RequestContext {
  /** Pelna wartosc naglowka conversation-id - jedno wywolanie agenta MCP (tura). */
  turnId: string | null;
  /** Czat (rozmowa) - czesc stala miedzy turami; przy samym guid rowna turnId. */
  chatId: string | null;
}

export function contextFromHeaders(headers: Record<string, unknown>): RequestContext {
  const raw = headers["conversation-id"];
  const turnId = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  if (!turnId) return { turnId: null, chatId: null };
  // 31.10: w narzedziu wpisano "System.Conversation.Id" jako tekst zamiast zmiennej -
  // wszystkie rozmowy dzielily pamiec (daty, "dalej", wybor miasta). Taka wartosc
  // to nie identyfikator rozmowy: pracujemy bez pamieci czatu i ostrzegamy w logu.
  if (/^=?\s*System\./i.test(turnId) || /\{|\}/.test(turnId)) {
    console.error("=== OSTRZEZENIE: conversation-id=\"" + turnId + "\" to tekst, a nie identyfikator rozmowy - " +
      "w narzedziu MCP w Copilot Studio ustaw wartosc jako ZMIENNA System.Conversation.Id. Pracuje bez pamieci czatu.");
    return { turnId: null, chatId: null };
  }
  const cut = turnId.lastIndexOf("_");
  const chatId = cut > 0 ? turnId.slice(0, cut) : turnId;
  return { turnId, chatId };
}
