import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DATABASE_PATH = ":memory:";

const { migrate, closeDb } = await import("../src/server/db.ts");
const { ngaCollector, __ngaInternals } = await import("../src/server/collectors/nga.ts");
const { updateCookieSettings, parseCookieInput, hasCookieConfiguredForSource } = await import("../src/server/cookie-store.ts");
const { createHttp } = await import("../src/server/http.ts");

before(() => {
  migrate();
});

after(() => {
  closeDb();
});

const SAMPLE_HTML = `
<table>
  <a href="/read.php?tid=48123456" id="t_48123456" class="topic">中国移动免费领 9 元话费券</a>
  <a href="/read.php?tid=48123457&page=2" class="topic">京东 PLUS 免费领，数量有限</a>
  <a href="/read.php?tid=48123458" class="reply">回复</a>
  <a href="/read.php?tid=48123456" class="topic">中国移动免费领 9 元话费券</a>
</table>`;

test("NGA HTML 主通道：按 /read.php?tid= 锚点取帖子并去重、剔除操作链接", () => {
  const items = __ngaInternals.parseHtml(SAMPLE_HTML);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.externalId, "48123456");
  assert.equal(items[0]?.title, "中国移动免费领 9 元话费券");
  assert.equal(items[0]?.url, "https://bbs.nga.cn/read.php?tid=48123456");
  assert.equal(items[1]?.externalId, "48123457");
});

test("NGA JSON 备通道：结构探测取 tid / 标题 / 时间", () => {
  const body = JSON.stringify({
    data: {
      __T: [
        { "0": 48123456, "1": "【免费领取】某云服务器一年", "2": 100, "6": 1_700_000_000 },
        { "0": 48123457, "1": "另一条优惠", "2": 200, "6": 1_700_000_100 },
      ],
      __U: { "100": { username: "羊毛佬" } },
    },
  });
  const items = __ngaInternals.parseJson(body);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.externalId, "48123456");
  assert.equal(items[0]?.author, "羊毛佬");
  assert.equal(items[0]?.publishedAt, new Date(1_700_000_000 * 1000).toISOString());
});

test("NGA Cookie 解析与调度判定：不依赖 VPS 执行器", () => {
  const parsed = parseCookieInput("ngaPassportUid=111; ngaPassportCid=abc", "nga");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.domain, ".nga.cn");

  updateCookieSettings({ runnerUrl: "", cookies: { nga: "" } });
  assert.equal(hasCookieConfiguredForSource("nga-deals"), false);

  updateCookieSettings({ cookies: { nga: "ngaPassportUid=111; ngaPassportCid=abc" } });
  assert.equal(hasCookieConfiguredForSource("nga-deals"), true, "NGA 有 Cookie 即应进入调度");
});

test("NGA 未配置 Cookie 时给出明确报错", async () => {
  updateCookieSettings({ cookies: { nga: "" } });
  await assert.rejects(
    () =>
      ngaCollector.collect({
        sourceId: "nga-deals",
        config: { fid: 570 },
        cursor: null,
        maxItems: 30,
        http: createHttp(),
        log: () => {},
      }),
    /未配置 NGA Cookie/,
  );
});

test("NGA 带 Cookie 采集：请求头携带登录态，HTML 解析成功", async () => {
  updateCookieSettings({ cookies: { nga: "ngaPassportUid=111; ngaPassportCid=abc" } });

  const seenHeaders: Record<string, string>[] = [];
  const fakeHttp = {
    raw: async () => {
      throw new Error("unused");
    },
    text: async (_url: string, opts?: { headers?: Record<string, string> }) => {
      seenHeaders.push(opts?.headers ?? {});
      return {
        status: 200,
        url: "https://bbs.nga.cn/thread.php?fid=570&page=1",
        headers: new Headers(),
        body: SAMPLE_HTML,
        bytes: Buffer.from(SAMPLE_HTML),
        contentType: "text/html; charset=GBK",
      };
    },
    json: async () => {
      throw new Error("unused");
    },
  };

  const res = await ngaCollector.collect({
    sourceId: "nga-deals",
    config: { fid: 570 },
    cursor: null,
    maxItems: 30,
    http: fakeHttp,
    log: () => {},
  });

  assert.equal(res.items.length, 2);
  assert.equal(res.degraded, null);
  assert.equal(res.items[0]?.categoryHint, undefined, "未配置 categoryHint 时不写分类提示");
  const cookie = seenHeaders[0]?.cookie ?? "";
  assert.match(cookie, /ngaPassportUid=111/);
  assert.match(cookie, /ngaPassportCid=abc/);
  assert.match(cookie, /guestJs=\d+/, "缺 guestJs 时自动补时间戳");
  assert.equal(seenHeaders[0]?.referer, "https://bbs.nga.cn/");
});

test("NGA 多版块：categoryHint 透传到每条条目（拼车 613 / 二手 498）", async () => {
  updateCookieSettings({ cookies: { nga: "ngaPassportUid=111; ngaPassportCid=abc" } });

  const fakeHttp = {
    raw: async () => {
      throw new Error("unused");
    },
    text: async () => ({
      status: 200,
      url: "https://bbs.nga.cn/thread.php?fid=613&page=1",
      headers: new Headers(),
      body: SAMPLE_HTML,
      bytes: Buffer.from(SAMPLE_HTML),
      contentType: "text/html; charset=GBK",
    }),
    json: async () => {
      throw new Error("unused");
    },
  };

  const res = await ngaCollector.collect({
    sourceId: "nga-carpool",
    config: { fid: 613, categoryHint: "carpool" },
    cursor: null,
    maxItems: 30,
    http: fakeHttp,
    log: () => {},
  });

  assert.equal(res.items.length, 2);
  assert.ok(
    res.items.every((it) => it.categoryHint === "carpool"),
    "每条都应带 categoryHint=carpool",
  );
});