import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Hono } from "hono";

Object.assign(process.env, { DATABASE_PATH: ":memory:", SITE_MODE: "selfhost", ADMIN_TOKEN: "", NODE_ENV: "development", RATE_LIMIT_ENABLED: "false", ENABLE_SCHEDULER: "false", PUSH_CHANNEL: "none", AI_BASE_URL: "", AI_MODEL: "" });
const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { ensureSources, ingestItems } = await import("../src/server/collectors/index.ts");
const { enrichItem } = await import("../src/server/enrich/index.ts");
const { resolveKind, guessKind } = await import("../src/server/enrich/kind.ts");
const { isNoiseTitle } = await import("../src/server/enrich/noise.ts");
const { registerApi } = await import("../src/server/routes.ts");
const { getSourceHints, reconcileSourceCategory } = await import("../src/server/source-settings.ts");
const { reclassifyStoredItems } = await import("../src/server/ai-admin.ts");
const { reviewFreshNow } = await import("../src/server/enrich/ai-queue.ts");
const { saveAiSettings } = await import("../src/server/enrich/ai-settings.ts");
const { saveClassificationSettings } = await import("../src/server/classification-settings.ts");
const { rssCollector } = await import("../src/server/collectors/rss.ts");
const { applyChannelQuery } = await import("../src/shared/channel-query.ts");
const { buildHotReport } = await import("../src/server/hot.ts");
const app = new Hono();
const now = new Date().toISOString();
const flight = "全美航班停飞4小时，普通旅客当天实际遇到了什么";
const originalFetch = globalThis.fetch;
before(() => { migrate(); ensureSources(); registerApi(app); });
after(() => { globalThis.fetch = originalFetch; closeDb(); });
const seed = (sourceId: string, externalId: string, title: string, category = "other", kind = "freebie") => {
  run(`INSERT INTO items(source_id,external_id,url,url_key,title,category,kind,score,base_score,is_free,obtain,ai_keep,status,published_at,first_seen_at,last_seen_at)
       VALUES(?,?,? ,?, ?,?,?,80,80,0,'free',1,'active',?,?,?)`, sourceId, externalId, `https://example.com/${externalId}`, `example.com/${externalId}`, title, category, kind, now, now, now);
  return get<{ id: number }>("SELECT id FROM items WHERE source_id=? AND external_id=?", sourceId, externalId)!.id;
};

test("新闻无促销证据：导购源、用途提示、错误 AI news/deal 都不能强制变成好价", () => {
  for (const sourceId of ["rss-smzdm", "rss-lowendtalk", "rss-ithome", "linuxdo-welfare"]) {
    assert.equal(guessKind({ title: flight, sourceId, kindHint: "deal" }), "info");
    assert.equal(resolveKind("news", true, { title: flight, sourceId }), "info");
    assert.equal(resolveKind("deal", true, { title: flight, sourceId, obtain: "paid", price: 500 }), "info");
  }
  assert.equal(resolveKind("deal", true, { title: flight, sourceId: "rss-chinanews-world" }), "news");
  assert.equal(guessKind({ title: "某公司财报收入 $500 亿", sourceId: "rss-smzdm", price: 500 }), "info");
  assert.equal(resolveKind("freebie", true, { title: "AI 额度到底够不够", sourceId: "rss-ithome" }), "info");
});

test("真实促销与福利不误杀，版本号本身不成为开源证据", () => {
  for (const title of ["航空公司限时特价机票，单程99元", "黑五 $10.99/年 KVM VPS", "ChatGPT Team 拼车 35元/月", "限时下单赠送礼包，年付79元"]) {
    assert.equal(resolveKind("deal", true, { title, sourceId: "rss-smzdm" }), "deal", title);
  }
  for (const title of ["移动领 1-9 元话费福利", "免费领取软件永久授权", "Knightica is Free via Epic Games Store", "GitHub 学生认证免费领开发者礼包"]) {
    assert.equal(resolveKind("freebie", true, { title, sourceId: "rss-ithome" }), "freebie", title);
  }
  assert.equal(resolveKind("opensource", true, { title: "新版客户端 v2.1.0 发布" }), "info");
  assert.equal(resolveKind("opensource", true, { title: "开源自托管 Docker 工具", sourceId: "linuxdo-welfare" }), "opensource");
  assert.equal(isNoiseTitle("如何免费领取学生开发者礼包：完整步骤教程"), false);
  assert.equal(isNoiseTitle("请问怎么免费领会员？"), true);
});

test("资源分享优先 pan，云服务/会员活动不因出现网盘词被全部强制归盘", () => {
  const shared = enrichItem({ externalId: "x", url: "https://example.com/shared", title: "Adobe 全套软件与电影合集", summary: "https://pan.quark.cn/s/abcdef 提取码 1234" }, "linuxdo-welfare")!;
  assert.equal(shared.category, "pan");
  const offer = enrichItem({ externalId: "y", url: "https://example.com/membership", title: "百度网盘会员免费领取一年" }, "linuxdo-welfare")!;
  assert.notEqual(offer.category, "pan");
  assert.equal(enrichItem({ externalId: "z", url: "https://example.com/topic", title: "ChatGPT 免费积分和软件授权" }, "linuxdo-resource")!.category, "pan");
});

test("管理端保存固定分类立即重整历史条目并保留收藏/隐藏", async () => {
  const itemId = seed("linuxdo-resource", "legacy-resource", "免费领取 AI 学习资料", "ai");
  run("UPDATE items SET starred=1,status='ignored',ai=? WHERE id=?", JSON.stringify({ keep: true, category: "ai", kind: "freebie" }), itemId);
  const response = await app.request("/api/sources/linuxdo-resource", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { categoryId: 14, fixedCategory: "pan" } }) });
  assert.equal(response.status, 200);
  assert.ok(((await response.json()) as { reclassified: number }).reclassified >= 1);
  const row = get<{ category: string; starred: number; status: string; ai: string }>("SELECT category,starred,status,ai FROM items WHERE id=?", itemId)!;
  assert.equal(row.category, "pan"); assert.equal(row.starred, 1); assert.equal(row.status, "ignored");
  assert.equal(JSON.parse(row.ai).category, "pan");
  assert.equal(reconcileSourceCategory("linuxdo-resource"), 0);
});

test("固定分类可在管理端解除，新条目恢复自动识别，不被默认规则重加", async () => {
  const response = await app.request("/api/sources/linuxdo-resource", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"config":{"categoryId":14,"fixedCategory":""}}' });
  assert.equal(response.status, 200);
  assert.equal(getSourceHints("linuxdo-resource").fixedCategory, "");
  assert.equal(enrichItem({ externalId: "override", url: "https://example.com/override", title: "Claude 大模型免费送额度" }, "linuxdo-resource", getSourceHints("linuxdo-resource"))!.category, "ai");
  ensureSources();
  assert.equal(getSourceHints("linuxdo-resource").fixedCategory, "");
  const bad = await app.request("/api/sources/linuxdo-resource", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"config":{"fixedCategory":"invalid-category"}}' });
  assert.equal(bad.status, 400);
});

test("固定分类在重采与 AI 审核后仍生效，AI 原判新闻也按证据纠正", async () => {
  run("UPDATE sources SET config=? WHERE id='linuxdo-resource'", '{"categoryId":14,"fixedCategory":"pan"}');
  ingestItems("linuxdo-resource", [{ externalId: "new-share", url: "https://example.com/new-share", title: "领取 AI 课程软件资料", publishedAt: now }]);
  const shareId = get<{ id: number }>("SELECT id FROM items WHERE external_id='new-share'")!.id;
  const flightId = seed("rss-smzdm", "flight-ai", flight, "world", "deal");
  const prompts: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push(body.messages[0]!.content);
    const payload = JSON.parse(body.messages[1]!.content) as { index: number; title: string }[];
    const verdicts = payload.map((p) => ({ index: p.index, keep: true, kind: p.title === flight ? "news" : "freebie", category: p.title === flight ? "world" : "ai", obtain: "free", quality: 4, reason: "模拟模型输出" }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdicts) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  saveAiSettings({ enabled: true, baseUrl: "https://example.invalid/v1", model: "fake-model", systemPrompt: "自定义审核提示词", aiDedupEnabled: false });
  try {
    await reviewFreshNow([{ itemId: shareId, sourceId: "linuxdo-resource", title: "领取 AI 课程软件资料", summary: "", url: "https://example.com/new-share" }, { itemId: flightId, sourceId: "rss-smzdm", title: flight, summary: "", url: "https://example.com/flight-ai" }]);
    assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id=?", shareId)!.category, "pan");
    assert.equal(get<{ kind: string }>("SELECT kind FROM items WHERE id=?", flightId)!.kind, "info");
    assert.ok(prompts.every((prompt) => prompt.includes("全美航班停飞") && prompt.includes("必须有可参与")));
  } finally { saveAiSettings({ enabled: false }); globalThis.fetch = originalFetch; }
  ingestItems("linuxdo-resource", [{ externalId: "new-share", url: "https://example.com/new-share", title: "领取 软件授权与 AI 资料", publishedAt: now }]);
  assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id=?", shareId)!.category, "pan");
});

test("固定真福利 RSS 与 API 同口径，指定来源不能绕过频道隔离", async () => {
  const id = seed("linuxdo-resource", "rss-pan", "网盘课程测试", "pan");
  run("UPDATE items SET ai_keep=1,obtain='free' WHERE id=?", id);
  const offerId = seed("linuxdo-welfare", "rss-good", "测试免费领取软件授权", "software");
  assert.ok(offerId);
  const feed = await app.request("/rss.xml?preset=verified&source=linuxdo-resource");
  assert.equal(feed.status, 200); assert.ok(!(await feed.text()).includes("网盘课程测试"));
  const panFeed = await app.request("/rss.xml?preset=pan&source=linuxdo-resource");
  assert.ok((await panFeed.text()).includes("网盘课程测试"));
  const api = await (await app.request("/api/items?preset=verified&source=linuxdo-resource&merge=0")).json() as { items: unknown[] };
  assert.equal(api.items.length, 0);
  assert.equal(applyChannelQuery({ preset: "verified", kind: "", obtain: "" }).kind, "");
});

test("RSS 多地址各用自身分类提示；包含/排除原站栏目与标题排除词先过滤后取配额", async () => {
  const xml = `<rss><channel>
  <item><title>免费求助广告</title><link>https://example.com/excluded</link><category>info</category></item>
  <item><title>一般讨论</title><link>https://example.com/discussion</link><category>discussion</category></item>
  <item><title>资源一本</title><link>https://example.com/kept</link><category>info</category></item></channel></rss>`;
  const result = await rssCollector.collect({ sourceId: "rss-test", config: { feeds: [
    { id: "pan", url: "https://example.com/pan.xml", limit: 1, categoryHint: "pan", includeCategories: ["info"], excludeTitleKeywords: ["广告"], excludeCategories: ["discussion"] },
    { id: "course", url: "https://example.com/course.xml", limit: 1, categoryHint: "course", kindHint: "info", includeCategories: ["info"], excludeTitleKeywords: ["广告"] },
  ] }, cursor: null, maxItems: 10, log: () => {}, http: { text: async () => ({ status: 200, body: xml }) } as never });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((i) => i.categoryHint), ["pan", "course"]);
  assert.equal(result.items[1]!.kindHint, "info");
  assert.ok(result.items.every((i) => i.url.includes("kept")));
  const wrong = await app.request("/api/sources/rss-nodeseek", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"config":{"feeds":[{"url":"https://example.com/feed","excludeTitleKeywords":"not-an-array"}]}}' });
  assert.equal(wrong.status, 400);
});

test("分类检查 dry-run 不写库，管理端可试算/开关/修复误分且不发送任何消息", async () => {
  const id = seed("rss-smzdm", "flight-legacy", flight, "world", "deal");
  run("UPDATE items SET ai=? WHERE id=?", JSON.stringify({ kind: "deal", category: "world", keep: true }), id);
  const audit = reclassifyStoredItems("all", { dryRun: true, sourceId: "rss-smzdm" });
  assert.ok(audit.samples.some((s) => s.id === id && s.toKind === "info"));
  assert.equal(get<{ kind: string }>("SELECT kind FROM items WHERE id=?", id)!.kind, "deal");
  const preview = await app.request("/api/admin/classification/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: flight, sourceId: "rss-smzdm", aiKind: "deal" }) });
  assert.equal(preview.status, 200);
  assert.equal(((await preview.json()) as { finalKind: string }).finalKind, "info");
  const setting = await app.request("/api/admin/classification", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"guardEnabled":false}' });
  assert.equal(setting.status, 200); assert.equal(getSourceHints("rss-smzdm").guardEnabled, false);
  saveClassificationSettings(true);
  const repair = await app.request("/api/admin/classification/reclassify", { method: "POST", headers: { "content-type": "application/json" }, body: '{"sourceId":"rss-smzdm"}' });
  assert.equal(repair.status, 200);
  assert.equal(get<{ kind: string }>("SELECT kind FROM items WHERE id=?", id)!.kind, "info");
  assert.equal(JSON.parse(get<{ ai: string }>("SELECT ai FROM items WHERE id=?", id)!.ai).classificationCorrection.previousKind, "deal");
});

test("旧库迁移为资源荟萃补固定分类，不覆盖显式取消选项", () => {
  run("UPDATE sources SET config=? WHERE id='linuxdo-resource'", '{"categoryId":14}');
  run("UPDATE items SET category='media' WHERE source_id='linuxdo-resource'");
  run("PRAGMA user_version = 29"); migrate();
  assert.equal(getSourceHints("linuxdo-resource").fixedCategory, "pan");
  assert.equal(get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source_id='linuxdo-resource' AND category IS NOT 'pan'")!.n, 0);
  run("UPDATE sources SET config=? WHERE id='linuxdo-resource'", '{"categoryId":14,"fixedCategory":""}');
  run("UPDATE items SET category='ai' WHERE source_id='linuxdo-resource'");
  run("PRAGMA user_version = 29"); migrate();
  assert.equal(getSourceHints("linuxdo-resource").fixedCategory, "");
  assert.ok(get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source_id='linuxdo-resource' AND category='ai'")!.n > 0);
});

test("管理员手动改分类/形态优先于源固定；重采、重整和直接更新不能覆盖", async () => {
  run("UPDATE sources SET config=? WHERE id='linuxdo-resource'", '{"categoryId":14,"fixedCategory":"pan"}');
  const id = seed("linuxdo-resource", "manual-item", "免费领取软件授权", "pan", "freebie");
  run("UPDATE items SET starred=1 WHERE id=?", id);
  const change = await app.request(`/api/admin/items/${id}/classification`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: '{"category":"software","kind":"info","note":"这条是软件信息，非网盘"}',
  });
  assert.equal(change.status, 200);
  const manual = get<{ category: string; kind: string }>("SELECT category,kind FROM item_classification_overrides WHERE item_id=?", id)!;
  assert.deepEqual({ ...manual }, { category: "software", kind: "info" });
  ingestItems("linuxdo-resource", [{ externalId: "manual-item", url: "https://example.com/manual-item", title: "免费领取软件授权", publishedAt: now }]);
  reconcileSourceCategory("linuxdo-resource");
  reclassifyStoredItems("all");
  run("UPDATE items SET category='pan',kind='freebie' WHERE id=?", id);
  const row = get<{ category: string; kind: string; starred: number }>("SELECT category,kind,starred FROM items WHERE id=?", id)!;
  assert.deepEqual({ ...row }, { category: "software", kind: "info", starred: 1 });
  const detail = await (await app.request(`/api/items/${id}`)).json() as { manualClassification: { note: string } };
  assert.equal(detail.manualClassification.note, "这条是软件信息，非网盘");
  const audit = reclassifyStoredItems("all", { dryRun: true });
  assert.ok(!audit.samples.some((sample) => sample.id === id));
});

test("恢复自动分类解除人工锁定，遵守当前源固定规则；只改分类不强制改形态", async () => {
  const id = get<{ id: number }>("SELECT id FROM items WHERE external_id='manual-item'")!.id;
  const reset = await app.request(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"clear":true}' });
  assert.equal(reset.status, 200);
  assert.equal(get("SELECT 1 FROM item_classification_overrides WHERE item_id=?", id), undefined);
  assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id=?", id)!.category, "pan");
  const change = await app.request(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"category":"course","kind":null}' });
  assert.equal(change.status, 200);
  assert.equal(get<{ category: string; kind: string }>("SELECT category,kind FROM items WHERE id=?", id)!.category, "course");
  assert.equal(get<{ kind: string }>("SELECT kind FROM item_classification_overrides WHERE item_id=?", id)!.kind, null);
  const invalid = await app.request(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"category":"not-a-category","kind":"info"}' });
  assert.equal(invalid.status, 400);
});

test("人工分类在 AI 重审时保持，恢复自动能使用最新 AI 结论且不取消 AI 拒绝", async () => {
  const id = seed("linuxdo-welfare", "manual-ai", "免费领取游戏礼包", "game", "freebie");
  await app.request(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"category":"software","kind":"info"}' });
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"index":0,"keep":true,"kind":"freebie","category":"game","quality":4,"obtain":"free","reason":"游戏礼包"}]' } }] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  saveAiSettings({ enabled: true, baseUrl: "https://example.invalid/v1", model: "fake", aiDedupEnabled: false });
  try {
    const result = await reviewFreshNow([{ itemId: id, sourceId: "linuxdo-welfare", title: "免费领取游戏礼包", summary: "", url: "https://example.com/manual-ai" }]);
    assert.equal(result.get(id)!.kind, "info");
    assert.equal(result.get(id)!.category, "software");
    const stored = get<{ category: string; kind: string; ai: string }>("SELECT category,kind,ai FROM items WHERE id=?", id)!;
    assert.equal(stored.kind, "info"); assert.equal(JSON.parse(stored.ai).category, "game");
    await app.request(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"clear":true}' });
    assert.equal(get<{ kind: string; category: string }>("SELECT kind,category FROM items WHERE id=?", id)!.kind, "freebie");
    assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id=?", id)!.category, "game");
  } finally { saveAiSettings({ enabled: false }); globalThis.fetch = originalFetch; }
  run("UPDATE items SET ai_keep=0,kind='noise' WHERE id=?", id);
  await app.request(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"category":"course","kind":"info"}' });
  assert.equal(get<{ ai_keep: number }>("SELECT ai_keep FROM items WHERE id=?", id)!.ai_keep, 0);
});

test("人工移动后热点缓存与 RSS ETag 立即更新", async () => {
  const id = seed("linuxdo-welfare", "manual-cache", "免费领取缓存测试许可证", "software", "freebie");
  const before = buildHotReport(24);
  const feed = await app.request("/rss.xml?source=linuxdo-welfare");
  const etag = feed.headers.get("etag");
  await app.request(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"category":"course","kind":"info"}' });
  const after = buildHotReport(24);
  assert.notEqual(before, after);
  assert.ok(!after.top.some((item) => item.id === id));
  const updated = await app.request("/rss.xml?source=linuxdo-welfare", { headers: { "if-none-match": etag! } });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.headers.get("etag"), etag);
});
