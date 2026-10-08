/**
 * NiaziTV scraper — Turkish dramas with Urdu subtitles.
 *
 * Source: https://play.niazitv.pk (server-rendered HTML, no JS needed)
 *
 * Flow (verified 2026-10-08):
 *   GET /all-series                  -> drama cards (all-seasons?serie={id})
 *   GET /all-seasons?serie={id}      -> season cards (/drama/{dramaId}/{slug})
 *   GET /drama/{dramaId}/{slug}      -> episode links (single-serie?watch=1&episode={id})
 *   GET /drama/{dramaId}/single-serie?watch=1&episode={id}
 *                                    -> .m3u8 URL in HTML
 *
 * CRITICAL (C2): stream URLs MUST be validated against the CDN allowlist.
 * Promo/trailer placeholders are NEVER returned as playable streams.
 *
 * Caching:
 *   series list : 24h (+ 7d stale)
 *   episodes    : 6h  (+ 1d stale)
 *   stream URLs : NO cache (signed/expiring)
 *
 * NOTE: All regexes are deliberately simple (no .*? spanning) to avoid
 * catastrophic backtracking on large HTML within Vercel's 10s limit.
 */
import { cacheGet, cacheSet } from "./cache.js";

const BASE = "https://play.niazitv.pk";
const UA =
  "Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const H = 3600_000;
const D = 24 * H;

export const NIAZI_TTL = {
  series: 24 * H,
  episodes: 6 * H,
  staleSeries: 7 * D,
  staleEpisodes: 1 * D,
};

// ── Allowlist (CRITICAL C2) ─────────────────────────────────────────────────
const ALLOWED_SUFFIXES = ["niazitv.pk", "urduflix.pk"];

export function isAllowedStreamUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

// ── Input validation (SSRF protection) ──────────────────────────────────────
function numId(v: string, name: string): string {
  if (!/^\d{1,10}$/.test(v)) throw new Error(`invalid ${name}`);
  return v;
}

function absUrl(u: string): string {
  return u.startsWith("http") ? u : BASE + (u.startsWith("/") ? u : "/" + u);
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(7000), // must stay under Vercel 10s limit
  });
  if (!res.ok) throw new Error(`niazitv HTTP ${res.status}`);
  return res.text();
}

// ── Types ───────────────────────────────────────────────────────────────────
export interface NiaziSeries {
  id: string;
  title: string;
  image: string;
  seasons: number;
}

export interface NiaziEpisode {
  id: string;
  title: string;
  image: string;
  lang: "urdu" | "english" | "unknown";
}

export interface NiaziStream {
  url: string;
  referer: string;
  title: string;
}

// ── 1. Series list ──────────────────────────────────────────────────────────
// Card: <div class="uk-width-1-2 ...uk-margin-bottom"> ... img, a[href*=all-seasons?serie=], h5 title, p "Total Seasons: N"
export async function getSeries(): Promise<NiaziSeries[]> {
  const cacheKey = "niazi:series";
  const cached = cacheGet<NiaziSeries[]>(cacheKey);
  if (cached && !cached.stale) return cached.value;

  try {
    const html = await fetchPage(`${BASE}/all-series`);
    const out: NiaziSeries[] = [];
    const seen = new Set<string>();

    // Split into cards first — safe, no backtracking
    const cards = html.split('<div class="uk-width-1-2');
    for (const card of cards) {
      const idM = card.match(/all-seasons\?serie=(\d+)/);
      if (!idM) continue;
      const id = idM[1];
      if (seen.has(id)) continue;

      const imgM = card.match(/<img src="([^"]+)" alt="([^"]*)"/);
      const titleM = card.match(/<h5[^>]*>\s*([^<]+?)\s*<\/h5>/);
      const seasonsM = card.match(/Total Seasons:\s*(\d+)/);
      if (!titleM) continue;

      seen.add(id);
      out.push({
        id,
        title: titleM[1].trim(),
        image: imgM ? absUrl(imgM[1]) : "",
        seasons: seasonsM ? parseInt(seasonsM[1], 10) : 1,
      });
    }

    if (out.length === 0) throw new Error("no series parsed (site structure changed?)");
    cacheSet(cacheKey, out, NIAZI_TTL.series, NIAZI_TTL.staleSeries);
    return out;
  } catch (e) {
    if (cached) return cached.value; // stale fallback
    throw e;
  }
}

// ── 2. Episode list ─────────────────────────────────────────────────────────
// Step A: /all-seasons?serie={id} -> season drama URLs (/drama/{dramaId}/{slug})
// Step B: each drama page -> episode blocks (single-serie?watch=1&episode={id})
function detectLang(title: string): NiaziEpisode["lang"] {
  const t = title.toLowerCase();
  if (t.includes("urdu")) return "urdu";
  if (t.includes("english")) return "english";
  return "unknown";
}

export async function getEpisodes(serieId: string): Promise<NiaziEpisode[]> {
  serieId = numId(serieId, "serieId");
  const cacheKey = `niazi:episodes:${serieId}`;
  const cached = cacheGet<NiaziEpisode[]>(cacheKey);
  if (cached && !cached.stale) return cached.value;

  try {
    // Step A: get season drama URLs
    const seasonsHtml = await fetchPage(`${BASE}/all-seasons?serie=${serieId}`);
    const dramaUrls = new Set<string>();
    const reDrama = /href="(https:\/\/play\.niazitv\.pk\/drama\/\d+\/[^"]+)"/g;
    let dm: RegExpExecArray | null;
    while ((dm = reDrama.exec(seasonsHtml)) !== null) {
      dramaUrls.add(dm[1]);
      if (dramaUrls.size >= 20) break; // sanity cap
    }
    if (dramaUrls.size === 0) throw new Error("no seasons found");

    // Step B: fetch drama pages in parallel, extract episodes
    const out: NiaziEpisode[] = [];
    const seen = new Set<string>();
    const dramaList = [...dramaUrls];
    const pages = await Promise.all(
      dramaList.map((u) =>
        fetchPage(u).catch(() => null)
      )
    );
    for (let pi = 0; pi < pages.length; pi++) {
      const html = pages[pi];
      if (!html) continue;
      const dramaUrl = dramaList[pi];
      // Split into episode blocks — safe, no backtracking
      const blocks = html.split("uk-position-cover");
      for (const block of blocks) {
        const epM = block.match(/href="single-serie\?watch=1&amp;episode=(\d+)"/);
        if (!epM || seen.has(epM[1])) continue;
        const imgM = block.match(/<img src="([^"]+)"[^>]*alt="([^"]*)"/);
        seen.add(epM[1]);
        // Remember which drama page this episode belongs to (for stream URL)
        cacheSet(`niazi:epdrama:${epM[1]}`, dramaUrl, NIAZI_TTL.episodes, NIAZI_TTL.staleEpisodes);
        out.push({
          id: epM[1],
          title: imgM ? imgM[2].trim() || `Episode ${epM[1]}` : `Episode ${epM[1]}`,
          image: imgM ? absUrl(imgM[1]) : "",
          lang: detectLang(imgM ? imgM[2] : ""),
        });
      }
    }

    if (out.length === 0) throw new Error("no episodes parsed");
    cacheSet(cacheKey, out, NIAZI_TTL.episodes, NIAZI_TTL.staleEpisodes);
    return out;
  } catch (e) {
    if (cached) return cached.value;
    throw e;
  }
}

// ── 3. Stream URL ───────────────────────────────────────────────────────────
// The .m3u8 is embedded directly in the watch page HTML.
export async function getStreamUrl(
  serieId: string,
  episodeId: string
): Promise<NiaziStream> {
  serieId = numId(serieId, "serieId");
  episodeId = numId(episodeId, "episodeId");

  // Resolve the drama page URL for this episode (stored during getEpisodes).
  // Watch URL format: /drama/{dramaId}/single-serie?watch=1&episode={id}
  let dramaUrl = cacheGet<string>(`niazi:epdrama:${episodeId}`)?.value;
  if (!dramaUrl) {
    // Not in cache — warm it via getEpisodes, then retry lookup
    await getEpisodes(serieId);
    dramaUrl = cacheGet<string>(`niazi:epdrama:${episodeId}`)?.value;
  }
  if (!dramaUrl) throw new Error("episode not found");

  const dramaIdM = dramaUrl.match(/\/drama\/(\d+)/);
  if (!dramaIdM) throw new Error("invalid drama URL");
  const pageUrl = `${BASE}/drama/${dramaIdM[1]}/single-serie?watch=1&episode=${episodeId}`;
  const html = await fetchPage(pageUrl);

  // Find all .m3u8 URLs, prefer allowlisted CDN hosts
  const urls = new Set<string>();
  const reM3u8 = /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/g;
  let um: RegExpExecArray | null;
  while ((um = reM3u8.exec(html)) !== null) {
    // Unescape common HTML entities
    const u = um[0].replace(/&amp;/g, "&");
    if (isAllowedStreamUrl(u)) urls.add(u);
  }

  const url = [...urls][0];
  if (!url) throw new Error("no playable stream found (allowlist rejected all)");

  return { url, referer: pageUrl, title: `Episode ${episodeId}` };
}
