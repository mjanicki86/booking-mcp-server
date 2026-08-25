// Wspolna, poprawiona normalizacja tekstu - zastepuje 3 zdublowane,
// niepelne kopie tej samej funkcji w findHotel.ts, landmarkResolver.ts
// i cityResolver.ts.
//
// Znaki typu ø, å, æ, ł NIE rozkladaja sie kanonicznie w Unicode NFD
// (nie sa zapisane jako "litera bazowa + znak diakrytyczny", tylko jako
// odrebne, samodzielne litery alfabetu) - dlatego samo .normalize("NFD")
// ich nie rusza. To byl realny powod, dla ktorego wyszukiwanie hotelu w
// miescie "Brønnøysund" nie pasowalo do wpisanego przez uzytkownika
// "Bronnoysund".
const SPECIAL_CHAR_MAP: Record<string, string> = {
  "ø": "o",
  "å": "a",
  "æ": "ae",
  "ł": "l",
  "đ": "d",
  "ß": "ss",
  "ð": "d",
  "þ": "th",
};

export function normalizeText(text: string): string {
  let result = text.toLowerCase().trim();
  for (const [special, plain] of Object.entries(SPECIAL_CHAR_MAP)) {
    result = result.split(special).join(plain);
  }
  return result.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}