/**
 * 综合评分：多维加权，AI 质量分主导。
 *
 * 旧实现是纯关键词加法（基线 30，免费 +15，福利词出现即 +10/14，24h 内 +16……），
 * 结果就是「标题堆满免费/白嫖/限时」就能刷到高分，而 AI 已经给出的质量分完全没参与。
 * 这里改成五个 0-100 维度的加权和，再乘一个惩罚系数：
 *
 *   获取确定性 30%  free/conditional/trial/lottery/promo/paid 各自一档，paid 按价格档次
 *   AI 质量分  35%  1-5 分映射为 8/30/55/80/100；未审条目回退到规则内容分 ×0.9
 *   时效       15%  连续衰减，不再 24h/3d/7d 跳档
 *   来源可信度 10%  用近 30 天真实 AI 留存率 + 平均质量分算，不再写死一张表
 *   可验证性   10%  兑换码、限量/限时、具体数量——越能立刻验证「真有这福利」越高
 *
 * 惩罚（乘性）：疑问/求助 ×0.55、引流话术（加微/私信/评论区扣） ×0.6、标题过短 ×0.72。
 */

import { all } from "../db.ts";
import { isNoiseTitle, URGENT } from "./noise.ts";

/** 各维度权重，合计 1。改这里就是调口径。 */
export const SCORE_WEIGHTS = {
  obtain: 0.3,
  quality: 0.35,
  freshness: 0.15,
  trust: 0.1,
  proof: 0.1,
} as const;

export type ScoreCtx = {
  title?: string;
  summary?: string;
  publishedAt?: string | null;
  sourceId?: string;
  codes?: string[];
  price?: number | null;
};

export type ScoreBreakdown = {
  total: number;
  obtain: number;
  quality: number;
  freshness: number;
  trust: number;
  proof: number;
  penalty: number;
  notes: string[];
};

function clamp(n: number, lo = 0, hi = 100): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** 获取确定性：这一维回答「点开就能拿到吗」。 */
const OBTAIN_SCORE: Record<string, number> = {
  free: 100,
  conditional: 72,
  trial: 35,
  lottery: 22,
  promo: 6,
  paid: 30,
};

export function obtainScore(
  obtain: string | null | undefined,
  kind?: string | null,
  price?: number | null,
): number {
  const key = obtain ?? "";
  if (key !== "paid") return OBTAIN_SCORE[key] ?? 55;
  // 付费条目要看形态：黑五好价/资讯/开源是「值得买」，普通福利区的付费条目基本不该高分
  if (kind === "deal" || kind === "news" || kind === "info" || kind === "opensource") {
    const p = typeof price === "number" && price >= 0 ? price : null;
    if (p === null) return 65;
    if (p <= 10) return 70;
    if (p <= 50) return 55;
    if (p <= 200) return 38;
    return 22;
  }
  return 25;
}

/** AI 质量分曲线：1 分等于出局，5 分满分。未审时回退到规则内容分。 */
const QUALITY_CURVE: Record<number, number> = { 1: 8, 2: 30, 3: 55, 4: 80, 5: 100 };

export function qualityScore(quality: number | null | undefined, ruleScore: number): number {
  if (typeof quality === "number" && Number.isFinite(quality)) {
    const q = Math.min(5, Math.max(1, Math.round(quality)));
    return QUALITY_CURVE[q] ?? 55;
  }
  return clamp(Math.round(ruleScore * 0.9));
}

/** 时效：连续衰减，越新越高，不再有 24h/3d/7d 的跳档断层。 */
export function freshnessScore(publishedAt: string | null | undefined): number {
  if (!publishedAt) return 55;
  const t = new Date(publishedAt).getTime();
  if (!Number.isFinite(t)) return 55;
  const hours = (Date.now() - t) / 3_600_000;
  if (hours < 0) return 100;
  if (hours <= 6) return 100;
  if (hours <= 24) return clamp(92 - ((hours - 6) / 18) * 10);
  if (hours <= 72) return clamp(82 - ((hours - 24) / 48) * 17);
  if (hours <= 168) return clamp(65 - ((hours - 72) / 96) * 20);
  if (hours <= 720) return clamp(45 - ((hours - 168) / 552) * 35);
  return 5;
}

type SourceStat = { reviewed: number; keepRate: number; avgQuality: number };

const TRUST_TTL_MS = 10 * 60_000;
let trustCache: { at: number; map: Map<string, SourceStat> } | null = null;

/** 来源可信度：近 30 天真实 AI 留存率 + 平均质量分。样本不足 5 条时视为中性 50 分。 */
export function sourceTrustMap(): Map<string, SourceStat> {
  if (trustCache && Date.now() - trustCache.at < TRUST_TTL_MS) return trustCache.map;
  const map = new Map<string, SourceStat>();
  try {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const rows = all<{ source_id: string; reviewed: number; kept: number; avgq: number | null }>(
      `SELECT source_id,
              COUNT(*) AS reviewed,
              SUM(CASE WHEN ai_keep = 1 THEN 1 ELSE 0 END) AS kept,
              AVG(ai_quality) AS avgq
         FROM items
        WHERE ai_keep IS NOT NULL
          AND first_seen_at >= ?
        GROUP BY source_id`,
      since,
    );
    for (const r of rows) {
      if (!r.reviewed || r.reviewed < 5) continue;
      map.set(r.source_id, {
        reviewed: r.reviewed,
        keepRate: r.kept / r.reviewed,
        avgQuality: r.avgq ?? 3,
      });
    }
  } catch {
    // 表还没建好或查询失败时按中性处理，不影响入库
  }
  trustCache = { at: Date.now(), map };
  return map;
}

export function resetTrustCache(): void {
  trustCache = null;
}

export function trustScore(sourceId: string | undefined, map = sourceTrustMap()): number {
  if (!sourceId) return 50;
  const s = map.get(sourceId);
  if (!s) return 50;
  const q = (Math.min(5, Math.max(1, s.avgQuality)) - 1) / 4;
  return clamp(s.keepRate * 60 + q * 40);
}

const QUANTITY_RE = /\d+\s*(?:个|份|名|台|张|次|天|GB|TB|MB|元|美刀|刀)/i;
const SCARCITY_RE = /限量|限时|先到先得|手慢无|名额|库存|剩余|抢完|截止/i;

/** 可验证性：越能立刻验证「真有这福利、现在还能领」越高。 */
export function proofScore(title: string, codes?: string[]): number {
  let s = 20;
  if (codes?.length) s += 50;
  if (SCARCITY_RE.test(title)) s += 20;
  if (QUANTITY_RE.test(title)) s += 15;
  if (URGENT.test(title)) s += 10;
  return clamp(s);
}

const LURE_RE =
  /加微|加\s*V|微信|私信|关注(?:后|领|即可|才)|评论区?\s*扣|扣\s*1|返利|返现|\baff\b|扫码进群|进群领|付费解锁/i;

/** 乘性惩罚：标题党与引流话术的通用指纹。 */
export function penaltyFactor(title: string, summary = ""): { factor: number; notes: string[] } {
  const notes: string[] = [];
  let factor = 1;
  if (isNoiseTitle(title)) {
    factor *= 0.55;
    notes.push("疑问/求助");
  }
  if (LURE_RE.test(`${title} ${summary}`)) {
    factor *= 0.6;
    notes.push("引流话术");
  }
  // 只有真给了标题才判断长度，未传 ctx 时不要凭空扣分
  if (title && title.trim().length < 6) {
    factor *= 0.72;
    notes.push("标题过短");
  }
  return { factor: Math.max(0.15, factor), notes };
}

/**
 * 合成最终分数。
 *
 * 缺失维度（没有发布时间、来源样本不足）不参与加权，权重按比例分给其余维度——
 * 否则「未知」被当成「中等偏差」会把所有新源的分数一起压低。
 *
 * @param ruleScore 规则内容分（scoreItem 的结果，0-100），只作为「AI 未审」时的质量回退
 */
export function combineScore(
  ruleScore: number,
  obtain: string | null | undefined,
  aiKeep: boolean | null,
  quality: number | null | undefined,
  kind: string | null | undefined,
  ctx: ScoreCtx = {},
): ScoreBreakdown {
  const trustMap = sourceTrustMap();
  const dims = {
    obtain: obtainScore(obtain, kind, ctx.price),
    quality: qualityScore(quality, ruleScore),
    freshness: freshnessScore(ctx.publishedAt ?? null),
    trust: trustScore(ctx.sourceId, trustMap),
    proof: proofScore(ctx.title ?? "", ctx.codes),
  };

  if (aiKeep === false || kind === "noise") {
    // AI 判否或噪音：直接压到底，不参与加权，避免关键词把垃圾顶回来
    return { total: Math.min(Math.round(ruleScore * 0.25), 25), ...dims, penalty: 0.25, notes: ["AI 判否"] };
  }

  const parts: Array<{ key: keyof typeof dims; weight: number; known: boolean }> = [
    { key: "obtain", weight: SCORE_WEIGHTS.obtain, known: true },
    { key: "quality", weight: SCORE_WEIGHTS.quality, known: true },
    { key: "freshness", weight: SCORE_WEIGHTS.freshness, known: Boolean(ctx.publishedAt) },
    { key: "trust", weight: SCORE_WEIGHTS.trust, known: Boolean(ctx.sourceId && trustMap.has(ctx.sourceId)) },
    { key: "proof", weight: SCORE_WEIGHTS.proof, known: true },
  ];

  let knownWeight = 0;
  let weighted = 0;
  for (const p of parts) {
    if (!p.known) continue;
    knownWeight += p.weight;
    weighted += dims[p.key] * p.weight;
  }
  const base = knownWeight > 0 ? weighted / knownWeight : 50;

  const { factor, notes } = penaltyFactor(ctx.title ?? "", ctx.summary ?? "");
  return { total: clamp(Math.round(base * factor)), ...dims, penalty: factor, notes };
}
