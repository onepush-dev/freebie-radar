import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HttpClient } from "../src/server/http.ts";

process.env.DATABASE_PATH = ":memory:";

const { migrate, closeDb } = await import("../src/server/db.ts");
const { weiboCollector, __weiboInternals } = await import("../src/server/collectors/weibo.ts");
const { updateCookieSettings } = await import("../src/server/cookie-store.ts");

before(() => {
  migrate();
  updateCookieSettings({ cookies: { weibo: "SUB=_2A25test; SUBP=abc; SCF=xyz" } });
});

after(() => {
  closeDb();
});

const STATUS = (over: Record<string, unknown>) => ({
  mid: "5365614474429292",
  mblogid: "RrwVNiAgc",
  text_raw: "免费领取B站7天大会员，今日12点起登录即可",
  created_at: "Sun Nov 15 20:27:21 +0800 2026",
  user: { idstr: "9118021757", screen_name: "羊毛博主" },
  pic_ids: ["008lpf4ugy1ij35fu6srzj31jk2bc4n3"],
  attitudes_count: 64,
  reposts_count: 1,
  comments_count: 11,
  ...over,
});

function fakeHttp(handler: (url: string) => unknown) {
  const calls: string[] = [];
  const client = {
    raw: async () => {
      throw new Error("unused");
    },
    text: async () => {
      throw new Error("unused");
    },
    json: async (url: string) => {
      calls.push(url);
      return { status: 200, url, data: handler(url) };
    },
  } as unknown as HttpClient;
  return { client, calls };
}

test("条目映射：mid 作 id、正文首句作标题、图片走 wx1 大图", () => {
  const raw = __weiboInternals.toRawItem(STATUS({}));
  assert.ok(raw);
  assert.equal(raw.externalId, "5365614474429292");
  assert.equal(raw.url, "https://weibo.com/9118021757/RrwVNiAgc");
  assert.equal(raw.title, "免费领取B站7天大会员");
  assert.equal(raw.author, "羊毛博主");
  assert.equal(raw.imageUrl, "https://wx1.sinaimg.cn/large/008lpf4ugy1ij35fu6srzj31jk2bc4n3.jpg");
  assert.equal(raw.publishedAt, "2026-11-15T12:27:21.000Z");
  assert.deepEqual(raw.tags, ["weibo"]);
});

test("标题兜底：无句读时截断正文，过短时回退全文", () => {
  assert.equal(__weiboInternals.titleOf("免费领会员啦这里有链接"), "免费领会员啦这里有链接");
  assert.equal(__weiboInternals.titleOf("长".repeat(200)).length, 100);
});

test("关键词搜索：白名单命中 + 营销模板与擦边内容被排除", async () => {
  const { client } = fakeHttp(() => ({
    ok: 1,
    total_number: 100,
    statuses: [
      STATUS({}),
      STATUS({ mid: "1", text_raw: "#SVIP体验卡免费领# 我已成功领取3天SVIP体验卡，快来点击卡片领取" }),
      STATUS({ mid: "2", text_raw: "No.11131 花样抹胸裙 [137P] ￥10 获取原图，可加" }),
      STATUS({ mid: "3", text_raw: "今天天气不错，出门散步" }),
    ],
  }));

  const res = await weiboCollector.collect({
    sourceId: "weibo-freebies",
    config: { keywords: ["免费领取"] },
    cursor: null,
    maxItems: 50,
    http: client,
    log: () => {},
  });

  assert.deepEqual(res.items.map((i) => i.externalId), ["5365614474429292"]);
});

test("同文案合并：多个号转发同一段话只留互动最高的一条", async () => {
  const { client } = fakeHttp(() => ({
    ok: 1,
    statuses: [
      STATUS({ mid: "a", attitudes_count: 5, text_raw: "免费领取奶茶券，白嫖一杯" }),
      STATUS({ mid: "b", attitudes_count: 900, text_raw: "免费领取奶茶券，白嫖一杯" }),
      STATUS({ mid: "c", attitudes_count: 50, text_raw: "免费领取咖啡券，白嫖一杯" }),
    ],
  }));

  const res = await weiboCollector.collect({
    sourceId: "weibo-freebies",
    config: { keywords: ["免费领取"] },
    cursor: null,
    maxItems: 50,
    http: client,
    log: () => {},
  });

  assert.deepEqual(res.items.map((i) => i.externalId), ["b", "c"]);
});

test("盯人模式：uid 走 mymblog，无数据时记降级原因", async () => {
  const { client, calls } = fakeHttp((url) => {
    if (url.includes("uid=9118021757")) return { ok: 1, data: { list: [STATUS({})] } };
    return { ok: 1, data: { list: [] } };
  });

  const res = await weiboCollector.collect({
    sourceId: "weibo-freebies",
    config: { uids: ["9118021757", "000"] },
    cursor: null,
    maxItems: 50,
    http: client,
    log: () => {},
  });

  assert.ok(calls.some((u) => u.includes("/ajax/statuses/mymblog?uid=9118021757")));
  assert.equal(res.items.length, 1);
  assert.match(String(res.degraded), /uid=000/);
});

test("未配置 Cookie / 未配置关键词时明确报错", async () => {
  const { client } = fakeHttp(() => ({ ok: 1, statuses: [] }));
  await assert.rejects(
    () =>
      weiboCollector.collect({
        sourceId: "weibo-freebies",
        config: { keywords: [], uids: [] },
        cursor: null,
        maxItems: 50,
        http: client,
        log: () => {},
      }),
    /未配置 keywords 或 uids/,
  );

  updateCookieSettings({ cookies: { weibo: "" } });
  const { cookieHeader } = __weiboInternals;
  assert.throws(() => cookieHeader(), /未配置微博 Cookie/);
  updateCookieSettings({ cookies: { weibo: "SUB=_2A25test; SUBP=abc" } });
});