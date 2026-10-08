/**
 * PrimeFlix API — Cluster 1 (Vercel)
 * Uniform contract: { success: true, data } | { success: false, error, code }
 */
import { Hono } from "hono";
import { apiKeyAuth } from "./auth.js";
import { tmdb, TTL, edgeCacheHeaders } from "./tmdb.js";
import { resolveStream, providerHealth } from "./chain.js";
import { cacheStats } from "./cache.js";

export const app = new Hono();

const VERSION = "1.0.0";
const CLUSTER = process.env.CLUSTER_NAME || "api1";

// ── Global middleware ───────────────────────────────────────────────────────
app.use("*", apiKeyAuth);

// ── Helpers ─────────────────────────────────────────────────────────────────
type Handler = (c: any) => Promise<Response>;

function ok(data: unknown, cacheTtlMs?: number, cacheStaleMs?: number): (c: any) => Response {
  return (c: any) => {
    const headers: Record<string, string> = {};
    if (cacheTtlMs && cacheStaleMs) Object.assign(headers, edgeCacheHeaders(cacheTtlMs, cacheStaleMs));
    return c.json({ success: true, data }, 200, headers);
  };
}

function wrap(fn: Handler): Handler {
  return async (c: any) => {
    try {
      return await fn(c);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes("TMDB rate limited") ? 429 : msg.includes("all providers") ? 502 : 500;
      return c.json({ success: false, error: msg, code: status === 429 ? "TMDB_RATE_LIMIT" : "UPSTREAM_ERROR" }, status);
    }
  };
}

const num = (v: string | undefined, d: number): number => {
  const n = parseInt(v || "", 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// ── Public ──────────────────────────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    name: "PrimeFlix API",
    cluster: CLUSTER,
    version: VERSION,
    endpoints: [
      "GET /health",
      "GET /v1/tmdb/trending/movie?time_window=day",
      "GET /v1/tmdb/trending/tv?time_window=day",
      "GET /v1/tmdb/movie/:id",
      "GET /v1/tmdb/tv/:id",
      "GET /v1/tmdb/tv/:id/season/:season",
      "GET /v1/tmdb/search/multi?query=&page=",
      "GET /v1/tmdb/movie/:id/recommendations",
      "GET /v1/tmdb/tv/:id/recommendations",
      "GET /v1/stream/movie/:tmdbId",
      "GET /v1/stream/tv/:tmdbId/:season/:episode",
    ],
  })
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    cluster: CLUSTER,
    version: VERSION,
    tmdbKeyConfigured: !!process.env.TMDB_API_KEY,
    providers: providerHealth(),
    cache: cacheStats(),
  })
);

// ── TMDB proxy ──────────────────────────────────────────────────────────────
app.get("/v1/tmdb/trending/movie", wrap(async (c) => {
  const data = await tmdb.trendingMovie(c.req.query("time_window") || "day");
  return ok(data, TTL.trending, TTL.stale7d)(c);
}));

app.get("/v1/tmdb/trending/tv", wrap(async (c) => {
  const data = await tmdb.trendingTv(c.req.query("time_window") || "day");
  return ok(data, TTL.trending, TTL.stale7d)(c);
}));

app.get("/v1/tmdb/movie/:id", wrap(async (c) => {
  const data = await tmdb.movie(c.req.param("id"));
  return ok(data, TTL.details, TTL.stale7d)(c);
}));

app.get("/v1/tmdb/tv/:id", wrap(async (c) => {
  const data = await tmdb.tv(c.req.param("id"));
  return ok(data, TTL.details, TTL.stale7d)(c);
}));

app.get("/v1/tmdb/tv/:id/season/:season", wrap(async (c) => {
  const data = await tmdb.tvSeason(c.req.param("id"), num(c.req.param("season"), 1));
  return ok(data, TTL.details, TTL.stale7d)(c);
}));

app.get("/v1/tmdb/search/multi", wrap(async (c) => {
  const q = c.req.query("query") || "";
  if (q.length < 2) return c.json({ success: false, error: "query too short", code: "BAD_QUERY" }, 400);
  const data = await tmdb.search(q, c.req.query("page") || "1");
  return ok(data, TTL.search, TTL.stale1d)(c);
}));

app.get("/v1/tmdb/movie/:id/recommendations", wrap(async (c) => {
  const data = await tmdb.movieRecs(c.req.param("id"));
  return ok(data, TTL.details, TTL.stale7d)(c);
}));

app.get("/v1/tmdb/tv/:id/recommendations", wrap(async (c) => {
  const data = await tmdb.tvRecs(c.req.param("id"));
  return ok(data, TTL.details, TTL.stale7d)(c);
}));

// ── Stream resolution ───────────────────────────────────────────────────────
// NOTE: stream URLs are signed/time-limited — NEVER cache these responses.
app.get("/v1/stream/movie/:tmdbId", wrap(async (c) => {
  const data = await resolveStream(c.req.param("tmdbId"), "movie");
  return c.json({ success: true, data }, 200, { "Cache-Control": "no-store" });
}));

app.get("/v1/stream/tv/:tmdbId/:season/:episode", wrap(async (c) => {
  const data = await resolveStream(
    c.req.param("tmdbId"),
    "tv",
    num(c.req.param("season"), 1),
    num(c.req.param("episode"), 1)
  );
  return c.json({ success: true, data }, 200, { "Cache-Control": "no-store" });
}));

// ── 404 ─────────────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ success: false, error: "not found", code: "NOT_FOUND" }, 404));
