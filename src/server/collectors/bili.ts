import { createHash } from "node:crypto";
import { cleanText, parseDate, sanitizeImageUrl } from "../enrich/normalize.ts";
import type { HttpClient } from "../http.ts";
import type { Collector, RawItem } from "./types.ts";

/**
 * B 站关键词搜索采集。
 *
 * 实测（2026-11-15，本机国内家宽，未登录）：
 * - `x/web-interface/wbi/search/type` 需要 wbi 签名（`w_rid`），但签名算法是公开的、
 *   **不需要 cookie**：`nav` 接口给出 img_key / sub_key，按固定 MIXIN 表重排后取前 32 位当密钥；
 * - 未签名时返回 -403/-352，签名后 code=0 且每页 20 条真实结果；
 * - 兜底通道 `x/web-interface/search/all/v2` 同样免登录可用（code=0），wbi 失效时自动切换。
 *
 * 采集的是「喜加一 / 白嫖 / 限免」类视频：标题与简介里通常直接列出游戏名、原价与领取链接。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

type BiliConfig = {
  keywords: string[];
  /** video / article，默认 video */
  searchType?: "video" | "article";
  /** 每个关键词取多少条，默认 20 */
  limitPerKeyword?: number;
  /** 标题必须命中其一（大小写不敏感）；留空表示不过滤 */
  titleKeywords?: string[];
  /** 标题命中即丢弃 */
  excludeKeywords?: string[];
  /** 分类提示，透传到条目 */
  categoryHint?: string;
  /** 同批次相似标题合并，默认开启 */
  dedupeSimilar?: boolean;
  /** bigram Jaccard 阈值，默认 0.62 */
  similarityThreshold?: number;
};

const DEFAULT_TITLE_KEYWORDS = [
  "免费",
  "白嫖",
  "喜加一",
  "限免",
  "领取",
  "兑换码",
  "羊毛",
  "优惠券",
  "0元",
  "0 元",
  "白给",
  "史低",
];

const DEFAULT_EXCLUDE_KEYWORDS = ["录播", "直播回放", "reaction", "解说", "预告", "花絮"];

/** 标题归一化后的字符 bigram，用于同批次相似标题合并 */
function bigrams(title: string): Set<string> {
  const t = title.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function playOf(it: RawItem): number {
  const raw = it.raw as { play?: unknown } | undefined;
  return typeof raw?.play === "number" ? raw.play : 0;
}

type WbiKeys = { key: string; at: number };
let cachedKeys: WbiKeys | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

function pickKey(url: string): string {
  return url.split("/").pop()?.split(".")[0] ?? "";
}

function signQuery(params: Record<string, string | number>, key: string): string {
  const wts = Math.floor(Date.now() / 1000);
  const entries = [...new URLSearchParams({ ...params, wts: String(wts) } as Record<string, string>).entries()].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const query = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${createHash("md5").update(query + key).digest("hex")}`;
}

async function getWbiKey(http: HttpClient): Promise<string | null> {
  if (cachedKeys && Date.now() - cachedKeys.at < KEY_TTL_MS) return cachedKeys.key;
  const res = await http.json<{ code: number; data?: { wbi_img?: { img_url?: string; sub_url?: string } } }>(
    "https://api.bilibili.com/x/web-interface/nav",
    { headers: { referer: "https://www.bilibili.com/" } },
  );
  const wbi = res.data?.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) return null;
  const raw = pickKey(wbi.img_url) + pickKey(wbi.sub_url);
  const key = MIXIN.map((i) => raw[i] ?? "").join("").slice(0, 32);
  if (!key) return null;
  cachedKeys = { key, at: Date.now() };
  return key;
}

type BiliItem = Record<string, unknown>;

function toRawItem(it: BiliItem, keyword: string): RawItem | null {
  const bvid = typeof it.bvid === "string" ? it.bvid : "";
  const aid = it.aid ?? it.id;
  const arcurl = typeof it.arcurl === "string" ? it.arcurl : "";
  const url = arcurl ? arcurl.replace(/^http:/, "https:") : bvid ? `https://www.bilibili.com/video/${bvid}` : "";
  const title = cleanText(String(it.title ?? "").replace(/<[^>]+>/g, ""), 200);
  if (!title || !url) return null;
  const id = bvid || String(aid ?? "");
  if (!id) return null;

  const pic = typeof it.pic === "string" ? it.pic : "";
  return {
    externalId: id,
    url,
    title,
    summary: cleanText(String(it.description ?? ""), 400) || null,
    author: typeof it.author === "string" ? it.author : null,
    publishedAt: parseDate(typeof it.pubdate === "number" ? it.pubdate : null),
    imageUrl: pic ? sanitizeImageUrl(pic.startsWith("//") ? `https:${pic}` : pic) : null,
    tags: ["bilibili", keyword].filter(Boolean),
    raw: {
      bvid,
      aid,
      play: it.play ?? null,
      duration: it.duration ?? null,
      typename: it.typename ?? null,
      tag: it.tag ?? null,
    },
  };
}

export const biliCollector: Collector = {
  kind: "bili",
  label: "B站搜索",
  defaults: { config: { keywords: ["免费领取", "白嫖", "喜加一"] } },
  async collect(ctx) {
    const cfg = ctx.config as Partial<BiliConfig>;
    const keywords = (cfg.keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
    if (!keywords.length) throw new Error("未配置 keywords");
    const searchType = cfg.searchType ?? "video";
    const limitPerKeyword = Math.min(Math.max(Number(cfg.limitPerKeyword ?? 20), 1), 50);
    const titleKws = (cfg.titleKeywords ?? DEFAULT_TITLE_KEYWORDS).map((s) => s.toLowerCase()).filter(Boolean);
    const excludeKws = (cfg.excludeKeywords ?? DEFAULT_EXCLUDE_KEYWORDS).map((s) => s.toLowerCase()).filter(Boolean);
    const categoryHint = typeof cfg.categoryHint === "string" ? cfg.categoryHint : null;
    const http = ctx.http;

    const items: RawItem[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    let ok = 0;

    const wbiKey = await getWbiKey(http).catch(() => null);
    if (!wbiKey) problems.push("wbi keys 获取失败，走 legacy 搜索");

    for (const keyword of keywords) {
      let list: BiliItem[] = [];
      try {
        if (wbiKey) {
          const qs = signQuery({ search_type: searchType, keyword, page: 1 }, wbiKey);
          const res = await http.json<{ code: number; message?: string; data?: { result?: BiliItem[] } }>(
            `https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`,
            { headers: { referer: "https://www.bilibili.com/" } },
          );
          if (res.data?.code === 0) {
            list = res.data.data?.result ?? [];
          } else {
            problems.push(`${keyword} wbi: code=${res.data?.code} ${res.data?.message ?? ""}`);
          }
        }
      } catch (err) {
        problems.push(`${keyword} wbi: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!list.length) {
        try {
          const res = await http.json<{
            code: number;
            data?: { result?: Array<{ result_type?: string; data?: BiliItem[] }> };
          }>(
            `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=1`,
            { headers: { referer: "https://www.bilibili.com/" } },
          );
          if (res.data?.code === 0) {
            const groups = res.data.data?.result ?? [];
            const videoGroup = groups.find((g) => g.result_type === "video");
            list = videoGroup?.data ?? groups.flatMap((g) => g.data ?? []);
          } else {
            problems.push(`${keyword} legacy: code=${res.data?.code}`);
          }
        } catch (err) {
          problems.push(`${keyword} legacy: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!list.length) continue;
      ok += 1;

      let kept = 0;
      for (const it of list) {
        if (kept >= limitPerKeyword) break;
        const raw = toRawItem(it, keyword);
        if (!raw || seen.has(raw.externalId)) continue;
        // 标题词只看标题：简介里常出现「免费」等词，用它过滤会把影视、教程类全放进来
        const titleHay = raw.title.toLowerCase();
        const fullHay = `${raw.title} ${raw.summary ?? ""}`.toLowerCase();
        if (titleKws.length && !titleKws.some((k) => titleHay.includes(k))) continue;
        if (excludeKws.some((k) => fullHay.includes(k))) continue;
        if (categoryHint) raw.categoryHint = categoryHint;
        seen.add(raw.externalId);
        items.push(raw);
        kept += 1;
      }
      ctx.log(`${keyword} ok:${list.length} kept:${kept}`);
    }

    if (!ok && problems.length) throw new Error("B站搜索全部失败: " + problems.join("; "));

    // 同一热点会被多个 UP 复述（实测 BLG 夺冠送大会员一次采集出现 10 条），按标题合并。
    // 只合并「不同 UP + 高度相似」的标题：同一 UP 的相似标题通常是系列视频（如每周喜加一汇总），
    // 实测系列标题相似度 0.39-0.47、跨 UP 复述同一事件 0.71-0.77，所以阈值取 0.7 能分开两者。
    let merged = items;
    if (cfg.dedupeSimilar !== false && items.length > 1) {
      const threshold = Number(cfg.similarityThreshold ?? 0.7);
      const ranked = [...items].sort((a, b) => playOf(b) - playOf(a));
      const kept: RawItem[] = [];
      const keptGrams: Set<string>[] = [];
      for (const it of ranked) {
        const grams = bigrams(it.title);
        const dup = kept.some(
          (prev, i) => prev.author !== it.author && jaccard(keptGrams[i]!, grams) >= threshold,
        );
        if (dup) continue;
        kept.push(it);
        keptGrams.push(grams);
      }
      if (kept.length < items.length) ctx.log(`相似标题合并 ${items.length} → ${kept.length}`);
      merged = kept;
    }

    return {
      items: merged.slice(0, ctx.maxItems),
      cursor: null,
      degraded: problems.length ? problems.join("; ") : null,
    };
  },
};

/** 供测试使用 */
export const __biliInternals = { signQuery, toRawItem, getWbiKey, resetKeyCache: () => (cachedKeys = null) };

