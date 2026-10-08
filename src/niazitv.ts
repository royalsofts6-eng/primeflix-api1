/**
 * NiaziTV scraper — Turkish dramas with Urdu subtitles.
 *
 * Source: https://play.niazitv.pk (server-rendered HTML, no JS needed)
 *
 * Endpoints:
 *   GET /all-series                          -> drama catalog (27 series)
 *   GET /drama/{serieId}/single-serie        -> episode list
 *   GET /drama/{serieId}/single-serie?watch=1&episode={episodeId}
 *                                            -> JSON-LD contentUrl (.m3u8)
 *
 * CRITICAL (C2): contentUrl MUST be validated against the CDN allowlist.
 * Promo/trailer placeholders (e.g. video.twimg.com) are NEVER returned
 * as playable streams.
 *
 * Caching:
 *   series list : 24h (+ 7d stale)
 *   episodes    : 6h  (+ 1d stale)
 *   stream URLs : NO cache (signed/expiring)
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
// Only NiaziTV CDN hosts are playable. Everything else (twitter promos,
// third-party embeds) is rejected.
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
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`NiaziTV HTTP ${res.status}`);
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
  thumbnail: string;
  lang: "urdu" | "english" | "unknown";
}

export interface NiaziStream {
  url: string;
  referer: string;
  title: string;
}

// ── 1. Series list ──────────────────────────────────────────────────────────
const RE_SERIES = new RegExp(
  '<img src="([^"]+)" alt="([^"]+)"[^>]*>.*?' +
    '<a class="uk-position-cover" href="https://play\\.niazitv\\.pk/all-seasons\\?serie=(\\d+)"></a>.*?' +
    "<h5[^>]*>\\s*([^<]+?)</h5>\\s*.*?<p[^>]*>\\s*Total Seasons:\\s*(\\d+)\\s*</p>",
  "gs"
);

export async function getSeries(): Promise<NiaziSeries[]> {
  const cacheKey = "niazi:series";
  const cached = cacheGet<NiaziSeries[]>(cacheKey);
  if (cached && !cached.stale) return cached.value;

  try {
    const html = await fetchPage(`${BASE}/all-series`);
    const out: NiaziSeries[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(RE_SERIES)) {
      const id = m[3];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: m[4].trim(),
        image: absUrl(m[1]),
        seasons: parseInt(m[5], 10) || 1,
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
const RE_EPISODE = new RegExp(
  '<img src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>.*?' +
    'href="single-serie\\?watch=1&amp;episode=(\\d+)"',
  "gs"
);

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
    const html = await fetchPage(`${BASE}/drama/${serieId}/single-serie`);
    const out: NiaziEpisode[] = [];
    const seen = new Set<string>();
    for (const m of html.matchAll(RE_EPISODE)) {
      const id = m[3];
      const title = (m[2] || "").trim();
      // Skip logo/nav artifacts
      if (/logo/i.test(title) && /whitelogo/i.test(m[1])) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title,
        thumbnail: absUrl(m[1]),
        lang: detectLang(title),
      });
    }
    if (out.length === 0) throw new Error("no episodes parsed (site structure changed?)");
    cacheSet(cacheKey, out, NIAZI_TTL.episodes, NIAZI_TTL.staleEpisodes);
    return out;
  } catch (e) {
    if (cached) return cached.value; // stale fallback
    throw e;
  }
}

// ── 3. Stream URL ───────────────────────────────────────────────────────────
const RE_JSONLD = /<script type="application\/ld\+json">(.*?)<\/script>/gs;
const RE_CONTENTURL = /"contentUrl"\s*:\s*"([^"]+\.m3u8[^"]*)"/i;

function extractContentUrl(html: string): { url: string; title: string } | null {
  // Primary: JSON-LD VideoObject
  for (const m of html.matchAll(RE_JSONLD)) {
    try {
      const data = JSON.parse(m[1]);
      const nodes = Array.isArray(data)
        ? data
        : data["@graph"]
          ? data["@graph"]
          : [data];
      for (const n of nodes) {
        if (n && typeof n === "object" && n["@type"] === "VideoObject" && typeof n["contentUrl"] === "string") {
          return { url: n["contentUrl"], title: String(n["name"] || "") };
        }
      }
    } catch {
      /* malformed block, try next */
    }
  }
  // Fallback: regex
  const f = html.match(RE_CONTENTURL);
  if (f) return { url: f[1], title: "" };
  return null;
}

export async function getStreamUrl(serieId: string, episodeId: string): Promise<NiaziStream> {
  serieId = numId(serieId, "serieId");
  episodeId = numId(episodeId, "episodeId");

  // NOTE: stream URLs are signed/time-limited — NEVER cache.
  const pageUrl = `${BASE}/drama/${serieId}/single-serie?watch=1&episode=${episodeId}`;
  const html = await fetchPage(pageUrl);
  const found = extractContentUrl(html);
  if (!found) throw new Error("no stream URL found on episode page");

  // CRITICAL C2: allowlist validation — reject promo/trailer URLs
  if (!isAllowedStreamUrl(found.url)) {
    throw new Error(
      `stream URL rejected by allowlist (host not a NiaziTV CDN): ${found.url.slice(0, 80)}`
    );
  }

  return {
    url: found.url,
    referer: pageUrl, // CDN requires Referer header on playlist + segments
    title: found.title,
  };
}
