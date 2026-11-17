import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, migrate } from "../src/server/db.ts";
import {
  combineScore,
  freshnessScore,
  obtainScore,
  penaltyFactor,
  proofScore,
  qualityScore,
} from "../src/server/enrich/score.ts";

migrate();

after(() => {
  closeDb();
});

test("评分维度：获取确定性按 obtain 分档，paid 按形态与价格分档", () => {
  assert.equal(obtainScore("free"), 100);
  assert.ok(obtainScore("conditional") < obtainScore("free"));
  assert.ok(obtainScore("lottery") < obtainScore("conditional"));
  assert.ok(obtainScore("promo") < obtainScore("lottery"));
  // 付费好价不能因为「要钱」被一刀切压死：越便宜越接近可买
  assert.ok(obtainScore("paid", "deal", 5) > obtainScore("paid", "deal", 500));
  assert.ok(obtainScore("paid", "deal", 5) > obtainScore("paid", "freebie", 5));
});

test("评分维度：AI 质量分主导，1 分接近出局、5 分满分", () => {
  assert.equal(qualityScore(5, 0), 100);
  assert.equal(qualityScore(1, 100), 8);
  assert.ok(qualityScore(4, 0) > qualityScore(3, 0));
  // 未审条目回退到规则内容分，但打折（未经 AI 确认）
  assert.equal(qualityScore(null, 80), 72);
});

test("评分维度：时效连续衰减且单调不增", () => {
  const now = Date.now();
  const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
  const seq = [1, 12, 30, 60, 120, 300, 900].map((h) => freshnessScore(at(h)));
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i]! <= seq[i - 1]!, `时效应单调不增，第 ${i} 段 ${seq[i]} > ${seq[i - 1]}`);
  }
  assert.equal(freshnessScore(null), 55);
});

test("评分维度：可验证性——兑换码与限量信号加分", () => {
  const plain = proofScore("某网盘会员");
  assert.ok(proofScore("某网盘会员", ["ABCD-1234"]) > plain, "含兑换码应更高");
  assert.ok(proofScore("限量 100 个名额，先到先得") > plain, "限量/名额应更高");
});

test("评分惩罚：疑问求助与引流话术各自打折，且可叠加", () => {
  assert.ok(penaltyFactor("求推荐一个好用的网盘").factor < 1);
  assert.ok(penaltyFactor("免费领会员，加微信私信我").factor < 1);
  const both = penaltyFactor("有没有人知道怎么领？加微信告诉你").factor;
  assert.ok(both < penaltyFactor("求推荐一个好用的网盘").factor);
  assert.equal(penaltyFactor("免费领取 7 天会员").factor, 1);
});

test("综合分：AI 判否直接压到 25 分以内，不参与加权", () => {
  const out = combineScore(95, "free", false, 5, "freebie", {
    title: "免费领取 4K 影视会员 30 天",
    publishedAt: new Date().toISOString(),
  });
  assert.ok(out.total <= 25, `AI 判否应 ≤ 25，实际 ${out.total}`);
});

test("综合分：同一条目 AI 5 分明显高于 AI 2 分，且高于未审", () => {
  const ctx = {
    title: "免费领取 7 天视频会员",
    publishedAt: new Date().toISOString(),
    sourceId: "rss-nodeseek",
  };
  const q5 = combineScore(60, "free", true, 5, "freebie", ctx).total;
  const q2 = combineScore(60, "free", true, 2, "freebie", ctx).total;
  const unreviewed = combineScore(60, "free", null, null, "freebie", ctx).total;
  assert.ok(q5 > q2, `AI 5 分应高于 2 分（${q5} vs ${q2}）`);
  assert.ok(q5 > unreviewed, `AI 5 分应高于未审（${q5} vs ${unreviewed}）`);
  assert.ok(q5 >= 80, `免费 + AI 5 分应进高分区，实际 ${q5}`);
});

test("综合分：缺失维度不拉低总分（无发布时间时不按中性值扣分）", () => {
  const withTime = combineScore(60, "free", true, 4, "freebie", {
    title: "免费领取 7 天视频会员",
    publishedAt: new Date().toISOString(),
  }).total;
  const noTime = combineScore(60, "free", true, 4, "freebie", { title: "免费领取 7 天视频会员" }).total;
  assert.ok(noTime >= withTime - 5, `缺发布时间不应明显拉低（${noTime} vs ${withTime}）`);
});

test("综合分：付费好价不再被 25 分封顶", () => {
  const deal = combineScore(70, "paid", true, 5, "deal", {
    title: "黑五特价 RackNerd KVM 年付 $10.99",
    publishedAt: new Date().toISOString(),
    price: 10.99,
  }).total;
  assert.ok(deal >= 60, `付费好价应保留高分空间，实际 ${deal}`);
});
