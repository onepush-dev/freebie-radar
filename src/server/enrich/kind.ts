import { DEAL_HINT, isNoiseTitle, OPENSOURCE_HINT, PROMO_HINT } from "./noise.ts";
import { KIND_LABEL, KIND_SET, isContentKind, type ContentKind } from "../../shared/taxonomy.ts";
import { contentSignals } from "./evidence.ts";

export type { ContentKind };
export { KIND_LABEL, isContentKind };
/** 兼容旧名：可被识别的全部形态（含 noise）。 */
export { KIND_SET as VALID_KINDS };

const OPENSOURCE_SOURCES = new Set([
  "github-free-for-dev",
  "github-public-apis",
  "github-awesome-ai",
  "github-selfhosted",
]);

const DEAL_SOURCES = new Set([
  "rss-lowendbox",
  "rss-lowendtalk",
  "rss-lowendspirit",
  "rss-vpsgo",
  "rss-vpsxb",
  "rss-reddit-gamedeals",
  "rss-reddit-googleplay",
  "rss-9to5toys",
  "rss-slickdeals",
  "rss-hip2save",
  "rss-ozbargain",
  "rss-smzdm",
]);

export const NEWS_SOURCES = new Set([
  "cctv-news",
  "rss-chinanews-scroll",
  "rss-chinanews-china",
  "rss-chinanews-world",
  "rss-bbc-zh",
  "rss-dw-cn",
  "rss-rfi-cn",
  "rss-gnews-cn",
  "rss-gnews-world",
  "rss-nikkei-cn",
  "rss-voa-cn",
]);

export function isAuthoritativeNewsSource(
  sourceId: string | null | undefined,
  kindHint?: string | null,
): boolean {
  return kindHint === "news" || Boolean(sourceId && NEWS_SOURCES.has(sourceId));
}

const INFO_SOURCES = new Set([
  "cctv-economy",
  "cctv-tech",
  "rss-wallstreetcn",
  "rss-chinanews-finance",
  "rss-chinanews-it",
  "rss-ruanyifeng",
  "rss-sspai",
  "rss-appinn",
  "rss-producthunt",
  "rss-hnrss",
  "rss-ithome",
  "rss-v2ex-tech",
  "rss-solidot",
]);

/**
 * 规则兜底推断内容形态（AI 未审或未返回 kind 时使用）。
 * 原则：硬噪音判 noise；明确开源且无纯白嫖词判 opensource；付费/黑五/特价促销判 deal；
 * 权威时政/国际要闻判 news；经济/股票/科技/深度指南判 info；其余按免费信号落位。
 */
export function guessKind(input: {
  title: string;
  summary?: string;
  sourceId?: string;
  category?: string | null;
  obtain?: string | null;
  isFree?: boolean;
  price?: number | null;
  freebieOnlySource?: boolean;
  kindHint?: string | null;
  guardEnabled?: boolean;
}): ContentKind {
  const title = input.title ?? "";
  const text = `${title} ${input.summary ?? ""}`;
  const guard = input.guardEnabled !== false;
  const signals = contentSignals(title, input.summary);
  if (isNoiseTitle(title)) return "noise";
  if (input.freebieOnlySource) return "freebie";
  if (input.kindHint && isContentKind(input.kindHint) && input.kindHint !== "noise") {
    if (!guard || !["freebie", "deal", "opensource"].includes(input.kindHint) ||
        (input.kindHint === "freebie" && signals.claim) || (input.kindHint === "deal" && signals.promotion) ||
        (input.kindHint === "opensource" && signals.repository)) return input.kindHint;
  }
  if (guard && signals.editorial) return isAuthoritativeNewsSource(input.sourceId, input.kindHint) ? "news" : "info";

  const hasDealWord = guard ? signals.claim : DEAL_HINT.test(title);
  const hasPromoWord = guard ? signals.promotion : PROMO_HINT.test(text);
  const hasOpenSource = guard ? signals.repository : input.category === "opensource" || OPENSOURCE_HINT.test(text);

  if (hasOpenSource && !hasDealWord && input.obtain !== "paid") {
    return "opensource";
  }
  if (input.sourceId && OPENSOURCE_SOURCES.has(input.sourceId) && !hasDealWord && (!guard || signals.repository)) {
    return "opensource";
  }

  const hasPaidPrice = !input.isFree && typeof input.price === "number" && input.price > 0;
  if ((input.obtain === "paid" || hasPaidPrice) && (!guard || signals.promotion)) {
    return "deal";
  }
  if (hasPromoWord && !hasDealWord && !input.isFree) {
    return "deal";
  }
  // 交易/拼车类：分类本身已确认是「明盘出鸡 / 发车合租」，不再额外要求促销词
  // （「50出」「溢价50出」「出租…车位」都不含促销词，旧逻辑因此把它们判成 info）
  if ((input.category === "carpool" || input.category === "trade") && !hasDealWord) {
    return "deal";
  }
  if (input.sourceId && DEAL_SOURCES.has(input.sourceId) && !input.isFree && !hasDealWord && (!guard || signals.promotion)) {
    return "deal";
  }

  if (input.sourceId && NEWS_SOURCES.has(input.sourceId)) return "news";
  if ((!guard && input.isFree) || hasDealWord) return "freebie";
  if (input.sourceId && INFO_SOURCES.has(input.sourceId)) return "info";
  if (input.category === "opensource" && (!guard || signals.repository)) return "opensource";
  if (
    input.category === "headline" ||
    input.category === "world" ||
    input.category === "stock" ||
    input.category === "finance" ||
    input.category === "tech" ||
    input.category === "news" ||
    input.category === "edu"
  ) {
    // 非权威新闻源（如什么值得买/IT之家/社区）不得落入 news，统一归为 info（导购站由上方 DEAL_SOURCES 先拦）
    return "info";
  }
  return guard ? "info" : "freebie";
}

function coerceNonNewsKind(fallbackInput: Parameters<typeof guessKind>[0]): ContentKind {
  if (
    fallbackInput.sourceId &&
    DEAL_SOURCES.has(fallbackInput.sourceId) &&
    !fallbackInput.isFree &&
    !DEAL_HINT.test(fallbackInput.title ?? "") && fallbackInput.guardEnabled === false
  ) {
    return "deal";
  }
  const guessed = guessKind(fallbackInput);
  return guessed === "noise" || (guessed === "news" && !isAuthoritativeNewsSource(fallbackInput.sourceId, fallbackInput.kindHint)) ? "info" : guessed;
}

const TRADE_LIKE_CATEGORIES = new Set(["trade", "carpool", "goods"]);

/**
 * 分类与形态的一致性约束（最后一道闸）。
 * 分类已经确认是「二手交易 / 拼车合租 / 实物优惠」时，形态不可能是「行业资讯」：
 * 以前这里只做单向降级（AI 说 deal 但没促销词就打回 info），于是出现
 * category=trade + kind=info 的自相矛盾组合（全库 500+ 条）。
 */
export function alignKindWithCategory(
  kind: ContentKind,
  input: Parameters<typeof guessKind>[0],
): ContentKind {
  if (kind === "noise" || kind === "news") return kind;
  const category = input.category;
  if (!category || !TRADE_LIKE_CATEGORIES.has(category)) return kind;
  if (input.freebieOnlySource) return kind;
  const signals = contentSignals(input.title, input.summary);
  const paidish = input.obtain === "paid" || (typeof input.price === "number" && input.price > 0);
  // 有明确领取/白送证据且不需要付费的实物福利归 freebie（如「免费送小鸡」「PDD 免费领」）；
  // 需要付费的「领取优惠券」仍是好价，不能因为出现「领取」就变福利
  if (signals.claim && !paidish) return "freebie";
  // 编辑性内容（财报/事故/政策报道）撞上交易词时不硬改
  if (signals.editorial && !signals.promotion) return kind;
  // 交易/拼车：分类已确认是明盘转让或发车，形态就是 deal
  if (category === "trade" || category === "carpool") return "deal";
  // goods（实物/优惠）默认不是资讯：AI 没给形态时按价格/免费信号落位
  if (category === "goods" && kind === "info") {
    if (signals.claim) return "freebie";
    if (paidish) return "deal";
    // 注意：obtain=free 只代表「没检测到价格」，不是福利证据；
    // 用它兜底会把「什么值得买」的测评文全判成白嫖福利。
  }
  // goods：有价格或促销证据才算好价，其余保留原判
  return paidish || signals.promotion ? "deal" : kind;
}

/** 结合 AI 输出与规则上下文归一化最终 kind。 */
export function resolveKind(
  aiKind: unknown,
  aiKeep: boolean | null | undefined,
  fallbackInput: Parameters<typeof guessKind>[0],
): ContentKind {
  return alignKindWithCategory(resolveKindRaw(aiKind, aiKeep, fallbackInput), fallbackInput);
}

function resolveKindRaw(
  aiKind: unknown,
  aiKeep: boolean | null | undefined,
  fallbackInput: Parameters<typeof guessKind>[0],
): ContentKind {
  if (aiKeep === false) return "noise";
  if (isContentKind(aiKind)) {
    if (fallbackInput.guardEnabled !== false) {
      const signals = contentSignals(fallbackInput.title, fallbackInput.summary);
      if ((aiKind === "deal" && !signals.promotion) ||
          (aiKind === "freebie" && !signals.claim && !fallbackInput.freebieOnlySource) ||
          (aiKind === "opensource" && !signals.repository)) return coerceNonNewsKind(fallbackInput);
    }
    if (fallbackInput.guardEnabled !== false && aiKind === "noise" && aiKeep === true) return coerceNonNewsKind(fallbackInput);
    if (aiKind === "noise" && aiKeep === true) return guessKind(fallbackInput);
    if (aiKind === "opensource" && (fallbackInput.category === "headline" || fallbackInput.category === "world" || fallbackInput.category === "stock")) {
      return guessKind(fallbackInput);
    }
    // 重要新闻严格限定于权威新闻源，禁止导购/购物/普通社区（如什么值得买、IT之家等）混入「重要新闻」
    if (aiKind === "news" && !isAuthoritativeNewsSource(fallbackInput.sourceId, fallbackInput.kindHint)) {
      return coerceNonNewsKind(fallbackInput);
    }
    return aiKind;
  }
  if (aiKeep === true) {
    if (fallbackInput.guardEnabled !== false) return coerceNonNewsKind(fallbackInput);
    if (fallbackInput.category === "opensource") return "opensource";
    if (fallbackInput.obtain === "paid" || (!fallbackInput.isFree && typeof fallbackInput.price === "number" && fallbackInput.price > 0)) {
      return "deal";
    }
    const guessed = guessKind(fallbackInput);
    return guessed === "noise" ? "freebie" : guessed;
  }
  return guessKind(fallbackInput);
}
