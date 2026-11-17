import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";

process.env.DATABASE_PATH = ":memory:";
process.env.SITE_MODE = "public";
process.env.ADMIN_TOKEN = "test-admin-security";
process.env.INGEST_TOKEN = "test-ingest-security";
process.env.ADMIN_HOSTS = "localhost,admin.example";
process.env.NODE_ENV = "development";
process.env.AUTH_DEV_MOCK = "true";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.TELEGRAM_PROXY = "";
process.env.PUBLIC_BASE_URL = "http://localhost";

const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { registerApi } = await import("../src/server/routes.ts");
const { ensureSources } = await import("../src/server/collectors/index.ts");
const { WindowLimiter, registerSecurity } = await import("../src/server/security.ts");
const { validateWebhookUrl, isPublicAddress, resolveWebhookTarget } = await import("../src/server/webhook.ts");
const { saveUserPushConfig, getUserPushConfig, flushUserBatches, previewUserPush, userPushStats } = await import("../src/server/user-push.ts");
const { normalizeSettings, DEFAULT_SETTINGS } = await import("../src/server/push.ts");
const { safeRegex, compileRule } = await import("../src/server/enrich/blocklist.ts");

const app = new Hono();
const cookies: string[] = [];
const userIds: number[] = [];
const admin = { authorization: "Bearer test-admin-security" };
const stamp = new Date().toISOString();
const sent: string[] = [];
const originalFetch = globalThis.fetch;

before(async () => {
  migrate(); ensureSources(); registerApi(app);
  run("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)", "access_control", JSON.stringify({ loginEnabled: true, registrationMode: "open" }), stamp);
  for (const preset of ["alice", "bob"]) {
    const response = await app.request("/api/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset }) });
    assert.equal(response.status, 200);
    cookies.push(response.headers.get("set-cookie")!.split(";")[0]!);
    userIds.push(((await response.json()) as { user: { id: number } }).user.id);
  }
  for (const [id, title] of [[1, "免费领取软件永久许可证"], [2, "免费领取域名"]] as const) {
    run(`INSERT INTO items(id,source_id,external_id,url,url_key,title,title_key,category,kind,score,is_free,obtain,status,content,summary,first_seen_at,last_seen_at,published_at)
         VALUES(?,'test',?,'https://example.com/'||?,'example.com/'||?,?,?,'software','freebie',95,1,'free','active',?,?, ?,?,?)`,
      id, String(id), id, id, title, `title-${id}`, "正文".repeat(10000), "简短摘要", stamp, stamp, stamp);
  }
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(String((JSON.parse(String(init?.body)) as { chat_id: string }).chat_id));
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = originalFetch; closeDb(); });

test("管理鉴权：普通登录不能提权，管理 Host 不能被公开 Host 绕过", async () => {
  assert.equal((await app.request("/api/admin/access")).status, 401);
  assert.equal((await app.request("/api/admin/access", { headers: { cookie: cookies[0]! } })).status, 401);
  assert.equal((await app.request("/api/admin/access", { headers: admin })).status, 200);
  assert.equal((await app.request("http://public.example/api/admin/access", { headers: admin })).status, 403);
  const check = await (await app.request("/api/auth/check")).json() as { isAdmin: boolean };
  assert.equal(check.isAdmin, false);
  assert.equal((await app.request("/api/admin/items/1/classification", {
    method: "PATCH", headers: { cookie: cookies[0]!, "content-type": "application/json" }, body: '{"category":"course","kind":"info"}',
  })).status, 401);
  assert.equal("manualClassification" in ((await (await app.request("/api/items/1", { headers: { cookie: cookies[0]! } })).json()) as Record<string, unknown>), false);
});

test("生产和未声明开发环境下，模拟登录及无密码管理均 fail closed", () => {
  for (const mode of ["production", ""]) {
    const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e",
      "const c=await import('./src/server/config.ts');console.log(JSON.stringify({mock:c.devMockEnabled,locked:c.adminLocked}))"],
    { cwd: process.cwd(), env: { ...process.env, NODE_ENV: mode, SITE_MODE: "selfhost", ADMIN_TOKEN: "", AUTH_DEV_MOCK: "true" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout.trim()) as { mock: boolean; locked: boolean };
    assert.equal(value.mock, false);
    assert.equal(value.locked, mode === "production");
  }
});

test("模拟登录仅接受回环 Host", async () => {
  assert.equal((await app.request("http://public.example/api/auth/dev-login", { method: "POST" })).status, 403);
});

test("auto 模式仅配置 GitHub OAuth 也启用公开站隔离", () => {
  const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", "console.log((await import('./src/server/config.ts')).siteMode)"], {
    cwd: process.cwd(), env: { ...process.env, SITE_MODE: "auto", LINUXDO_CLIENT_ID: "", LINUXDO_CLIENT_SECRET: "", GITHUB_CLIENT_ID: "github-test-id", GITHUB_CLIENT_SECRET: "github-test-secret" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "public");
});

test("Webhook：拦截特殊协议、凭据、IPv4/IPv6 内网及整数编码 IP", () => {
  for (const url of [
    "file:///etc/passwd", "http://user:pass@example.com", "http://localhost/",
    "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://169.254.169.254/",
    "http://10.0.0.1", "http://172.17.0.1", "http://192.168.1.1", "http://100.64.0.1",
    "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fc00::1]", "http://[fe80::1]", "https://example.com/#fragment",
  ]) assert.throws(() => validateWebhookUrl(url), Error, url);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:db8::1"), false);
  assert.equal(validateWebhookUrl("https://example.com/hook").hostname, "example.com");
});

test("Webhook：DNS 任一记录为内网都拒绝，合法结果用于 socket 固定地址", async () => {
  const privateDns = (async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup;
  await assert.rejects(resolveWebhookTarget(new URL("https://example.com"), privateDns), /内网/);
  const publicDns = (async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof lookup;
  assert.deepEqual(await resolveWebhookTarget(new URL("https://example.com"), publicDns), { address: "8.8.8.8", family: 4 });
});

test("Webhook 渠道无需 Bot 凭据，单独保存阈值不能把渠道重置成 Telegram", () => {
  const uid = userIds[0]!;
  const cfg = saveUserPushConfig(uid, { deliverVia: "webhook", webhookUrl: "https://example.com/hook", enabled: true });
  assert.equal(cfg.enabled, true); assert.equal(cfg.hasToken, false);
  assert.equal(saveUserPushConfig(uid, { instantScore: 40 }).settings.deliverVia, "webhook");
  assert.throws(() => saveUserPushConfig(uid, { webhookUrl: "http://127.0.0.1/hook" }), /内网/);
  saveUserPushConfig(uid, { enabled: false, deliverVia: "telegram" });
  assert.throws(() => saveUserPushConfig(uid, { enabled: true }), /凭据|Token/);
});

test("个人设置统一规范化：异常数组、数量与阈值不会污染推送链路", () => {
  const cfg = normalizeSettings({ routes: "bad" as never, sourceIds: "bad" as never, instantScore: 30, batchScore: 90 }, DEFAULT_SETTINGS);
  assert.deepEqual(cfg.routes, []); assert.deepEqual(cfg.sourceIds, []);
  assert.equal(cfg.batchScore, 30);
});

test("个人立即攒批仅冲刷当前用户；隐藏条目在出队时再次过滤", async () => {
  sent.length = 0;
  for (const uid of userIds) {
    saveUserPushConfig(uid, { enabled: true, deliverVia: "telegram", botToken: "123456789:AAAAAAAAAAAAAAAAAAAAAAAA", chatId: `chat-${uid}`, aiFallbackMode: "ignore_ai", batchScore: 0 });
    for (const itemId of [1, 2]) run("INSERT INTO user_push_deliveries(user_id,item_id,status,queued_at) VALUES(?,?,'queued',?)", uid, itemId, stamp);
  }
  run("INSERT INTO user_item_states(user_id,item_id,hidden,updated_at) VALUES(?,2,1,?)", userIds[0]!, stamp);
  const result = await app.request("/api/me/push/flush", { method: "POST", headers: { cookie: cookies[0]! } });
  assert.equal(result.status, 200);
  assert.deepEqual(sent, [`chat-${userIds[0]}`]);
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_deliveries WHERE user_id = ? AND status='queued'", userIds[1]!)?.n, 2);
  assert.equal(get<{ status: string }>("SELECT status FROM user_push_deliveries WHERE user_id = ? AND item_id = 2", userIds[0]!)?.status, "failed");
  await app.request("/api/me/push/flush", { method: "POST", headers: { cookie: cookies[0]! } });
  const limited = await app.request("/api/me/push/flush", { method: "POST", headers: { cookie: cookies[0]! } });
  assert.equal(limited.status, 429); assert.ok(limited.headers.get("retry-after"));
});

test("并发 flush 与定时 flush 不会重复投递同一用户", async () => {
  const uid = userIds[1]!;
  sent.length = 0;
  await Promise.all([flushUserBatches(true, uid), flushUserBatches(true, uid)]);
  assert.deepEqual(sent, [`chat-${uid}`]);
});

test("个人正则拒绝，管理员危险正则和遗留危险规则不会执行", async () => {
  assert.equal((await app.request("/api/me/block-rules", { method: "POST", headers: { cookie: cookies[0]!, "content-type": "application/json" }, body: '{"pattern":"(a+)+$","mode":"regex"}' })).status, 400);
  assert.equal(safeRegex("(a+)+$"), false); assert.equal(safeRegex("a+a+$"), false);
  assert.equal(safeRegex("^(请问|求助)"), true);
  const matcher = compileRule({ id: 1, pattern: "(a+)+$", mode: "regex", scope: "all", enabled: 1, created_at: stamp });
  assert.equal(matcher("a".repeat(10000) + "!", "test"), false);
});

test("公开来源脱敏，管理来源保留完整配置；私有响应禁止共享缓存", async () => {
  const publicResponse = await app.request("/api/sources");
  const sources = ((await publicResponse.json()) as { sources: Record<string, unknown>[] }).sources;
  assert.ok(sources.length);
  assert.deepEqual(sources[0]!.config, {});
  assert.equal("cursor" in sources[0]!, false); assert.equal("last_error" in sources[0]!, false);
  const privateResponse = await app.request("/api/sources", { headers: admin });
  assert.match(privateResponse.headers.get("cache-control")!, /private.*no-store/);
  assert.equal("cursor" in ((await privateResponse.json()) as { sources: Record<string, unknown>[] }).sources[0]!, true);
});

test("列表不携带正文，详情按需读取；缓存遇同连接写入立即失效", async () => {
  const path = "/api/items?merge=0&source=test";
  const first = await app.request(path);
  assert.match(first.headers.get("cache-control")!, /public/);
  const list = (await first.json()) as { items: { id: number; content?: string; starred: boolean }[] };
  assert.equal(list.items[0]!.content, undefined);
  assert.equal(list.items[0]!.starred, false);
  const detail = await app.request("/api/items/1");
  assert.equal(((await detail.json()) as { content: string }).content.length, 20000);
  run("UPDATE items SET title = '缓存应更新' WHERE id = 1");
  const fresh = await (await app.request(path)).json() as { items: { id: number; title: string }[] };
  assert.equal(fresh.items.find((item) => item.id === 1)!.title, "缓存应更新");
});

test("个人订阅影响自己的列表和详情，不读取站长订阅", async () => {
  run("INSERT INTO user_subscriptions(user_id,keyword,created_at) VALUES(?,?,?)", userIds[0]!, "缓存应更新", stamp);
  run("INSERT INTO subscriptions(keyword,created_at) VALUES('站长私有关键词',?)", stamp);
  const response = await app.request("/api/items?merge=0&subscribed=1", { headers: { cookie: cookies[0]! } });
  const items = ((await response.json()) as { items: { id: number; matched: string[] }[] }).items;
  assert.deepEqual(items.map((item) => item.id), [1]);
  assert.deepEqual(items[0]!.matched, ["缓存应更新"]);
});

test("已关闭视图的条目标识为 ignored，恢复操作不会反向隐藏", async () => {
  const response = await app.request("/api/items?status=ignored&merge=0", { headers: { cookie: cookies[0]! } });
  const items = ((await response.json()) as { items: { id: number; status: string }[] }).items;
  assert.equal(items.find((item) => item.id === 2)?.status, "ignored");
});

test("个人 RSS 私有缓存；安全头和跨站写保护生效", async () => {
  const token = get<{ rss_token: string }>("SELECT rss_token FROM users WHERE id = ?", userIds[0]!)!.rss_token;
  const response = await app.request(`/rss/u/${token}.xml`);
  assert.match(response.headers.get("cache-control")!, /private.*no-store/);
  assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await app.request("/api/auth/logout", { method: "POST", headers: { cookie: cookies[0]!, origin: "https://evil.example" } })).status, 403);
});

test("请求体、非法数值和查询长度有上限", async () => {
  assert.equal((await app.request("/api/items?limit=NaN")).status, 400);
  assert.equal((await app.request("/api/items/not-a-number")).status, 400);
  assert.equal((await app.request("/api/hot?hours=Infinity")).status, 400);
  assert.equal((await app.request("/api/items?search=" + "a".repeat(1001))).status, 400);
  const response = await app.request("/api/me/push", { method: "PATCH", headers: { cookie: cookies[0]!, "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) }) });
  assert.equal(response.status, 413);
});

test("限流桶：恢复时间正确，容量满不驱逐活跃桶", () => {
  const limiter = new WindowLimiter(1);
  assert.equal(limiter.take("one", 2, 60000, 0), 0);
  assert.equal(limiter.take("one", 2, 60000, 1), 0);
  assert.equal(limiter.take("one", 2, 60000, 2), 60);
  assert.equal(limiter.take("two", 2, 60000, 3), 60);
  assert.equal(limiter.take("one", 2, 60000, 60000), 0);
});

test("并发请求有全局预算", async () => {
  const gate = new Hono(); registerSecurity(gate);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  gate.get("/api/wait", async (c) => { await waiting; return c.json({ ok: true }); });
  const pending = Array.from({ length: 16 }, () => gate.request("/api/wait"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const rejected = await gate.request("/api/wait");
  assert.equal(rejected.status, 429);
  release(); await Promise.all(pending);
});

test("合并访客偏好包括屏蔽词，不会默默丢掉本地规则", async () => {
  const response = await app.request("/api/me/items/import-guest", { method: "POST", headers: { cookie: cookies[0]!, "content-type": "application/json" }, body: '{"blocked":["合并测试词"]}' });
  assert.equal(response.status, 200);
  assert.ok(get("SELECT id FROM user_block_rules WHERE user_id = ? AND pattern = ?", userIds[0]!, "合并测试词"));
});

test("搜索与屏蔽里的 % 和 _ 按字面匹配，不变成 SQL 通配符", async () => {
  run("UPDATE items SET summary = '优惠 10%_测试' WHERE id = 2");
  const response = await app.request("/api/items?merge=0&search=%25_");
  assert.deepEqual(((await response.json()) as { items: { id: number }[] }).items.map((i) => i.id), [2]);
  run("INSERT INTO user_block_rules(user_id,pattern,mode,scope,enabled,created_at) VALUES(?,'%', 'keyword','all',1,?)", userIds[1]!, stamp);
  const personal = await app.request("/api/items?merge=0&source=test", { headers: { cookie: cookies[1]! } });
  assert.deepEqual(((await personal.json()) as { items: { id: number }[] }).items.map((i) => i.id), [1]);
});

test("个人预览受每轮额度限制，已发送内容不再次显示为待推送", () => {
  const uid = userIds[0]!;
  for (const id of [3, 4]) run(
    `INSERT INTO items(id,source_id,external_id,url,url_key,title,title_key,category,kind,score,is_free,obtain,status,first_seen_at,last_seen_at,published_at)
     VALUES(?,'test',?,'https://example.com/'||?,'example.com/'||?,?,'preview'||?,'software','freebie',95,1,'free','active',?,?,?)`,
    id, `preview-${id}`, id, id, `免费领取 Preview ${id}`, id, stamp, stamp, stamp,
  );
  saveUserPushConfig(uid, { dedupeByTitle: false, instantScore: 0, batchScore: 0, maxPerInstant: 1, quietEnabled: false });
  const result = previewUserPush(uid);
  assert.equal(result.instantTotal, 2);
  assert.equal(result.sendableInstant, 1);
  assert.equal(result.batchTotal, 1);
  assert.equal(result.caps.maxPerInstant, 1);
  assert.equal(result.instant.length, 1);
});

test("个人日报也计入小时额度，不能绕过推送护栏", () => {
  const uid = userIds[0]!;
  const before = userPushStats(uid).sentLastHour;
  run("INSERT INTO user_push_logs(user_id,kind,item_ids,text,count,ok,created_at) VALUES(?,'daily','[]','',3,1,?)", uid, stamp);
  assert.equal(userPushStats(uid).sentLastHour, before + 3);
});
