// === PARKING ZE STRONY HOTELU (09.11, pomiar na 22 hotelach z listy z 02.11) ===
// Zwykle pobranie strony (bez przegladarki): strona glowna + do 3 podstron, ktore wygladaja na
// parking / dojazd / kontakt / FAQ. Szukamy zdan o parkingu w PL, EN, DE, CZ/SK, LV.
// Tylko na pytanie o parking jednego hotelu, wynik pamietany 7 dni.

const UA = "Mozilla/5.0 (compatible; WecoHotelAssistant/1.0; +https://www.wecotravel.pl)";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUBPAGES = 3;

const PARKING_RE = /parking|\bparken\b|parkowanie|parkování|parkplatz|parkpl[aä]tze|parkhaus|tiefgarage|gara[zż]|garage|gar[aá][zž]|parkovi[sš]t|parkovisk|parkovan|st[aā]vviet|autost[aā]v|car\s*park|valet/i;
const LINK_RE = /parking|parken|anfahrt|dojazd|lokalizac|lokacja|location|kontakt|contact|getting[-\s]?here|how[-\s]?to[-\s]?get|directions|arrival|anreise|faq|gara[zž]|doprava|jak\s+dojecha|udogodnien|amenit|services|uslugi|us[lł]ugi|ausstattung/i;
const EXTRA = {
  height: /wysoko[sś][cć]|height|clearance|h[oö]he|durchfahrtsh|v[yý][sš]k|max\.?\s*\d[.,]\d{1,2}\s*m\b/i,
  ev: /[lł]adowa|ładowark|charging|charger|ladestation|e-?auto|wallbox|nab[ií]jec|elektromobil|uzl[aā]des/i,
  lpg: /\blpg\b|autogas|gaz\s+p[lł]ynny/i,
  price: /\d+[.,]?\d*\s*(z[lł]|pln|eur|€|czk|kč)|(eur|€|pln)\s*\d+/i,
  bus: /\bbus|autokar|reisebus|minibus/i,
};

export interface WebsiteParking {
  url: string;
  fetched: boolean;
  status: number | null;
  error?: string;
  text_chars: number;
  js_only: boolean;
  pages_checked: string[];
  parking_snippets: string[];
  found: { height: boolean; ev: boolean; lpg: boolean; price: boolean; bus: boolean };
}

const cache = new Map<string, { at: number; value: WebsiteParking }>();

async function getHtml(url: string): Promise<{ status: number; html: string; finalUrl: string }> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "pl,en;q=0.8,de;q=0.6" },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const type = r.headers.get("content-type") ?? "";
  const html = /html|xml|text/i.test(type) ? (await r.text()).slice(0, 2_000_000) : "";
  return { status: r.status, html, finalUrl: r.url || url };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template|nav)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article|dd|dt|a|header|button)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&euro;/g, "€")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function candidateLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const baseHost = (() => { try { return new URL(base).host.replace(/^www\./, ""); } catch { return ""; } })();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, " ");
    if (!LINK_RE.test(href) && !LINK_RE.test(label)) continue;
    try {
      const u = new URL(href, base);
      if (!/^https?:$/.test(u.protocol) || u.host.replace(/^www\./, "") !== baseHost) continue;
      if (/\.(pdf|jpe?g|png|gif|webp|zip|docx?)$/i.test(u.pathname)) continue;
      const s = u.toString();
      if (!out.includes(s) && s !== base) out.push(s);
    } catch { /* zly link */ }
  }
  // najpierw linki wprost o parkingu/dojezdzie
  out.sort((a, b) => Number(!/park|gara|anfahrt|dojazd|getting|directions|arrival/i.test(a)) -
    Number(!/park|gara|anfahrt|dojazd|getting|directions|arrival/i.test(b)));
  return out.slice(0, MAX_SUBPAGES);
}

function parkingSnippets(text: string): string[] {
  const out: string[] = [];
  // podzial na linie (akapity, punkty listy); dlugie akapity przycina limit dlugosci fragmentu
  const lines = text.split(/\n/);
  let i = 0;
  while (i < lines.length && out.length < 8) {
    if (!PARKING_RE.test(lines[i])) { i++; continue; }
    // linia z parkingiem + kolejne linie, dopoki dotycza parkingu (cena, wysokosc, EV, busy stoja
    // czesto pod naglowkiem "Parken"/"Parking"); krotki naglowek bierze do 3 kolejnych linii
    const parts = [lines[i].trim()];
    const isHeader = lines[i].trim().length < 40;
    let j = i + 1;
    while (j < lines.length && j <= i + 4 && parts.join(" ").length < 400) {
      const next = lines[j].trim();
      const related = PARKING_RE.test(next) || EXTRA.height.test(next) || EXTRA.ev.test(next) ||
        EXTRA.lpg.test(next) || EXTRA.price.test(next) || EXTRA.bus.test(next);
      if (!related && !(isHeader && j <= i + 3)) break;
      if (next) parts.push(next);
      j++;
    }
    const s = parts.join(" ").replace(/\s+/g, " ").trim();
    if (s.length >= 15) {
      const cut = s.length > 450 ? s.slice(0, 450) + "…" : s;
      if (!out.includes(cut)) out.push(cut);
    }
    i = j;
  }
  return out;
}

export async function parkingFromWebsite(website: string): Promise<WebsiteParking> {
  const hit = cache.get(website);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res: WebsiteParking = {
    url: website, fetched: false, status: null, text_chars: 0, js_only: false, pages_checked: [],
    parking_snippets: [], found: { height: false, ev: false, lpg: false, price: false, bus: false },
  };
  const started = Date.now();
  try {
    const home = await getHtml(website);
    res.status = home.status;
    res.pages_checked.push(home.finalUrl);
    if (home.status >= 400 || !home.html) {
      res.error = "strona glowna: HTTP " + home.status;
    } else {
      res.fetched = true;
      const homeText = htmlToText(home.html);
      res.text_chars = homeText.length;
      res.js_only = homeText.length < 500;
      const snippets = parkingSnippets(homeText);
      for (const link of candidateLinks(home.html, home.finalUrl)) {
        try {
          const sub = await getHtml(link);
          res.pages_checked.push(link + (sub.status >= 400 ? " (HTTP " + sub.status + ")" : ""));
          if (sub.status < 400 && sub.html) {
            for (const s of parkingSnippets(htmlToText(sub.html))) if (!snippets.includes(s)) snippets.push(s);
          }
        } catch (e) {
          res.pages_checked.push(link + " (blad: " + (e instanceof Error ? e.message : String(e)).slice(0, 60) + ")");
        }
      }
      res.parking_snippets = snippets.slice(0, 8);
      const all = snippets.join(" ");
      res.found = {
        height: EXTRA.height.test(all), ev: EXTRA.ev.test(all), lpg: EXTRA.lpg.test(all),
        price: EXTRA.price.test(all), bus: EXTRA.bus.test(all),
      };
    }
  } catch (err) {
    res.error = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
  }
  console.error("=== Strona hotelu: " + website + " -> " + (res.fetched ? res.parking_snippets.length + " zdan o parkingu, " +
    res.pages_checked.length + " stron" : "nie pobrano (" + res.error + ")") + ", " + (Date.now() - started) + " ms");
  cache.set(website, { at: Date.now(), value: res });
  return res;
}
