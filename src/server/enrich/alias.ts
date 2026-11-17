import { all, get, run } from "../db.ts";
import { extractMergeKeys } from "./dedup.ts";
import { combineScore, type ScoreBreakdown, type ScoreCtx } from "./score.ts";

/**
 * 结合 title_aliases 字典把单条标题映射到统一的 canonical title_key。
 * 当遇到包含中英双名（如《斗阵骑士 Knightica》）的条目时，
 * 自动建立中文别名 -> 英文主名映射，并把库里既有同中文名条目合并过来。
 */
export function resolveDbMergeKey(title: string): string {
  const keys = extractMergeKeys(title);
  if (!keys.length) return "";

  try {
    if (keys.length === 1) {
      const k = keys[0]!;
      const mapped = get<{ canonical: string }>("SELECT canonical FROM title_aliases WHERE alias = ?", k);
      return mapped?.canonical ?? k;
    }

    const placeholders = keys.map(() => "?").join(",");
    const existing = all<{ alias: string; canonical: string }>(
      `SELECT alias, canonical FROM title_aliases WHERE alias IN (${placeholders})`,
      ...keys,
    );
    const canonical = existing[0]?.canonical ?? keys[0]!;
    for (const k of keys) {
      if (k === canonical) continue;
      run(
        "INSERT INTO title_aliases (alias, canonical) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical",
        k,
        canonical,
      );
      run("UPDATE items SET title_key = ? WHERE title_key = ?", canonical, k);
    }
    return canonical;
  } catch {
    return keys[0]!;
  }
}

/**
 * 综合评分入口：多维加权（见 score.ts），AI 质量分占主导。
 *
 * 保持原函数名与参数顺序，额外接受一个可选的 ctx（标题/发布时间/来源/兑换码/价格）。
 * 不传 ctx 时那几个维度按中性值算，行为仍然可用——但调用方应尽量传，否则时效与来源可信度维度失效。
 */
export function calibrateScoreByObtain(
  ruleScore: number,
  obtain: string | null | undefined,
  aiKeep: boolean | null,
  quality?: number | null,
  kind?: string | null,
  ctx: ScoreCtx = {},
): number {
  return combineScore(ruleScore, obtain, aiKeep, quality, kind, ctx).total;
}

/** 需要解释分数时用这个：返回各维度得分与惩罚系数。 */
export function explainScore(
  ruleScore: number,
  obtain: string | null | undefined,
  aiKeep: boolean | null,
  quality?: number | null,
  kind?: string | null,
  ctx: ScoreCtx = {},
): ScoreBreakdown {
  return combineScore(ruleScore, obtain, aiKeep, quality, kind, ctx);
}
