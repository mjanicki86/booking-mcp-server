// Niektore filtry tresci (Azure OpenAI Content Safety / warstwa
// orkiestracji nad modelem) reaguja czuliej na bardzo dlugie,
// nieprzetworzone bloki tekstu (np. surowe opisy hoteli z API, ktore moga
// zawierac marketingowy jezyk zle sklasyfikowany w pewnych kontekstach)
// oraz na zagniezdzone cudzyslowy/nadmiarowe biale znaki w duzych blokach
// JSON. Ograniczenie dlugosci i normalizacja znakow zmniejsza ryzyko
// falszywego trafienia filtra (obserwowany blad "ContentFiltered" u
// Emilii przy zwyklym wyszukiwaniu hoteli), nie tracac istotnej tresci.
export function sanitizeForOrchestrator(text: string, maxLength = 800): string {
  let cleaned = text
    .replace(/["""]/g, "'")
    .replace(/\s{3,}/g, " ");
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength) + "...";
  }
  return cleaned;
}