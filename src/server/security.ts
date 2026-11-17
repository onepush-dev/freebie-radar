import type { Context, Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { isIP } from "node:net";
import { config } from "./config.ts";
import { dbRevision } from "./db.ts";

export function adminHostAllowed(c: Context): boolean {
  return !config.adminHosts.length || config.adminHosts.includes(new URL(c.req.url).host.toLowerCase());
}

export class WindowLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  private maxKeys: number;
  constructor(maxKeys = 10_000) { this.maxKeys = maxKeys; }
  take(key: string, limit: number, windowMs: number, now = Date.now()): number {
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (!entry && this.entries.size >= this.maxKeys) {
        for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
        // Fail closed instead of evicting active buckets and letting an attacker reset them.
        if (this.entries.size >= this.maxKeys) return Math.ceil(windowMs / 1000);
      }
      entry = { count: 0, until: now + windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= limit) return Math.max(1, Math.ceil((entry.until - now) / 1000));
    entry.count += 1;
    return 0;
  }
}

const limiter = new WindowLimiter();
export function clientAddress(c: Context): string {
  if (config.trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  try { return getConnInfo(c).remote.address ?? "unknown"; } catch { return "unknown"; }
}

export function limitUserAction(c: Context, userId: number, action: string, limit = 2, windowMs = 60_000): Response | null {
  const wait = limiter.take(`user:${userId}:${action}`, limit, windowMs);
  if (!wait) return null;
  c.header("Retry-After", String(wait));
  return c.json({ error: `操作过于频繁，请 ${wait} 秒后重试`, retryAfter: wait }, 429);
}

const installed = new WeakSet<Hono>();
export function registerSecurity(app: Hono): void {
  if (installed.has(app)) return;
  installed.add(app);
  app.use("*", secureHeaders({
    referrerPolicy: "no-referrer",
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "http://127.0.0.1:18789", ...(process.env.NODE_ENV === "production" ? [] : ["ws:", "http://localhost:5173", "http://127.0.0.1:5173"])],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  }));
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith("/api/") && !path.startsWith("/rss") && path !== "/health") return next();
    c.header("Cache-Control", "private, no-store");
    const writing = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (writing) {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      const allowed = new Set([new URL(c.req.url).origin]);
      if (config.publicBaseUrl) {
        try { allowed.add(new URL(config.publicBaseUrl).origin); } catch { /* invalid configuration */ }
      }
      if (process.env.NODE_ENV !== "production") {
        allowed.add("http://localhost:5173");
        allowed.add("http://127.0.0.1:5173");
      }
      if ((origin && !allowed.has(origin)) || (!origin && site === "cross-site")) {
        return c.json({ error: "不允许跨站写操作" }, 403);
      }
    }
    const query = c.req.query();
    if (c.req.url.length > 8192 || Object.values(query).some((v) => v.length > 1000)) {
      return c.json({ error: "查询参数过长" }, 400);
    }
    for (const name of ["limit", "offset", "hours", "maxAgeDays", "minScore", "maxPrice"]) {
      const value = query[name];
      if (value !== undefined && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1_000_000)) {
        return c.json({ error: `${name} 必须是有效的非负数` }, 400);
      }
    }
    const itemId = path.match(/^\/api\/(?:items|me\/items)\/([^/]+)/)?.[1];
    if (itemId && !["batch", "import-guest"].includes(itemId) && (!/^\d+$/.test(itemId) || !Number.isSafeInteger(Number(itemId)) || Number(itemId) < 1)) {
      return c.json({ error: "条目 ID 无效" }, 400);
    }
    if (config.rateLimitEnabled && path !== "/health") {
      const ip = clientAddress(c);
      const expensive = ["/api/export", "/api/hot", "/api/stats"].includes(path) || Boolean(query.search) || path.endsWith("/related") || path.endsWith("/preview") || path.endsWith("/block-rules");
      const auth = path.startsWith("/api/auth/") && path !== "/api/auth/me";
      const bucket = writing ? "write" : auth ? "auth" : expensive ? "expensive" : "read";
      const max = writing ? 60 : auth ? 30 : expensive ? 30 : 240;
      const wait = limiter.take(`${ip}:${bucket}`, max, 60_000);
      if (wait) {
        c.header("Retry-After", String(wait));
        return c.json({ error: "请求过于频繁，请稍后重试", retryAfter: wait }, 429);
      }
    }
    return next();
  });
  let inFlight = 0;
  app.use("/api/*", async (c, next) => {
    if (inFlight >= 16) { c.header("Retry-After", "5"); return c.json({ error: "服务繁忙，请稍后重试" }, 429); }
    inFlight += 1;
    try { await next(); } finally { inFlight -= 1; }
  });
  // Admission happens before buffering, so slow uploads cannot allocate unbounded bodies.
  app.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "请求体超过 2 MB 上限" }, 413) }));
}

/** Anonymous JSON only. Never share cookie/Bearer responses; bound both keys and bytes. */
export function registerPublicCache(app: Hono): void {
  const cache = new Map<string, { body: string; until: number }>();
  let revision = "";
  let bytes = 0;
  const paths = new Set(["/api/items", "/api/stats", "/api/sources", "/api/taxonomy", "/api/source-quality"]);
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" || !paths.has(c.req.path) || c.req.header("cookie") || c.req.header("authorization")) return next();
    const current = dbRevision();
    if (current !== revision) { cache.clear(); bytes = 0; revision = current; }
    const url = new URL(c.req.url);
    url.searchParams.sort();
    const key = url.pathname + url.search;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now() && !c.req.header("cache-control")?.includes("no-cache")) return c.body(hit.body, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=10", Vary: "Cookie, Authorization" });
    await next();
    if (c.res.status !== 200 || !c.res.headers.get("content-type")?.includes("application/json")) return;
    const body = await c.res.clone().text();
    const size = Buffer.byteLength(body);
    if (size > 512_000) return;
    if (cache.size >= 128 || bytes + size > 4_000_000) { cache.clear(); bytes = 0; }
    const previous = cache.get(key);
    if (previous) bytes -= Buffer.byteLength(previous.body);
    cache.set(key, { body, until: Date.now() + 10_000 });
    bytes += size;
    c.header("Cache-Control", "public, max-age=10");
    c.header("Vary", "Cookie, Authorization");
  });
}
