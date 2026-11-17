import { getCookieSettings } from "../cookie-store.ts";
import { cleanText } from "../enrich/normalize.ts";
import type { Collector, RawItem } from "./types.ts";

/**
 * NGA 玩家社区（bbs.nga.cn）版块采集。
 *
 * 实测（2026-11-15，本机国内家宽）：
 * - 所有镜像域名（bbs.nga.cn / nga.178.com / ngabbs.com / g.nga.cn）对访客一律
 *   403「15:访客不能直接访问」，guestJs 时间戳 cookie 也无效；
 * - 登录态只需两个 Cookie：ngaPassportUid + ngaPassportCid（第三方客户端同款做法）。
 *
 * 因此本采集器走「HTTP + 托管 Cookie」，不需要无头浏览器：
 * 1. 主通道 `thread.php?fid=<fid>`（GBK HTML）用正则取帖子列表；
 * 2. 备通道 `thread.php?fid=<fid>&__output=11`（UTF-8 JSON）解析 data.__T。
 */

type NgaConfig = {
  /** 版块 fid，例如 570 = 优惠信息购物指南 */
  fid: number;
  /** 版块名，仅用于日志与标签 */
  forumName?: string;
  /** 翻页数，默认 1 */
  pages?: number;
  /** 分类提示，例如 carpool / trade；写入 RawItem.categoryHint */
  categoryHint?: string;
};

function cookieHeader(): string {
  const entry = getCookieSettings().sites.nga;
  const cookies = entry?.cookies ?? [];
  if (!cookies.length) {
    throw new Error("未配置 NGA Cookie，请在「数据源运维 → Cookie 托管」粘贴 ngaPassportUid / ngaPassportCid");
  }
  const now = Math.floor(Date.now() / 1000);
  const parts = cookies.map((c) => `${c.name}=${c.value}`);
  if (!cookies.some((c) => c.name === "guestJs")) parts.push(`guestJs=${now}`);
  return parts.join("; ");
}

function baseUrl(fid: number, page: number): string {
  return `https://bbs.nga.cn/thread.php?fid=${fid}&page=${page}`;
}

/**
 * 从列表页 HTML 里抽帖子。
 *
 * 实测（2026-11-15，带 ngaPassportUid/Cid）列表页结构：
 * - 属性全用**单引号**：`<a href='/read.php?tid=12754195' id='t_12754195' class='topic'>标题</a>`
 * - 版规/置顶帖在 `<div id='toptopics'>` 里，锚点**没有** `class='topic'`，靠这条就能滤掉；
 * - 真实帖子一律带 `class='topic'`（还有 row1/row2 的行容器类，那些不是锚点）。
 */
function parseHtml(html: string): RawItem[] {
  const out: RawItem[] = [];
  const seen = new Set<string>();
  const re = /<a\s([^>]{0,600}?)>([^<]{2,200})<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] ?? "";
    if (!/class=['"][^'"]*\btopic\b[^'"]*['"]/.test(attrs)) continue;
    const tid = /href=['"]\/read\.php\?tid=(\d+)/.exec(attrs)?.[1] ?? "";
    const rawTitle = m[2] ?? "";
    if (!tid || seen.has(tid)) continue;
    const title = cleanText(rawTitle, 200);
    if (!title || title.length < 2) continue;
    if (/^(回复|收藏|举报|引用|编辑|删除|更多)$/.test(title)) continue;
    seen.add(tid);
    out.push({
      externalId: tid,
      url: `https://bbs.nga.cn/read.php?tid=${tid}`,
      title,
      summary: null,
      publishedAt: null,
      tags: ["nga"],
      raw: { tid },
    });
  }
  return out;
}

/** 备通道：__output=11 的 JSON。NGA 用「紧凑对象」表示帖子，字段索引随版本变化，这里做结构探测。 */
function parseJson(body: string): RawItem[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    const idx = body.indexOf("{");
    if (idx < 0) return [];
    data = JSON.parse(body.slice(idx));
  }
  const root = data as { data?: { __T?: unknown; __U?: unknown } };
  const list = root?.data?.__T;
  if (!Array.isArray(list)) return [];

  const users = (root.data?.__U ?? {}) as Record<string, unknown>;
  const authorOf = (uid: unknown): string | null => {
    const key = String(uid ?? "");
    const u = users[key];
    if (u && typeof u === "object") {
      const name = (u as Record<string, unknown>)["username"] ?? (u as Record<string, unknown>)["1"];
      if (typeof name === "string" && name.trim()) return name.trim();
    }
    return null;
  };

  const out: RawItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const values = Object.values(obj);
    const tid = values.find((v) => typeof v === "number" && v > 1000) as number | undefined;
    const title = values
      .filter((v): v is string => typeof v === "string")
      .map((s) => cleanText(s, 200))
      .find((s) => s.length >= 4 && /[\u4e00-\u9fa5A-Za-z]/.test(s));
    if (!tid || !title) continue;
    const uid = obj["2"];
    const ts = values.find((v) => typeof v === "number" && v > 1_500_000_000 && v < 2_000_000_000) as number | undefined;
    out.push({
      externalId: String(tid),
      url: `https://bbs.nga.cn/read.php?tid=${tid}`,
      title,
      summary: null,
      author: authorOf(uid),
      publishedAt: ts ? new Date(ts * 1000).toISOString() : null,
      tags: ["nga"],
      raw: { tid, entry },
    });
  }
  return out;
}

export const ngaCollector: Collector = {
  kind: "nga",
  label: "NGA 玩家社区",
  defaults: { config: { fid: 570, pages: 1 } },
  async collect(ctx) {
    const cfg = ctx.config as Partial<NgaConfig>;
    const fid = Number(cfg.fid ?? 570);
    const pages = Math.min(Math.max(Number(cfg.pages ?? 1), 1), 3);
    const cookie = cookieHeader();

    const items: RawItem[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= pages; page += 1) {
      const url = baseUrl(fid, page);
      let ok = false;

      try {
        const res = await ctx.http.text(url, {
          headers: { cookie, referer: "https://bbs.nga.cn/" },
        });
        if (res.status === 403) throw new Error("403 访客不能直接访问（Cookie 未生效或已过期）");
        if (res.status !== 200) throw new Error("HTTP " + res.status);
        const html = parseHtml(res.body);
        if (html.length) {
          for (const it of html) {
            if (seen.has(it.externalId)) continue;
            seen.add(it.externalId);
            items.push(it);
          }
          ok = true;
          ctx.log(`fid=${fid} p${page} html ok:${html.length}`);
        }
      } catch (err) {
        problems.push(`p${page} html: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!ok) {
        try {
          const res = await ctx.http.text(`${url}&__output=11`, {
            headers: { cookie, referer: "https://bbs.nga.cn/" },
          });
          if (res.status === 403) throw new Error("403 访客不能直接访问（Cookie 未生效或已过期）");
          if (res.status !== 200) throw new Error("HTTP " + res.status);
          const parsed = parseJson(res.body);
          if (!parsed.length) throw new Error("JSON 中未解析到帖子");
          for (const it of parsed) {
            if (seen.has(it.externalId)) continue;
            seen.add(it.externalId);
            items.push(it);
          }
          ok = true;
          ctx.log(`fid=${fid} p${page} json ok:${parsed.length}`);
        } catch (err) {
          problems.push(`p${page} json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!ok) break;
    }

    if (!items.length) {
      throw new Error("NGA 采集失败: " + (problems.join("; ") || "无数据"));
    }

    const categoryHint = typeof cfg.categoryHint === "string" ? cfg.categoryHint : null;
    if (categoryHint) for (const it of items) it.categoryHint = categoryHint;

    return {
      items: items.slice(0, ctx.maxItems),
      cursor: null,
      degraded: problems.length ? problems.join("; ") : null,
    };
  },
};

/** 供测试与排错使用 */
export const __ngaInternals = { parseHtml, parseJson, baseUrl };
