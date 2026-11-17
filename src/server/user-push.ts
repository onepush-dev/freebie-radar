import { config } from "./config.ts";
import { all, get, run } from "./db.ts";
import { decryptSecret, encryptSecret, maskBotToken } from "./crypto.ts";
import { detectTelegramChatIds, sendTelegramWith, type DetectedChat } from "./telegram.ts";
import {
  DEFAULT_SETTINGS,
  getPushSettings,
  itemBlock,
  isQuietNow,
  parseAiMeta,
  passesPushFilters,
  planInstant,
  normalizeSettings,
  sourceLabel,
  type PushRoute,
  type PushSettings,
} from "./push.ts";
import { isBlocked, type BlockRule } from "./enrich/blocklist.ts";
import { TitleDeduper, type DedupeEntry } from "./enrich/index.ts";
import { matchesEntryNoise } from "./enrich/ai.ts";
import { URGENT, hasValueSignal } from "./enrich/noise.ts";
import type { FreshItem } from "./collectors/index.ts";
import { postWebhook as sendWebhook, validateWebhookUrl } from "./webhook.ts";

/* ------------------------------------------------------------------ *
 * 个人推送配置
 * ------------------------------------------------------------------ */

export type UserPushConfig = {
  enabled: boolean;
  hasToken: boolean;
  botTokenMask: string;
  chatId: string;
  settings: PushSettings;
  /** 是否继承全站基础噪音屏蔽词（默认开，用户可关） */
  useGlobalBlocks: boolean;
  dailyEnabled: boolean;
  consecutiveFails: number;
  lastError: string | null;
  lastFlushAt: string | null;
  lastPushedAt: string | null;
};

type ConfigRow = {
  user_id: number;
  enabled: number;
  bot_token_enc: string | null;
  bot_token_mask: string | null;
  chat_id: string;
  settings: string;
  use_global_blocks: number;
  daily_enabled: number;
  consecutive_fails: number;
  last_error: string | null;
  last_flush_at: string | null;
  last_pushed_at: string | null;
  updated_at: string;
};

function parseSettings(raw: string | null): PushSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<PushSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function rowToConfig(row: ConfigRow | undefined): UserPushConfig {
  if (!row) {
    return {
      enabled: false,
      hasToken: false,
      botTokenMask: "",
      chatId: "",
      settings: { ...DEFAULT_SETTINGS },
      useGlobalBlocks: true,
      dailyEnabled: false,
      consecutiveFails: 0,
      lastError: null,
      lastFlushAt: null,
      lastPushedAt: null,
    };
  }
  return {
    enabled: row.enabled === 1,
    hasToken: Boolean(row.bot_token_enc),
    botTokenMask: row.bot_token_mask ?? "",
    chatId: row.chat_id ?? "",
    settings: parseSettings(row.settings),
    useGlobalBlocks: row.use_global_blocks === 1,
    dailyEnabled: row.daily_enabled === 1,
    consecutiveFails: row.consecutive_fails,
    lastError: row.last_error,
    lastFlushAt: row.last_flush_at,
    lastPushedAt: row.last_pushed_at,
  };
}

export function getUserPushConfig(userId: number): UserPushConfig {
  const row = get<ConfigRow>("SELECT * FROM user_push_configs WHERE user_id = ?", userId);
  return rowToConfig(row);
}

/** 解密个人 Bot Token；失败视为未配置（密钥换过），不把错误抛给调用方 */
export function resolveUserBotToken(userId: number): string | null {
  const row = get<{ bot_token_enc: string | null }>("SELECT bot_token_enc FROM user_push_configs WHERE user_id = ?", userId);
  if (!row?.bot_token_enc) return null;
  try {
    return decryptSecret(row.bot_token_enc);
  } catch {
    console.warn("[user-push] 用户", userId, "的 Bot Token 无法解密，已视为未配置");
    return null;
  }
}

export type UserPushPatch = Partial<PushSettings> & {
  enabled?: boolean;
  botToken?: string;
  clearToken?: boolean;
  chatId?: string;
  useGlobalBlocks?: boolean;
  dailyEnabled?: boolean;
};

export function saveUserPushConfig(userId: number, patch: UserPushPatch): UserPushConfig {
  const cur = getUserPushConfig(userId);
  const now = new Date().toISOString();
  const nextSettings = normalizeSettings(patch, cur.settings);
  if (nextSettings.webhookUrl) validateWebhookUrl(nextSettings.webhookUrl);
  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(nextSettings.quietHours) ||
      nextSettings.quietHours.split("-").some((part) => Number(part.slice(0, 2)) > 23 || Number(part.slice(3)) > 59)) {
    throw new Error("免打扰时段格式应为 HH:MM-HH:MM");
  }
  try { new Intl.DateTimeFormat("en", { timeZone: nextSettings.timezone }); } catch { throw new Error("时区无效"); }
  // 阈值联动与上限夹紧，防止用户填出「攒批阈值 > 即时阈值」这种自相矛盾
  const instantScore = clampNum(nextSettings.instantScore, 0, 100, cur.settings.instantScore);
  const batchScore = Math.min(clampNum(nextSettings.batchScore, 0, 100, cur.settings.batchScore), instantScore);
  nextSettings.instantScore = instantScore;
  nextSettings.batchScore = batchScore;
  nextSettings.maxPerHour = clampNum(nextSettings.maxPerHour, 1, config.userPushMaxPerHour, cur.settings.maxPerHour);
  nextSettings.maxPerInstant = clampNum(nextSettings.maxPerInstant, 1, config.userPushMaxPerInstant, cur.settings.maxPerInstant);
  nextSettings.batchIntervalMin = clampNum(nextSettings.batchIntervalMin, 0, 720, cur.settings.batchIntervalMin);
  nextSettings.maxPerBatch = clampNum(nextSettings.maxPerBatch, 1, 20, cur.settings.maxPerBatch);

  let enc = get<{ bot_token_enc: string | null }>("SELECT bot_token_enc FROM user_push_configs WHERE user_id = ?", userId)?.bot_token_enc ?? null;
  let mask = cur.botTokenMask;
  if (patch.clearToken) {
    enc = null;
    mask = "";
  } else if (typeof patch.botToken === "string" && patch.botToken.trim()) {
    const token = patch.botToken.trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Bot Token 格式不对（形如 123456789:AAxxxx）");
    enc = encryptSecret(token);
    mask = maskBotToken(token);
  }

  const enabled = typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled;
  const chatId = typeof patch.chatId === "string" ? patch.chatId.trim().slice(0, 64) : cur.chatId;
  const useGlobalBlocks = typeof patch.useGlobalBlocks === "boolean" ? patch.useGlobalBlocks : cur.useGlobalBlocks;
  const dailyEnabled = typeof patch.dailyEnabled === "boolean" ? patch.dailyEnabled : cur.dailyEnabled;
  const ready = nextSettings.deliverVia === "webhook" ? Boolean(nextSettings.webhookUrl) : Boolean(enc) && Boolean(chatId);
  if (enabled && !ready) throw new Error(nextSettings.deliverVia === "webhook" ? "请先保存 Webhook 地址再开启推送" : "请先保存 Bot Token 与 Chat ID 再开启推送");
  nextSettings.enabled = enabled;

  run(
    `INSERT INTO user_push_configs
       (user_id, enabled, bot_token_enc, bot_token_mask, chat_id, settings, use_global_blocks, daily_enabled,
        consecutive_fails, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       bot_token_enc = excluded.bot_token_enc,
       bot_token_mask = excluded.bot_token_mask,
       chat_id = excluded.chat_id,
       settings = excluded.settings,
       use_global_blocks = excluded.use_global_blocks,
       daily_enabled = excluded.daily_enabled,
       consecutive_fails = CASE WHEN excluded.bot_token_enc IS NOT NULL THEN 0 ELSE user_push_configs.consecutive_fails END,
       updated_at = excluded.updated_at`,
    userId,
    enabled && ready ? 1 : 0,
    enc,
    mask,
    chatId,
    JSON.stringify(nextSettings),
    useGlobalBlocks ? 1 : 0,
    dailyEnabled ? 1 : 0,
    now,
  );
  return getUserPushConfig(userId);
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/* ------------------------------------------------------------------ *
 * 个人屏蔽词 / 关注词
 * ------------------------------------------------------------------ */

export function loadUserBlockRules(userId: number, includeGlobal: boolean): BlockRule[] {
  const own = all<BlockRule>(
    "SELECT id, pattern, mode, scope, enabled, created_at FROM user_block_rules WHERE user_id = ? AND enabled = 1 ORDER BY id",
    userId,
  ).filter((r) => r.mode !== "regex");
  if (!includeGlobal) return own;
  const global = all<BlockRule>(
    "SELECT id, pattern, mode, scope, enabled, created_at FROM block_rules WHERE enabled = 1 ORDER BY id",
  );
  // 全局规则的 id 可能与个人规则撞号，加偏移避免正则缓存/去重键串台
  return [...global.map((r) => ({ ...r, id: r.id + 1_000_000 })), ...own];
}

export function loadUserSubscriptions(userId: number): string[] {
  return all<{ keyword: string }>("SELECT keyword FROM user_subscriptions WHERE user_id = ? ORDER BY keyword", userId).map(
    (r) => r.keyword,
  );
}

/* ------------------------------------------------------------------ *
 * 送达记录
 * ------------------------------------------------------------------ */

type DeliveryStatus = "queued" | "sent" | "failed";

function recordDelivery(userId: number, itemId: number, status: DeliveryStatus, titleKey: string | null, reason: string, routeName: string | null): boolean {
  const now = new Date().toISOString();
  const res = run(
    `INSERT INTO user_push_deliveries (user_id, item_id, title_key, status, reason, route_name, queued_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, item_id) DO NOTHING`,
    userId,
    itemId,
    titleKey,
    status,
    reason,
    routeName,
    now,
    status === "sent" ? now : null,
  );
  return Number(res.changes) > 0;
}

function markSent(userId: number, itemIds: readonly number[]): void {
  if (!itemIds.length) return;
  const now = new Date().toISOString();
  const ph = itemIds.map(() => "?").join(",");
  run(
    `UPDATE user_push_deliveries SET status = 'sent', sent_at = ? WHERE user_id = ? AND item_id IN (${ph})`,
    now,
    userId,
    ...itemIds,
  );
  run("UPDATE user_push_configs SET last_pushed_at = ? WHERE user_id = ?", now, userId);
}

function sentLastHour(userId: number): number {
  return (
    get<{ n: number }>(
      `SELECT
         (SELECT COUNT(*) FROM user_push_deliveries WHERE user_id = ? AND status = 'sent' AND sent_at >= ?) +
         COALESCE((SELECT SUM(count) FROM user_push_logs WHERE user_id = ? AND kind = 'daily' AND ok = 1 AND created_at >= ?), 0) AS n`,
      userId,
      new Date(Date.now() - 3_600_000).toISOString(),
      userId,
      new Date(Date.now() - 3_600_000).toISOString(),
    )?.n ?? 0
  );
}

function recentUserSeeds(userId: number, includeQueued = true): DedupeEntry[] {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = all<{ title: string; canonical_id: number | null }>(
    `SELECT i.title AS title, i.canonical_id AS canonical_id
       FROM user_push_deliveries d JOIN items i ON i.id = d.item_id
      WHERE d.user_id = ? AND d.queued_at >= ? ${includeQueued ? "" : "AND d.status = 'sent'"}`,
    userId,
    since,
  );
  return rows.map((r) => ({ title: r.title, canonicalId: r.canonical_id ?? null }));
}

/* ------------------------------------------------------------------ *
 * 启用中的用户
 * ------------------------------------------------------------------ */

type ActiveUser = { userId: number; settings: PushSettings; chatId: string; token: string; useGlobalBlocks: boolean; via: "telegram" | "webhook" };

function activeUsers(userId?: number): ActiveUser[] {
  const rows = all<ConfigRow>(
    "SELECT c.* FROM user_push_configs c JOIN users u ON u.id = c.user_id WHERE c.enabled = 1 AND u.disabled = 0" + (userId === undefined ? "" : " AND c.user_id = ?"),
    ...(userId === undefined ? [] : [userId]),
  );
  const out: ActiveUser[] = [];
  for (const row of rows) {
    const settings = parseSettings(row.settings);
    const via: "telegram" | "webhook" = settings.deliverVia === "webhook" ? "webhook" : "telegram";
    if (via === "webhook") {
      if (!settings.webhookUrl) continue;
      out.push({ userId: row.user_id, settings, chatId: "", token: "", useGlobalBlocks: row.use_global_blocks === 1, via });
      continue;
    }
    if (!row.bot_token_enc || !row.chat_id) continue;
    const token = resolveUserBotToken(row.user_id);
    if (!token) continue;
    out.push({
      userId: row.user_id,
      settings,
      chatId: row.chat_id,
      token,
      useGlobalBlocks: row.use_global_blocks === 1,
      via,
    });
  }
  return out;
}

/** 采集侧用它决定「就算全局 Bot 没配，也要跑推送链路」 */
export function hasEnabledUserPush(): boolean {
  return (get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_configs WHERE enabled = 1")?.n ?? 0) > 0;
}

export function enabledUserPushCount(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_configs WHERE enabled = 1")?.n ?? 0;
}

/* ------------------------------------------------------------------ *
 * 单用户判定（与全局 decide 同口径，但用个人设置与个人规则）
 * ------------------------------------------------------------------ */

type UserDecision = { push: boolean; reason: string; urgent: boolean; route: PushRoute | null };

function matchUserSubscriptions(item: { title: string; summary?: string | null }, keywords: string[]): string[] {
  if (!keywords.length) return [];
  const text = (item.title + " " + (item.summary ?? "")).toLowerCase();
  return keywords.filter((k) => text.includes(k.toLowerCase()));
}

function matchRoute(item: FreshItem & { sourceId: string }, routes: PushRoute[]): PushRoute | null {
  const enabled = routes.filter((r) => r.enabled);
  if (!enabled.length) return null;
  const hay = (item.title + " " + (item.summary ?? "")).toLowerCase();
  for (const r of enabled) {
    if (r.kinds.length && !r.kinds.includes(item.kind ?? "freebie")) continue;
    if (r.categories.length && !r.categories.includes(item.category ?? "")) continue;
    if (r.obtainModes.length && !r.obtainModes.includes(item.obtain ?? "free")) continue;
    if (r.keywords.length && !r.keywords.some((kw) => hay.includes(kw.toLowerCase()))) continue;
    if (item.score < r.minScore) continue;
    return r;
  }
  return null;
}

function decideForUser(item: FreshItem, s: PushSettings, subHits: string[], route: PushRoute | null): UserDecision {
  if (matchesEntryNoise(item.title)) return { push: false, reason: "", urgent: false, route };
  if (s.aiFallbackMode !== "ignore_ai" && (item.aiKeep === false || item.kind === "noise")) {
    return { push: false, reason: "", urgent: false, route };
  }
  const routeTag = route ? `[${route.name}] ` : "";
  if (route && !route.instant) return { push: false, reason: "", urgent: false, route };
  if (s.prioritizeSubscribed && subHits.length > 0) {
    return { push: true, reason: routeTag + "订阅命中：" + subHits.join("/"), urgent: true, route };
  }
  if (s.instantOnCodes && item.codes.length > 0) return { push: true, reason: routeTag + "含兑换码", urgent: true, route };
  if (s.instantOnUrgent && URGENT.test(item.title) && item.score >= 40) {
    return { push: true, reason: routeTag + "限量/限时", urgent: true, route };
  }
  const gate = route ? Math.max(s.instantScore, route.minScore) : s.instantScore;
  if (item.score >= gate) return { push: true, reason: routeTag + "高分 " + Math.round(item.score), urgent: false, route };
  return { push: false, reason: "", urgent: false, route };
}

function canBatchForUser(item: FreshItem, s: PushSettings, d: UserDecision): boolean {
  if (matchesEntryNoise(item.title)) return false;
  if (s.aiFallbackMode !== "ignore_ai" && (item.aiKeep === false || item.kind === "noise")) return false;
  const hasSignal = item.aiKeep === true || hasValueSignal(item.title, item.kind);
  if (!hasSignal && !d.push) return false;
  const gate = d.route ? d.route.minScore : s.batchScore;
  return item.score >= gate || d.push;
}

/* ------------------------------------------------------------------ *
 * 发送
 * ------------------------------------------------------------------ */

/**
 * 通用 webhook 投递：POST JSON。
 * 之所以做这个而不是「QQ 官方 Bot 推送」——QQ 官方机器人只允许被动回复（同一条 msg_id 最多回 5 条），
 * 没有可用的主动推送通道；要推到 QQ 得靠 NapCat / Lagrange 这类 OneBot 实现，它们正好提供 HTTP 接口，
 * 所以 webhook 才是能真正落地的路子（顺带覆盖 Bark / 飞书 / 钉钉 / Slack / 自建）。
 */
async function postWebhook(settings: PushSettings, text: string): Promise<void> {
  await sendWebhook(settings.webhookUrl, text, settings.webhookSecret);
}
async function sendToUser(user: ActiveUser, text: string): Promise<void> {
  try {
    if (user.via === "webhook") {
      await postWebhook(user.settings, text);
    } else {
      await sendTelegramWith({ botToken: user.token, chatId: user.chatId }, text);
    }
    run("UPDATE user_push_configs SET consecutive_fails = 0, last_error = NULL WHERE user_id = ?", user.userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fails = (get<{ n: number }>("SELECT consecutive_fails AS n FROM user_push_configs WHERE user_id = ?", user.userId)?.n ?? 0) + 1;
    // 连续 3 次失败（token 失效 / chat_id 填错 / 被拉黑）就自动停用，避免每轮都白跑
    const disable = fails >= 3;
    run(
      "UPDATE user_push_configs SET consecutive_fails = ?, last_error = ?, enabled = CASE WHEN ? THEN 0 ELSE enabled END WHERE user_id = ?",
      fails,
      msg.slice(0, 300),
      disable ? 1 : 0,
      user.userId,
    );
    if (disable) console.warn(`[user-push] 用户 ${user.userId} 连续 ${fails} 次发送失败，已自动停用个人推送`);
    throw err;
  }
}

function logUserPush(userId: number, kind: string, itemIds: number[], text: string, ok: boolean, error: string | null, reason: string | null): void {
  run(
    "INSERT INTO user_push_logs (user_id, kind, item_ids, text, count, ok, error, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    userId,
    kind,
    JSON.stringify(itemIds),
    text.slice(0, 4000),
    itemIds.length,
    ok ? 1 : 0,
    error,
    reason,
    new Date().toISOString(),
  );
}

function userPrefix(route: PushRoute | null, s: PushSettings, fallback: string): string {
  if (route?.header) return route.header + " · ";
  if (s.customHeader) return s.customHeader + " · ";
  return fallback;
}

/* ------------------------------------------------------------------ *
 * 派发：新条目进来时按每个用户的规则分流
 * ------------------------------------------------------------------ */

export async function dispatchUserPush(sourceId: string, fresh: FreshItem[]): Promise<number> {
  if (!fresh.length) return 0;
  const users = activeUsers();
  if (!users.length) return 0;

  let totalSent = 0;
  const batchSize = 3;
  for (let i = 0; i < users.length; i += batchSize) {
    const slice = users.slice(i, i + batchSize);
    const results = await Promise.allSettled(slice.map((u) => withDeliveryLock(u.userId, () => dispatchForUser(u, sourceId, fresh))));
    for (const r of results) if (r.status === "fulfilled") totalSent += r.value;
  }
  return totalSent;
}

async function dispatchForUser(user: ActiveUser, sourceId: string, fresh: FreshItem[]): Promise<number> {
  const s = user.settings;
  if (!s.enabled) return 0;
  const rules = loadUserBlockRules(user.userId, user.useGlobalBlocks);
  const subKeywords = loadUserSubscriptions(user.userId);
  const hasRoutes = s.routes?.some((r) => r.enabled);
  const hidden = new Set(all<{ item_id: number }>("SELECT item_id FROM user_item_states WHERE user_id = ? AND hidden = 1", user.userId).map((r) => r.item_id));

  const candidates = fresh
    .filter((it) => !hidden.has(it.id))
    .filter((it) => !isBlocked({ ...it, sourceId }, rules))
    .filter((it) => passesPushFilters({ ...it, sourceId }, s));
  if (!candidates.length) return 0;

  const deduper = s.dedupeByTitle ? new TitleDeduper(candidates, recentUserSeeds(user.userId, true)) : null;
  const quiet = isQuietNow(s);

  const instant: { it: FreshItem; reason: string; subHits: string[]; route: PushRoute | null }[] = [];
  const batched: { it: FreshItem; reason: string; subHits: string[]; route: PushRoute | null }[] = [];

  for (const it of candidates) {
    if (deduper?.isDuplicate(it)) continue;
    const subHits = matchUserSubscriptions(it, subKeywords);
    const route = hasRoutes ? matchRoute({ ...it, sourceId }, s.routes) : null;
    if (hasRoutes && !route) continue;
    const d = decideForUser(it, s, subHits, route);
    if (d.push && !quiet) {
      instant.push({ it, reason: d.reason, subHits, route });
      deduper?.markSeen(it);
      continue;
    }
    if (quiet && s.quietAction === "drop") continue;
    if (canBatchForUser(it, s, d)) {
      batched.push({ it, reason: d.reason || (route ? `[${route.name}] ` : "") + "达到攒批高分", subHits, route });
      deduper?.markSeen(it);
    }
  }

  // 入队：deliveries 的唯一键天然去重，同一用户同一条只会进一次
  for (const b of batched) {
    if (recordDelivery(user.userId, b.it.id, "queued", null, b.reason, b.route?.name ?? null)) {
      // 只记录，不发送
    }
  }

  if (!instant.length) return 0;

  const used = sentLastHour(user.userId);
  const plan = planInstant(instant.length, s, used);
  const picked = instant.slice(0, plan.send);
  const overflow = instant.slice(plan.send);
  for (const o of overflow) {
    recordDelivery(user.userId, o.it.id, "queued", null, o.reason, o.route?.name ?? null);
  }

  let sent = 0;
  for (const { it, reason, subHits, route } of picked) {
    if (!recordDelivery(user.userId, it.id, "queued", null, reason, route?.name ?? null)) continue;
    const text = [userPrefix(route, s, "⚡ 新动态 · ") + reason, "", ...itemBlock(sourceId, it, s, undefined, subHits)].join("\n");
    try {
      await sendToUser(user, text);
      markSent(user.userId, [it.id]);
      logUserPush(user.userId, "instant", [it.id], text, true, null, reason);
      sent += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logUserPush(user.userId, "instant", [it.id], text, false, msg, reason);
      break;
    }
  }
  if (sent) console.log(`[user-push] 用户 ${user.userId} 即时推送 ${sent} 条（来源 ${sourceLabel(sourceId)}）`);
  return sent;
}

/* ------------------------------------------------------------------ *
 * 攒批冲刷
 * ------------------------------------------------------------------ */

export async function flushUserBatches(force = false, userId?: number): Promise<number> {
  const users = activeUsers(userId);
  if (!users.length) return 0;
  let total = 0;
  for (const user of users) {
    try {
      total += await flushUserLocked(user, force);
    } catch (err) {
      console.error("[user-push] 冲刷失败:", err instanceof Error ? err.message : err);
    }
  }
  return total;
}

const deliveries = new Map<number, Promise<void>>();
async function withDeliveryLock<T>(userId: number, operation: () => Promise<T>): Promise<T> {
  const previous = deliveries.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.then(() => barrier);
  deliveries.set(userId, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (deliveries.get(userId) === current) deliveries.delete(userId); }
}
async function flushUserLocked(user: ActiveUser, force: boolean): Promise<number> {
  return withDeliveryLock(user.userId, () => flushOneUser(user, force));
}

async function flushOneUser(user: ActiveUser, force: boolean): Promise<number> {
  const s = user.settings;
  if (!s.enabled) return 0;
  if (!force && isQuietNow(s)) return 0;
  if (!force) {
    if (!s.batchIntervalMin) return 0;
    const last = get<{ last_flush_at: string | null }>("SELECT last_flush_at FROM user_push_configs WHERE user_id = ?", user.userId)?.last_flush_at;
    if (last && Date.now() - Date.parse(last) < s.batchIntervalMin * 60_000) return 0;
  }

  const budget = Math.max(0, s.maxPerHour - sentLastHour(user.userId));
  if (!budget) return 0;

  const rows = all<{ id: number; item_id: number; reason: string | null; route_name: string | null }>(
    "SELECT id, item_id, reason, route_name FROM user_push_deliveries WHERE user_id = ? AND status = 'queued' ORDER BY queued_at ASC LIMIT ?",
    user.userId,
    Math.min(s.maxPerBatch, budget),
  );
  if (!rows.length) return 0;

  const ids = rows.map((r) => r.item_id);
  const ph = ids.map(() => "?").join(",");
  const dbRows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    published_at: string | null;
    status: string;
    ai: string | null;
    canonical_id: number | null;
  }>(
    `SELECT id, source_id, title, summary, url, category, kind, score, codes, price, is_free, obtain,
            expires_at, published_at, status, ai, canonical_id
       FROM items WHERE id IN (${ph})`,
    ...ids,
  );
  const byId = new Map(dbRows.map((r) => [r.id, r]));
  const hidden = new Set(all<{ item_id: number }>(
    `SELECT item_id FROM user_item_states WHERE user_id = ? AND hidden = 1 AND item_id IN (${ph})`, user.userId, ...ids,
  ).map((r) => r.item_id));

  const rules = loadUserBlockRules(user.userId, user.useGlobalBlocks);
  const subKeywords = loadUserSubscriptions(user.userId);
  const hasRoutes = s.routes?.some((r) => r.enabled);

  // 二次回查：队列等待期间被关闭 / 加了屏蔽词 / AI 改判的，一律不发
  const picked: { row: (typeof dbRows)[number]; item: FreshItem; subHits: string[]; route: PushRoute | null; reason: string }[] = [];
  for (const q of rows) {
    const r = byId.get(q.item_id);
    if (!r || r.status !== "active" || hidden.has(r.id)) continue;
    if (isBlocked(r, rules)) continue;
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const ai = parseAiMeta(r.ai);
    const item: FreshItem = {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: ai.aiKeep,
      aiReason: ai.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      canonicalId: r.canonical_id,
    };
    if (!passesPushFilters({ ...item, sourceId: r.source_id }, s)) continue;
    const subHits = matchUserSubscriptions(item, subKeywords);
    const route = hasRoutes ? matchRoute({ ...item, sourceId: r.source_id }, s.routes) : null;
    if (hasRoutes && !route) continue;
    picked.push({ row: r, item, subHits, route, reason: q.reason ?? "攒批汇总" });
  }
  const pickedIds = new Set(picked.map((p) => p.item.id));
  for (const q of rows) {
    if (!pickedIds.has(q.item_id)) run("UPDATE user_push_deliveries SET status = 'failed' WHERE id = ?", q.id);
  }
  if (!picked.length) {
    // 全被过滤掉：标记为 failed，避免永远卡在队列里
    for (const q of rows) {
      run("UPDATE user_push_deliveries SET status = 'failed' WHERE id = ?", q.id);
    }
    return 0;
  }

  const header = picked[0]!.route?.header ?? s.customHeader ?? "📦 资源雷达 · 攒批汇总";
  const lines: string[] = [`${header}（${picked.length} 条）`];
  picked.forEach((p, i) => {
    lines.push("");
    lines.push(...itemBlock(p.row.source_id, p.item, s, i + 1, p.subHits));
  });
  const text = lines.join("\n");

  try {
    await sendToUser(user, text);
    markSent(user.userId, picked.map((p) => p.item.id));
    logUserPush(user.userId, "batch", picked.map((p) => p.item.id), text, true, null, null);
    run("UPDATE user_push_configs SET last_flush_at = ? WHERE user_id = ?", new Date().toISOString(), user.userId);
    console.log(`[user-push] 用户 ${user.userId} 攒批推送 ${picked.length} 条`);
    return picked.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logUserPush(user.userId, "batch", picked.map((p) => p.item.id), text, false, msg, null);
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * 个人日报
 * ------------------------------------------------------------------ */

export async function pushUserDaily(): Promise<number> {
  const rows = all<ConfigRow>("SELECT c.* FROM user_push_configs c JOIN users u ON u.id = c.user_id WHERE c.enabled = 1 AND c.daily_enabled = 1 AND u.disabled = 0");
  let sent = 0;
  for (const row of rows) {
    const settings = parseSettings(row.settings);
    const via: "telegram" | "webhook" = settings.deliverVia === "webhook" ? "webhook" : "telegram";
    const token = via === "webhook" ? "" : (resolveUserBotToken(row.user_id) ?? "");
    if (via === "webhook" ? !settings.webhookUrl : !token || !row.chat_id) continue;
    const user: ActiveUser = {
      userId: row.user_id,
      settings,
      chatId: row.chat_id,
      token,
      useGlobalBlocks: row.use_global_blocks === 1,
      via,
    };
    try {
      const n = await withDeliveryLock(user.userId, () => sendDailyDigest(user));
      sent += n;
    } catch (err) {
      console.error("[user-push] 个人日报失败:", err instanceof Error ? err.message : err);
    }
  }
  return sent;
}

async function sendDailyDigest(user: ActiveUser): Promise<number> {
  const s = user.settings;
  const budget = Math.max(0, s.maxPerHour - sentLastHour(user.userId));
  if (!s.enabled || !budget) return 0;
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const rows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    published_at: string | null;
    ai: string | null;
    canonical_id: number | null;
  }>(
    `SELECT id, source_id, title, summary, url, category, kind, score, codes, price, is_free, obtain,
            expires_at, published_at, ai, canonical_id
       FROM items
      WHERE status = 'active' AND COALESCE(published_at, first_seen_at) >= ?
      ORDER BY score DESC LIMIT 120`,
    since,
  );
  const rules = loadUserBlockRules(user.userId, user.useGlobalBlocks);
  const subKeywords = loadUserSubscriptions(user.userId);
  const hidden = new Set(all<{ item_id: number }>("SELECT item_id FROM user_item_states WHERE user_id = ? AND hidden = 1", user.userId).map((r) => r.item_id));
  const items: { row: (typeof rows)[number]; item: FreshItem; subHits: string[] }[] = [];
  for (const r of rows) {
    if (hidden.has(r.id)) continue;
    if (isBlocked(r, rules)) continue;
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const ai = parseAiMeta(r.ai);
    const item: FreshItem = {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: ai.aiKeep,
      aiReason: ai.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      canonicalId: r.canonical_id,
    };
    if (!passesPushFilters({ ...item, sourceId: r.source_id }, s)) continue;
    items.push({ row: r, item, subHits: matchUserSubscriptions(item, subKeywords) });
    if (items.length >= Math.min(12, budget)) break;
  }
  if (!items.length) return 0;
  const lines = [`📰 资源雷达 · 个人日报（${new Date().toISOString().slice(0, 10)}，${items.length} 条）`];
  items.forEach((p, i) => {
    lines.push("");
    lines.push(...itemBlock(p.row.source_id, p.item, s, i + 1, p.subHits));
  });
  const text = lines.join("\n");
  try {
    await sendToUser(user, text);
    logUserPush(user.userId, "daily", items.map((p) => p.item.id), text, true, null, null);
    return 1;
  } catch (err) {
    logUserPush(user.userId, "daily", items.map((p) => p.item.id), text, false, err instanceof Error ? err.message : String(err), null);
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * 调度与查询
 * ------------------------------------------------------------------ */

let userFlushTimer: NodeJS.Timeout | null = null;
let userSchedulerStarted = false;

export function startUserPushScheduler(): void {
  userSchedulerStarted = true;
  scheduleUserFlush();
}

function scheduleUserFlush(): void {
  if (userFlushTimer) return;
  // 个人攒批周期各不相同，统一用 1 分钟粒度轮询，按各自 batchIntervalMin 判断是否该发
  userFlushTimer = setInterval(() => {
    void tickUserFlush();
  }, 60_000);
  userFlushTimer.unref?.();
}

let lastUserFlushAt = 0;

async function tickUserFlush(): Promise<void> {
  if (!userSchedulerStarted) return;
  // 至少隔 5 分钟才真正跑一轮，避免 1 分钟粒度把出口打满
  if (Date.now() - lastUserFlushAt < 5 * 60_000) return;
  lastUserFlushAt = Date.now();
  try {
    await flushUserBatches(false);
  } catch (err) {
    console.error("[user-push] 定时冲刷失败:", err instanceof Error ? err.message : err);
  }
}

export function userPushStats(userId: number): {
  queued: number;
  sentLast24h: number;
  sentLastHour: number;
  totalSent: number;
  failures: number;
  lastError: string | null;
  // 与全局 /api/push 的 stats 字段对齐，让同一套推送面板能直接复用
  pushedLastHour: number;
  pushedLast24h: number;
  totalPushed: number;
  lastHourLogs: number;
} {
  const cfg = getUserPushConfig(userId);
  const queued =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_deliveries WHERE user_id = ? AND status = 'queued'", userId)?.n ?? 0;
  const sent24 =
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM user_push_deliveries WHERE user_id = ? AND status = 'sent' AND sent_at >= ?",
      userId,
      new Date(Date.now() - 86_400_000).toISOString(),
    )?.n ?? 0;
  const daily24 = get<{ n: number }>("SELECT COALESCE(SUM(count),0) AS n FROM user_push_logs WHERE user_id = ? AND kind = 'daily' AND ok = 1 AND created_at >= ?", userId, new Date(Date.now() - 86_400_000).toISOString())?.n ?? 0;
  const sentHour = sentLastHour(userId);
  const total =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_deliveries WHERE user_id = ? AND status = 'sent'", userId)?.n ?? 0;
  const dailyTotal = get<{ n: number }>("SELECT COALESCE(SUM(count),0) AS n FROM user_push_logs WHERE user_id = ? AND kind = 'daily' AND ok = 1", userId)?.n ?? 0;
  return {
    queued,
    sentLast24h: sent24 + daily24,
    sentLastHour: sentHour,
    totalSent: total + dailyTotal,
    failures:
      get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_logs WHERE user_id = ? AND ok = 0", userId)?.n ?? 0,
    lastError: cfg.lastError,
    pushedLastHour: sentHour,
    pushedLast24h: sent24 + daily24,
    totalPushed: total + dailyTotal,
    lastHourLogs:
      get<{ n: number }>("SELECT COUNT(*) AS n FROM user_push_logs WHERE user_id = ? AND created_at >= ?", userId, new Date(Date.now() - 3_600_000).toISOString())?.n ?? 0,
  };
}

export function userPushLogs(userId: number, limit = 30): Array<{
  id: number;
  kind: string;
  item_ids: string;
  text: string;
  count: number;
  ok: number;
  error: string | null;
  reason: string | null;
  created_at: string;
}> {
  return all(
    "SELECT id, kind, item_ids, text, count, ok, error, reason, created_at FROM user_push_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    userId,
    Math.min(Math.max(limit, 1), 100),
  );
}

/** 试算：用个人规则扫最近 180 条，返回会被推/被拦的原因分布 */
export function previewUserPush(userId: number, limit = 6): {
  instant: string[];
  batch: string[];
  scanned: number;
  matched: number;
  rejectedBy: Record<string, number>;
  queued: number;
  instantTotal: number;
  sendableInstant: number;
  batchTotal: number;
  deferred: number;
  usedThisHour: number;
  caps: { maxPerInstant: number; maxPerHour: number; maxPerBatch: number; batchIntervalMin: number; budget: number };
} {
  const cfg = getUserPushConfig(userId);
  const s = cfg.settings;
  const rules = loadUserBlockRules(userId, cfg.useGlobalBlocks);
  const subKeywords = loadUserSubscriptions(userId);
  const rows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    published_at: string | null;
    ai: string | null;
    canonical_id: number | null;
  }>(
    `SELECT id, source_id, title, summary, url, category, kind, score, codes, price, is_free, obtain,
            expires_at, published_at, ai, canonical_id
       FROM items WHERE status = 'active' AND NOT EXISTS (
         SELECT 1 FROM user_push_deliveries d WHERE d.user_id = ? AND d.item_id = items.id AND d.status = 'sent'
       ) ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT 180`,
    userId,
  );
  const rejectedBy: Record<string, number> = {};
  const instant: string[] = [];
  const batch: string[] = [];
  let matched = 0;
  const hasRoutes = s.routes?.some((r) => r.enabled);
  const hidden = new Set(all<{ item_id: number }>("SELECT item_id FROM user_item_states WHERE user_id = ? AND hidden = 1", userId).map((r) => r.item_id));
  const deduper = s.dedupeByTitle
    ? new TitleDeduper(
        rows.map((r) => ({ title: r.title, canonicalId: r.canonical_id ?? null })),
        recentUserSeeds(userId, true),
      )
    : null;

  for (const r of rows) {
    if (hidden.has(r.id)) { rejectedBy.hidden = (rejectedBy.hidden ?? 0) + 1; continue; }
    if (isBlocked(r, rules)) {
      rejectedBy.blocked = (rejectedBy.blocked ?? 0) + 1;
      continue;
    }
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const ai = parseAiMeta(r.ai);
    const item: FreshItem = {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: ai.aiKeep,
      aiReason: ai.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      canonicalId: r.canonical_id,
    };
    const reason = checkReason({ ...item, sourceId: r.source_id }, s);
    if (reason) {
      rejectedBy[reason] = (rejectedBy[reason] ?? 0) + 1;
      continue;
    }
    if (deduper?.isDuplicate({ title: item.title, canonicalId: item.canonicalId ?? null })) {
      rejectedBy.duplicate = (rejectedBy.duplicate ?? 0) + 1;
      continue;
    }
    deduper?.markSeen({ title: item.title, canonicalId: item.canonicalId ?? null });
    matched += 1;
    const subHits = matchUserSubscriptions(item, subKeywords);
    const route = hasRoutes ? matchRoute({ ...item, sourceId: r.source_id }, s.routes) : null;
    if (hasRoutes && !route) { rejectedBy.route = (rejectedBy.route ?? 0) + 1; continue; }
    const d = decideForUser(item, s, subHits, route);
    const line = `[${sourceLabel(r.source_id)}] ${r.title.slice(0, 60)} · ${Math.round(r.score)} 分`;
    if (d.push) instant.push(line);
    else if (canBatchForUser(item, s, d)) batch.push(line);
  }
  const used = sentLastHour(userId);
  const plan = planInstant(instant.length, s, used);
  const quiet = isQuietNow(s);
  const sendable = quiet ? 0 : plan.send;
  const overflow = instant.slice(sendable);
  const batched = s.batchIntervalMin > 0 && !(quiet && s.quietAction === "drop") ? [...batch, ...overflow] : [];
  return {
    instant: instant.slice(0, sendable).slice(0, limit),
    batch: batched.slice(0, limit),
    scanned: rows.length,
    matched,
    rejectedBy,
    queued: userPushStats(userId).queued,
    instantTotal: instant.length,
    sendableInstant: sendable,
    batchTotal: batched.length,
    deferred: overflow.length,
    usedThisHour: used,
    caps: { maxPerInstant: s.maxPerInstant, maxPerHour: s.maxPerHour, maxPerBatch: s.maxPerBatch, batchIntervalMin: s.batchIntervalMin, budget: Math.max(0, s.maxPerHour - used) },
  };
}

function checkReason(item: FreshItem & { sourceId: string }, s: PushSettings): string | null {
  if (!passesPushFilters(item, s)) {
    // 复用全局判定后做一次「为什么」的粗分类，够前端展示即可
    if (!s.enabled) return "disabled";
    return "filtered";
  }
  return null;
}

export type { DetectedChat };
export { detectTelegramChatIds };

/** 给某个用户发一条任意文本（测试消息用），凭据缺失时抛错 */
export async function sendTelegramToUser(userId: number, text: string): Promise<void> {
  const settings = getUserPushConfig(userId).settings;
  if (settings.deliverVia === "webhook") {
    if (!settings.webhookUrl) throw new Error("请先保存 webhook 地址");
    await postWebhook(settings, text);
    return;
  }
  const token = resolveUserBotToken(userId);
  const chatId = get<{ chat_id: string }>("SELECT chat_id FROM user_push_configs WHERE user_id = ?", userId)?.chat_id ?? "";
  if (!token || !chatId) throw new Error("请先保存 Bot Token 与 Chat ID");
  await sendTelegramWith({ botToken: token, chatId }, text);
}

/**
 * AI 后台补审通过后调用：按 id 把条目捞出来，再走一遍个人派发。
 * 与全局 pushReviewedByIds 互补 —— 全局没配 Bot 时它直接返回 0，个人推送不能跟着哑掉。
 */
export async function dispatchUserPushByIds(sourceId: string, itemIds: readonly number[]): Promise<number> {
  if (!itemIds.length) return 0;
  if (!hasEnabledUserPush()) return 0;
  const ph = itemIds.map(() => "?").join(",");
  const rows = all<{
    id: number;
    title: string;
    summary: string | null;
    url: string;
    category: string | null;
    kind: string | null;
    score: number;
    codes: string;
    price: number | null;
    is_free: number;
    obtain: string | null;
    expires_at: string | null;
    published_at: string | null;
    ai: string | null;
    canonical_id: number | null;
  }>(
    "SELECT id, title, summary, url, category, kind, score, codes, price, is_free, obtain, expires_at, published_at, ai, canonical_id " +
      "FROM items WHERE id IN (" + ph + ") AND status = 'active'",
    ...itemIds,
  );
  const fresh: FreshItem[] = rows.map((r) => {
    let codes: string[] = [];
    try {
      codes = JSON.parse(r.codes ?? "[]") as string[];
    } catch {
      codes = [];
    }
    const ai = parseAiMeta(r.ai);
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      score: r.score,
      codes,
      expiresAt: r.expires_at,
      publishedAt: r.published_at,
      price: r.price,
      isFree: r.is_free === 1,
      aiKeep: ai.aiKeep,
      aiReason: ai.aiReason,
      kind: r.kind,
      category: r.category,
      obtain: r.obtain,
      summary: r.summary,
      canonicalId: r.canonical_id,
    };
  });
  return dispatchUserPush(sourceId, fresh);
}
