import { getCookieSettings } from "../cookie-store.ts";
import { cleanText, parseDate, sanitizeImageUrl } from "../enrich/normalize.ts";
import type { Collector, RawItem } from "./types.ts";

/**
 * 微博采集（PC 端 ajax 接口，需要 weibo.com 登录态 Cookie）。
 *
 * 实测（2026-11-15，用真实登录 cookie）：
 * - `weibo.com/ajax/statuses/search?q=<kw>&page=1` → 200 / 340KB / `statuses[]` 48-50 条，
 *   `total_number` 表示命中总数（"免费领取" = 2269246）；`sort=hot|time` 参数无效，恒为时间序；
 * - `weibo.com/ajax/statuses/mymblog?uid=<uid>&page=1&feature=0` → 200 / `data.list[]` 20 条（盯指定博主）；
 * - `m.weibo.cn/api/container/getIndex` 用 PC cookie 返回 `ok:-100` 跳登录 —— **移动域不认 weibo.com 的 SUB**，
 *   所以只能走 PC ajax；
 * - 微博没有官方 RSS，RSSHub 的 weibo 路由公共实例全挂（rsshub.app 连不上 / rssforever 503），自建成本高。
 *
 * 内容噪声很大（营销号刷 `#SVIP体验卡免费领#`、手游私服广告），所以：
 * - 同一段文案被几十个号转发时按正文指纹合并，只留互动量最高的一条；
 * - 标题用正文首句（微博没有标题字段）。
 */

type WeiboConfig = {
  /** 关键词搜索 */
  keywords?: string[];
  /** 盯人的 uid 列表（走 mymblog） */
  uids?: string[];
  limitPerKeyword?: number;
  limitPerUser?: number;
  /** 正文必须命中其一，默认福利白名单 */
  titleKeywords?: string[];
  /** 正文命中即丢弃 */
  excludeKeywords?: string[];
  categoryHint?: string;
};

const DEFAULT_TITLE_KEYWORDS = [
  "免费",
  "白嫖",
  "领取",
  "羊毛",
  "福利",
  "抽奖",
  "券",
  "优惠",
  "0元",
  "限免",
  "兑换",
  "会员",
];

/** 实测刷屏最猛的两类：营销模板与私服广告 */
const DEFAULT_EXCLUDE_KEYWORDS = [
  "获取原图",
  "街拍",
  "写真",
  "套图",
  "我已成功领取",
  "快来点击卡片领取",
  "私服",
  "首充",
  "充值返利",
  "加微",
  "加V",
];

function cookieHeader(): string {
  const entry = getCookieSettings().sites.weibo;
  const cookies = entry?.cookies ?? [];
  if (!cookies.length) {
    throw new Error("未配置微博 Cookie，请在「数据源运维 → Cookie 托管」粘贴 weibo.com 登录后的 Cookie（需含 SUB）");
  }
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Status = Record<string, unknown>;

function textOf(s: Status): string {
  return cleanText(String(s.text_raw ?? s.text ?? ""), 600);
}

/** 微博没有标题，取正文首个句子作为标题（福利信息通常第一句就说完） */
function titleOf(text: string): string {
  const cut = text.split(/[。！!？?，,；;\n]/)[0] ?? text;
  const t = cut.trim();
  return (t.length >= 4 ? t : text).slice(0, 100);
}

function toRawItem(s: Status): RawItem | null {
  const mid = String(s.mid ?? s.idstr ?? s.id ?? "");
  const mblogid = typeof s.mblogid === "string" ? s.mblogid : "";
  const user = (s.user ?? {}) as Record<string, unknown>;
  const uid = String(user.idstr ?? user.id ?? "");
  if (!mid) return null;

  const url = uid && mblogid ? `https://weibo.com/${uid}/${mblogid}` : `https://m.weibo.cn/detail/${mid}`;
  const text = textOf(s);
  if (!text) return null;

  const picIds = Array.isArray(s.pic_ids) ? (s.pic_ids as string[]) : [];
  const pageInfo = (s.page_info ?? {}) as Record<string, unknown>;
  const pagePic = typeof pageInfo.page_pic === "string" ? pageInfo.page_pic : "";
  const imageUrl = picIds[0]
    ? `https://wx1.sinaimg.cn/large/${picIds[0]}.jpg`
    : typeof pagePic === "string" && /^https?:\/\//.test(pagePic)
      ? pagePic
      : "";

  return {
    externalId: mid,
    url,
    title: titleOf(text),
    summary: text.slice(0, 400),
    author: typeof user.screen_name === "string" ? user.screen_name : null,
    publishedAt: parseDate(typeof s.created_at === "string" ? s.created_at : null),
    imageUrl: imageUrl ? sanitizeImageUrl(imageUrl) : null,
    tags: ["weibo"],
    raw: {
      mid,
      mblogid,
      attitudes: s.attitudes_count ?? null,
      reposts: s.reposts_count ?? null,
      comments: s.comments_count ?? null,
    },
  };
}

/** 正文指纹：去掉表情/话题符号与空白后的前 40 字，用于合并营销号刷屏 */
function fingerprint(text: string): string {
  return text
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .slice(0, 40)
    .toLowerCase();
}

function engagement(it: RawItem): number {
  const raw = it.raw as { attitudes?: unknown; reposts?: unknown; comments?: unknown } | undefined;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return n(raw?.attitudes) + n(raw?.reposts) + n(raw?.comments);
}

type SearchResponse = { ok?: number; statuses?: Status[]; total_number?: number; msg?: string };
type MymblogResponse = { ok?: number; data?: { list?: Status[]; since_id?: string }; msg?: string };

export const weiboCollector: Collector = {
  kind: "weibo",
  label: "微博搜索与博主",
  defaults: { config: { keywords: ["免费领取", "白嫖"] } },
  async collect(ctx) {
    const cfg = ctx.config as Partial<WeiboConfig>;
    const keywords = (cfg.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
    const uids = (cfg.uids ?? []).map((u) => String(u).trim()).filter(Boolean);
    if (!keywords.length && !uids.length) throw new Error("未配置 keywords 或 uids");

    const limitPerKeyword = Math.min(Math.max(Number(cfg.limitPerKeyword ?? 20), 1), 50);
    const limitPerUser = Math.min(Math.max(Number(cfg.limitPerUser ?? 20), 1), 20);
    const titleKws = (cfg.titleKeywords ?? DEFAULT_TITLE_KEYWORDS).map((s) => s.toLowerCase()).filter(Boolean);
    const excludeKws = (cfg.excludeKeywords ?? DEFAULT_EXCLUDE_KEYWORDS).map((s) => s.toLowerCase()).filter(Boolean);
    const categoryHint = typeof cfg.categoryHint === "string" ? cfg.categoryHint : null;
    const cookie = cookieHeader();
    const headers = {
      cookie,
      referer: "https://weibo.com/",
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
    };

    const items: RawItem[] = [];
    const problems: string[] = [];
    let ok = 0;

    const accept = (s: Status, tag: string): RawItem | null => {
      const raw = toRawItem(s);
      if (!raw) return null;
      const hay = `${raw.title} ${raw.summary ?? ""}`.toLowerCase();
      if (titleKws.length && !titleKws.some((k) => hay.includes(k))) return null;
      if (excludeKws.some((k) => hay.includes(k))) return null;
      if (categoryHint) raw.categoryHint = categoryHint;
      raw.tags = ["weibo", tag];
      return raw;
    };

    for (const keyword of keywords) {
      try {
        const res = await ctx.http.json<SearchResponse>(
          `https://weibo.com/ajax/statuses/search?q=${encodeURIComponent(keyword)}&page=1`,
          { headers },
        );
        if (res.data?.ok !== 1) {
          problems.push(`${keyword}: ${res.data?.msg ?? "ok=" + String(res.data?.ok)}`);
          continue;
        }
        const list = res.data.statuses ?? [];
        let kept = 0;
        for (const s of list) {
          if (kept >= limitPerKeyword) break;
          const raw = accept(s, keyword);
          if (!raw) continue;
          items.push(raw);
          kept += 1;
        }
        ok += 1;
        ctx.log(`${keyword} total=${res.data.total_number ?? "?"} fetched=${list.length} kept=${kept}`);
      } catch (err) {
        problems.push(`${keyword}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const uid of uids) {
      try {
        const res = await ctx.http.json<MymblogResponse>(
          `https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(uid)}&page=1&feature=0`,
          { headers },
        );
        const list = res.data?.data?.list ?? [];
        if (!list.length) {
          problems.push(`uid=${uid}: 无数据（uid 是否正确？）`);
          continue;
        }
        let kept = 0;
        for (const s of list) {
          if (kept >= limitPerUser) break;
          const raw = accept(s, uid);
          if (!raw) continue;
          items.push(raw);
          kept += 1;
        }
        ok += 1;
        ctx.log(`uid=${uid} fetched=${list.length} kept=${kept}`);
      } catch (err) {
        problems.push(`uid=${uid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!ok && problems.length) throw new Error("微博采集全部失败: " + problems.join("; "));

    // 按 mid 去重 + 按正文指纹合并营销号刷屏（保留互动量最高的一条）
    const byId = new Map<string, RawItem>();
    for (const it of items) if (!byId.has(it.externalId)) byId.set(it.externalId, it);
    const unique = [...byId.values()].sort((a, b) => engagement(b) - engagement(a));
    const kept: RawItem[] = [];
    const keptPrints = new Set<string>();
    for (const it of unique) {
      const fp = fingerprint(`${it.title} ${it.summary ?? ""}`);
      if (fp && keptPrints.has(fp)) continue;
      if (fp) keptPrints.add(fp);
      kept.push(it);
    }
    if (kept.length < unique.length) ctx.log(`同文案合并 ${unique.length} → ${kept.length}`);

    return {
      items: kept.slice(0, ctx.maxItems),
      cursor: null,
      degraded: problems.length ? problems.join("; ") : null,
    };
  },
};

/** 供测试使用 */
export const __weiboInternals = { toRawItem, titleOf, fingerprint, engagement, cookieHeader };