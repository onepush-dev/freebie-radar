// Synthetic, in-memory, in-process benchmark: never imports the live server or touches production data.
import { createHash } from "node:crypto";
process.env.DATABASE_PATH = ":memory:";
process.env.SITE_MODE = "public";
process.env.ENABLE_SCHEDULER = "false";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.AUTH_DEV_MOCK = "false";
const { Hono } = await import("hono");
const { migrate, getDb, closeDb } = await import("../src/server/db.ts");
const { registerApi } = await import("../src/server/routes.ts");
migrate();
const db = getDb();
const insert = db.prepare(`INSERT INTO items(source_id,external_id,url,url_key,title,title_key,summary,content,category,kind,status,score,ai_keep,obtain,is_free,published_at,first_seen_at,last_seen_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,'active',80,1,'free',1,?,?,?)`);
db.exec("BEGIN");
const now = Date.now();
for (let i = 0; i < 10_000; i += 1) {
  const hash = createHash("sha256").update(String(i)).digest("hex").slice(0, 16);
  const at = new Date(now - i * 90_000).toISOString();
  insert.run("synthetic-source", String(i), "https://example.com/" + i, "example.com/" + i, "免费领取 " + hash, hash,
    "合成测试 summary " + hash, "content ".repeat(256), ["game", "software", "cloud", "goods", "other"][i % 5], ["freebie", "info", "news"][i % 3], at, at, at);
}
db.exec("COMMIT");
const app = new Hono(); registerApi(app);
for (const path of ["/api/items?limit=40", "/api/items?limit=200&merge=0", "/api/items?search=不存在的关键字", "/api/stats", "/api/hot?hours=168", "/rss.xml?limit=100"]) {
  const times = []; let bytes = 0;
  for (let i = 0; i < 6; i += 1) {
    const start = performance.now();
    const response = await app.request(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    bytes = (await response.arrayBuffer()).byteLength;
    times.push(performance.now() - start);
  }
  const warm = times.slice(1).sort((a, b) => a - b);
  console.log(JSON.stringify({ path, coldMs: +times[0].toFixed(1), warmMedianMs: +warm[2].toFixed(1), uncompressedBytes: bytes }));
}
closeDb();
console.log("10,000 synthetic rows; memory DB; serial in-process requests; not a production QPS estimate.");
