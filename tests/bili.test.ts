import assert from "node:assert/strict";
import type { HttpClient } from "../src/server/http.ts";
import { after, before, test } from "node:test";

process.env.DATABASE_PATH = ":memory:";

const { migrate, closeDb } = await import("../src/server/db.ts");
const { biliCollector, __biliInternals } = await import("../src/server/collectors/bili.ts");

before(() => {
  migrate();
});

after(() => {
  closeDb();
});

/** 构造一个假的 HttpClient：nav 返回固定 wbi keys，其余按 url 分派 */
function fakeHttp(handler: (url: string) => { code: number; data?: unknown } | null) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      raw: async () => {
        throw new Error("unused");
      },
      text: async () => {
        throw new Error("unused");
      },
      json: async (url: string) => {
        calls.push(url);
        if (url.includes("/x/web-interface/nav")) {
          return {
            status: 200,
            url,
            data: {
              code: 0,
              data: {
                wbi_img: {
                  img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
                  sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
                },
              },
            },
          };
        }
        const payload = handler(url);
        if (!payload) throw new Error("unexpected url " + url);
        return { status: 200, url, data: payload };
      },
    } as unknown as HttpClient,
  };
}

const VIDEO = (over: Record<string, unknown>) => ({
  type: "video",
  bvid: "BV1xx411c7mD",
  aid: 111,
  arcurl: "http://www.bilibili.com/video/BV1xx411c7mD",
  title: '<em class="keyword">免费</em>领取喜加一',
  description: "原价78 现已转为免费",
  pic: "//i0.hdslb.com/bfs/archive/abc.jpg",
  play: 5000,
  pubdate: 1_790_000_000,
  author: "某UP",
  typename: "单机游戏",
  tag: "喜加一",
  ...over,
});

test("wbi 签名：参数按字母序拼接并附 32 位 md5 w_rid", () => {
  const qs = __biliInternals.signQuery({ search_type: "video", keyword: "免费领取", page: 1 }, "abcdefghijklmnopqrstuvwxyz012345");
  assert.match(qs, /^keyword=%E5%85%8D%E8%B4%B9%E9%A2%86%E5%8F%96&page=1&search_type=video&wts=\d+&w_rid=[0-9a-f]{32}$/);
});

test("条目映射：清理 <em> 高亮、http→https、// 图片补协议", () => {
  const raw = __biliInternals.toRawItem(VIDEO({}), "免费领取");
  assert.ok(raw);
  assert.equal(raw.title, "免费领取喜加一");
  assert.equal(raw.url, "https://www.bilibili.com/video/BV1xx411c7mD");
  assert.equal(raw.externalId, "BV1xx411c7mD");
  assert.equal(raw.imageUrl, "https://i0.hdslb.com/bfs/archive/abc.jpg");
  assert.equal(raw.author, "某UP");
  assert.equal(raw.publishedAt, new Date(1_790_000_000 * 1000).toISOString());
  assert.deepEqual(raw.tags, ["bilibili", "免费领取"]);
});

test("关键词过滤 + 排除词：只留命中福利词且不含排除词的条目", async () => {
  __biliInternals.resetKeyCache();
  const { client } = fakeHttp(() => ({
    code: 0,
    data: {
      result: [
        VIDEO({ bvid: "BVkeep1", title: "限时免费领取喜加一" }),
        VIDEO({ bvid: "BVdrop1", title: "【4K超清】橘里夫人 全12集" }),
        VIDEO({ bvid: "BVdrop2", title: "免费领取合集（录播）" }),
      ],
    },
  }));

  const res = await biliCollector.collect({
    sourceId: "bili-freebies",
    config: { keywords: ["免费领取"], limitPerKeyword: 20 },
    cursor: null,
    maxItems: 50,
    http: client,
    log: () => {},
  });

  const ids = res.items.map((i) => i.externalId);
  assert.deepEqual(ids, ["BVkeep1"]);
});

test("相似合并：跨 UP 的高度相似标题只留播放最高的一条，同一 UP 的系列视频都保留", async () => {
  __biliInternals.resetKeyCache();
  const { client } = fakeHttp(() => ({
    code: 0,
    data: {
      result: [
        VIDEO({ bvid: "BVa", author: "甲", play: 100, title: "BLG夺冠！B站免费送所有人大会员：今日中午12点起登录B站，免费领取" }),
        VIDEO({ bvid: "BVb", author: "乙", play: 900, title: "BLG夺冠, B站宣布:免费送所有人大会员!今日中午12点起登录B站,搜索大会员" }),
        VIDEO({ bvid: "BVc", author: "丙", play: 200, title: "大的来了【免费白嫖1511】喜加二十！限时免费领取！Steam" }),
        VIDEO({ bvid: "BVd", author: "丙", play: 300, title: "大的来了【免费白嫖1474】喜加二十五！限时免费领取！Steam" }),
      ],
    },
  }));

  const res = await biliCollector.collect({
    sourceId: "bili-freebies",
    config: { keywords: ["免费领取"] },
    cursor: null,
    maxItems: 50,
    http: client,
    log: () => {},
  });

  const ids = res.items.map((i) => i.externalId).sort();
  assert.deepEqual(ids, ["BVb", "BVc", "BVd"], "跨 UP 重复合并掉 BVа，同 UP 的周报都保留");
});

test("wbi 失效时降级到 legacy 搜索", async () => {
  __biliInternals.resetKeyCache();
  const { client, calls } = fakeHttp((url) => {
    if (url.includes("/wbi/search/type")) return { code: -352, message: "风控校验失败" };
    if (url.includes("/search/all/v2")) {
      return {
        code: 0,
        data: {
          result: [
            { result_type: "video", data: [VIDEO({ bvid: "BVlegacy", title: "白嫖领取限时免费" })] },
            { result_type: "media_bangumi", data: [] },
          ],
        },
      };
    }
    return null;
  });

  const res = await biliCollector.collect({
    sourceId: "bili-freebies",
    config: { keywords: ["白嫖"] },
    cursor: null,
    maxItems: 50,
    http: client,
    log: () => {},
  });

  assert.ok(calls.some((u) => u.includes("/search/all/v2")));
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0]?.externalId, "BVlegacy");
  assert.match(String(res.degraded), /-352/);
});

test("未配置 keywords 时明确报错", async () => {
  const { client } = fakeHttp(() => null);
  await assert.rejects(
    () =>
      biliCollector.collect({
        sourceId: "bili-freebies",
        config: { keywords: [] },
        cursor: null,
        maxItems: 50,
        http: client,
        log: () => {},
      }),
    /未配置 keywords/,
  );
});