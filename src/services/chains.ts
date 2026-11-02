// === SIECI I MARKI HOTELI (02.11, zgloszenie Emilii: "hotele Marriott kolo NEC" -
// agent sam wybral z listy po nazwach i dorzucil Novotel (Accor)) ===
// /accommodations/chains (test 02.11): 1071 sieci, bez stronicowania,
// {id, name, brands: [{id, name}]}. Kazdy hotel w /details ma "brands": [id].
// Lista pobierana raz na 24 h.
import { config } from "../config.js";
import { normalizeText } from "./textNormalize.js";

interface BrandInfo { brandId: number; brandName: string; chainId: number; chainName: string }

const TTL_MS = 24 * 60 * 60 * 1000;
interface ChainCache { at: number; byBrand: Map<number, BrandInfo>; chains: { id: number; name: string; brands: { id: number; name: string }[] }[] }
let cache: ChainCache | null = null;
let inFlight: Promise<ChainCache | null> | null = null;

async function loadChains(): Promise<ChainCache | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const started = Date.now();
      const r = await fetch(config.bookingApiBaseUrl + "/accommodations/chains", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Affiliate-Id": config.bookingAffiliateId,
          "Authorization": "Bearer " + config.bookingApiKey,
        },
        body: "{}",
        signal: AbortSignal.timeout(20000),
      });
      const j: any = await r.json();
      const chains = (Array.isArray(j?.data) ? j.data : [])
        .filter((c: any) => typeof c?.id === "number" && typeof c?.name === "string")
        .map((c: any) => ({
          id: c.id,
          name: c.name,
          brands: (Array.isArray(c.brands) ? c.brands : []).filter((b: any) => typeof b?.id === "number" && typeof b?.name === "string"),
        }));
      const byBrand = new Map<number, BrandInfo>();
      for (const c of chains) {
        for (const b of c.brands) byBrand.set(b.id, { brandId: b.id, brandName: b.name, chainId: c.id, chainName: c.name });
      }
      console.error("=== Sieci hotelowe: " + chains.length + " sieci, " + byBrand.size + " marek, " + (Date.now() - started) + " ms");
      if (chains.length > 0) cache = { at: Date.now(), byBrand, chains };
      return cache;
    } catch (err) {
      console.error("=== Sieci hotelowe: blad pobierania (pomijam): " + (err instanceof Error ? err.message : String(err)));
      return cache;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// "Moxy Hotels (Marriott)" dla listy marek hotelu (pierwsza znana marka).
export async function brandLabel(brandIds: unknown): Promise<string | null> {
  if (!Array.isArray(brandIds) || brandIds.length === 0) return null;
  const c = await loadChains();
  if (!c) return null;
  for (const id of brandIds) {
    const b = typeof id === "number" ? c.byBrand.get(id) : undefined;
    if (b) return normalizeText(b.brandName) === normalizeText(b.chainName) ? b.chainName : b.brandName + " (" + b.chainName + ")";
  }
  return null;
}

// Zbior ID marek dla nazwy sieci lub marki podanej przez usera.
// 1) dokladna nazwa sieci ("Marriott" -> wszystkie marki sieci Marriott, bez "Marriott Orange County"),
// 2) dokladna nazwa marki, 3) sieci i marki zawierajace podana nazwe ("ibis" -> ibis, ibis Styles, ibis Budget).
export async function brandIdsForChain(query: string): Promise<{ ids: Set<number>; label: string } | null> {
  const c = await loadChains();
  if (!c) return null;
  const q = normalizeText(query).replace(/\s+(hotels?|group|hotel group)$/, "").trim();
  if (q.length < 2) return null;
  const exactChain = c.chains.find((ch) => normalizeText(ch.name) === q);
  if (exactChain) {
    return { ids: new Set(exactChain.brands.map((b) => b.id)), label: "sieć " + exactChain.name };
  }
  const ids = new Set<number>();
  const names: string[] = [];
  for (const ch of c.chains) {
    for (const b of ch.brands) {
      if (normalizeText(b.name) === q) { ids.add(b.id); names.push(b.name); }
    }
  }
  if (ids.size > 0) return { ids, label: "marka " + names.join(", ") };
  const re = new RegExp("(^|[^a-z0-9])" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)");
  for (const ch of c.chains) {
    if (re.test(normalizeText(ch.name))) { for (const b of ch.brands) ids.add(b.id); names.push(ch.name); continue; }
    for (const b of ch.brands) {
      if (re.test(normalizeText(b.name))) { ids.add(b.id); names.push(b.name); }
    }
  }
  return ids.size > 0 ? { ids, label: names.slice(0, 6).join(", ") } : null;
}
