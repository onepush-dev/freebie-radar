import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { all, get, run } from "./db.ts";
import {
  adminLocked,
  config,
  devMockEnabled,
  isPublicSite,
  linuxdoConfigured,
  githubConfigured,
  siteMode,
} from "./config.ts";
import { createHttp } from "./http.ts";
import { randomToken, signToken, timingSafeEqualStr, verifySignedToken } from "./crypto.ts";
import { adminHostAllowed } from "./security.ts";
import {
  admissionBlocked,
  findUserByLinuxdoId,
  getAccessControl,
  getOnboarding,
  redeemInviteCode,
  type AccessControl,
} from "./access.ts";

export const SESSION_COOKIE = "radar_session";
const STATE_COOKIE = "radar_oauth_state";
const PENDING_COOKIE = "radar_pending_reg";
const SESSION_TTL_MS = 30 * 86_400_000;

export type AuthUser = {
  id: number;
  linuxdoId: number;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  trustLevel: number;
  rssToken: string;
  disabled: boolean;
};

type UserRow = {
  id: number;
  linuxdo_id: number;
  username: string;
  name: string | null;
  avatar_url: string | null;
  trust_level: number;
  disabled: number;
  rss_token: string;
  invited_by_id?: number | null;
};

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    linuxdoId: row.linuxdo_id,
    username: row.username,
    name: row.name,
    avatarUrl: row.avatar_url,
    trustLevel: row.trust_level,
    rssToken: row.rss_token,
    disabled: row.disabled === 1,
  };
}

export type Identity = {
  siteMode: "selfhost" | "public";
  user: AuthUser | null;
  /** 管理权限只认 ADMIN_TOKEN，与 OAuth 身份完全正交 */
  isAdmin: boolean;
  /** 管理区是否处于「没有可用密码」的锁定状态 */
  adminLocked: boolean;
  access: AccessControl;
  /** 关闭登录且勾了「同步暂停个人端」时，个人写接口一律拒绝 */
  personalSuspended: boolean;
};

/* ------------------------------------------------------------------ *
 * 会话
 * ------------------------------------------------------------------ */

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto") ?? "";
  if (proto.split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function createSession(c: Context, userId: number): void {
  const id = randomToken(32);
  const now = new Date();
  run(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    id,
    userId,
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    now.toISOString(),
  );
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecureRequest(c),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function destroySession(c: Context): void {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) run("DELETE FROM sessions WHERE id = ?", id);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function userFromSession(c: Context): AuthUser | null {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return null;
  const row = get<UserRow & { expires_at: string }>(
    `SELECT u.id, u.linuxdo_id, u.username, u.name, u.avatar_url, u.trust_level, u.disabled, u.rss_token, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    sid,
  );
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    run("DELETE FROM sessions WHERE id = ?", sid);
    return null;
  }
  if (row.disabled === 1) return null;
  return toAuthUser(row);
}

/**
 * 解析请求身份。管理权限判定顺序：
 *   1. public 站没配 ADMIN_TOKEN → 一律不是管理员（管理区锁死）
 *   2. selfhost 且没配 ADMIN_TOKEN → 视为管理员（向后兼容旧部署）
 *   3. Bearer 与 ADMIN_TOKEN 定长摘要相等 → 管理员
 * 绝不因为「登录了 LINUX DO」而提权。
 */
export function resolveIdentity(c: Context): Identity {
  const access = getAccessControl();
  const user = userFromSession(c);
  const token = config.adminToken;
  let isAdmin = false;
  if (!token) {
    isAdmin = !adminLocked && adminHostAllowed(c);
  } else {
    const auth = c.req.header("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    isAdmin = adminHostAllowed(c) && Boolean(given) && timingSafeEqualStr(given, token);
  }
  return {
    siteMode,
    user,
    isAdmin,
    adminLocked,
    access,
    personalSuspended: !access.loginEnabled && access.suspendUserSessionsOnClose,
  };
}

/** 供路由内部取身份用（中间件已解析过一次，这里直接从 context 变量读） */
export function identityOf(c: Context): Identity {
  const cached = c.get("identity" as never) as Identity | undefined;
  return cached ?? resolveIdentity(c);
}

/* ------------------------------------------------------------------ *
 * LINUX DO Connect OAuth2
 * ------------------------------------------------------------------ */

type LinuxdoProfile = {
  id: number;
  username: string;
  name: string | null;
  avatar_url: string | null;
  trust_level: number;
  active: boolean;
  silenced: boolean;
};

/** avatar_template 是 `/user_avatar/linux.do/x/{size}.png` 这种相对路径，补成绝对地址 */
function absolutizeAvatar(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return v.replace("{size}", "120");
  if (v.startsWith("/")) return ("https://linux.do" + v).replace("{size}", "120");
  return null;
}

function normalizeProfile(data: unknown): LinuxdoProfile | null {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const idRaw = o.id ?? o.user_id;
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) return null;
  const username = typeof o.username === "string" && o.username.trim() ? o.username.trim() : `user${id}`;
  return {
    id,
    username,
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : null,
    avatar_url: absolutizeAvatar(o.avatar_url) ?? absolutizeAvatar(o.avatar_template),
    trust_level: Number.isFinite(Number(o.trust_level)) ? Math.max(0, Math.min(4, Number(o.trust_level))) : 0,
    active: o.active !== false,
    silenced: o.silenced === true,
  };
}

function oauthHttp(proxy?: string) {
  return createHttp({
    // 优先用 OAuth 专用代理，避免为了登录把全站采集都塞进代理
    proxy: proxy || config.linuxdoProxy || config.httpsProxy || config.httpProxy || undefined,
    gapMs: 0,
    timeoutMs: 15_000,
  });
}

function redirectUri(c: Context): string {
  if (config.linuxdoRedirectUri) return config.linuxdoRedirectUri;
  const base = config.publicBaseUrl || new URL(c.req.url).origin;
  return base.replace(/\/+$/, "") + "/api/auth/linuxdo/callback";
}

function githubRedirectUri(c: Context): string {
  if (config.githubRedirectUri) return config.githubRedirectUri;
  const base = config.publicBaseUrl || new URL(c.req.url).origin;
  return base.replace(/\/+$/, "") + "/api/auth/github/callback";
}

async function exchangeCode(code: string, redirect: string): Promise<string> {
  const http = oauthHttp();
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: config.linuxdoClientId,
    client_secret: config.linuxdoClientSecret,
  });
  const basic = Buffer.from(`${config.linuxdoClientId}:${config.linuxdoClientSecret}`).toString("base64");
  const res = await http.json<{ access_token?: string; error?: string; error_description?: string }>(config.linuxdoTokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      authorization: "Basic " + basic,
    },
    body: form.toString(),
  });
  if (res.status !== 200 || !res.data?.access_token) {
    throw new Error(`换取 access_token 失败：${res.data?.error_description ?? res.data?.error ?? res.status}`);
  }
  return res.data.access_token;
}

async function fetchProfile(accessToken: string): Promise<LinuxdoProfile> {
  const http = oauthHttp();
  const res = await http.json<unknown>(config.linuxdoUserUrl, {
    headers: { authorization: "Bearer " + accessToken, accept: "application/json" },
  });
  if (res.status !== 200) throw new Error("读取 LINUX DO 用户信息失败：" + res.status);
  const profile = normalizeProfile(res.data);
  if (!profile) throw new Error("LINUX DO 返回的用户信息无法识别");
  return profile;
}

function upsertUser(profile: LinuxdoProfile, invitedById: number | null): UserRow {
  const now = new Date().toISOString();
  const existing = findUserByLinuxdoId(profile.id);
  if (existing) {
    run(
      "UPDATE users SET username = ?, name = ?, avatar_url = ?, trust_level = ?, last_login_at = ? WHERE id = ?",
      profile.username,
      profile.name,
      profile.avatar_url,
      profile.trust_level,
      now,
      existing.id,
    );
    return { ...existing, ...profile, avatar_url: profile.avatar_url, last_login_at: now } as unknown as UserRow;
  }
  run(
    `INSERT INTO users (linuxdo_id, username, name, avatar_url, trust_level, disabled, rss_token, invited_by_id, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    profile.id,
    profile.username,
    profile.name,
    profile.avatar_url,
    profile.trust_level,
    randomToken(24),
    invitedById,
    now,
    now,
  );
  const row = findUserByLinuxdoId(profile.id);
  if (!row) throw new Error("创建用户失败");
  return row;
}

/** 新用户准入判定：返回 null 表示放行，否则返回应跳转的错误锚点 */
function rejectReason(profile: LinuxdoProfile, access: AccessControl): string | null {
  if (!profile.active) return "inactive";
  if (profile.silenced) return "silenced";
  if (profile.trust_level < access.minTrustLevel) return "trust";
  return null;
}

function frontendRedirect(c: Context, hash: string) {
  return c.redirect("/#" + hash.replace(/^#/, ""));
}

export function registerAuthRoutes(app: Hono): void {
  /** 前端启动时拉一次：站点形态、登录开关、公告、当前身份 */
  app.get("/api/site/bootstrap", (c) => {
    const id = resolveIdentity(c);
    return c.json({
      siteMode: id.siteMode,
      loginEnabled: id.access.loginEnabled,
      registrationMode: id.access.registrationMode,
      suspendUserSessionsOnClose: id.access.suspendUserSessionsOnClose,
      minTrustLevel: id.access.minTrustLevel,
      oauthConfigured: linuxdoConfigured,
      githubConfigured,
      devMockEnabled,
      adminConfigured: Boolean(config.adminToken),
      adminLocked: id.adminLocked,
      isAdmin: id.isAdmin,
      user: id.user,
      onboarding: getOnboarding(),
      features: { rss: true, userPush: true, personalRegex: false },
    });
  });

  app.get("/api/auth/me", (c) => {
    const id = resolveIdentity(c);
    return c.json({ user: id.user, isAdmin: id.isAdmin, siteMode: id.siteMode });
  });

/**
 * 登录准入的统一收尾：两个 OAuth 渠道（LINUX DO / GitHub）建号、邀请码、名额、封禁都在这里，
 * 差别只在「怎么拿到 profile」，避免两套逻辑各写一遍然后慢慢跑偏。
 */
function finishLogin(c: Context, profile: LinuxdoProfile, invite: string): Response {
  const access = getAccessControl();
  const existing = findUserByLinuxdoId(profile.id);
  if (existing) {
    if (existing.disabled === 1) return frontendRedirect(c, "login-banned");
    upsertUser(profile, existing.invited_by_id ?? null);
    createSession(c, existing.id);
    return frontendRedirect(c, "home");
  }

  if (access.registrationMode === "closed") return frontendRedirect(c, "register-closed");
  // 名额上限：满了只挡新注册，老用户在上面已经放行
  if (admissionBlocked()) return frontendRedirect(c, "quota-full");

  if (access.registrationMode === "open") {
    const row = upsertUser(profile, null);
    createSession(c, row.id);
    return frontendRedirect(c, "home");
  }

  // invite 模式：带码就直接建号核销，没带码先签一张 10 分钟的「待补码」凭证
  if (invite) {
    const row = upsertUser(profile, null);
    const redeemed = redeemInviteCode(invite, row.id);
    if (!redeemed.ok) {
      run("DELETE FROM users WHERE id = ?", row.id);
      return frontendRedirect(c, "invite-invalid");
    }
    createSession(c, row.id);
    return frontendRedirect(c, "home");
  }

  setCookie(c, PENDING_COOKIE, signToken({ profile }, 600), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecureRequest(c),
    maxAge: 600,
  });
  return frontendRedirect(c, "invite-required");
}
  app.get("/api/auth/linuxdo/login", (c) => {
    const access = getAccessControl();
    if (!access.loginEnabled) return frontendRedirect(c, "login-disabled");
    if (!linuxdoConfigured) return frontendRedirect(c, "login-unconfigured");
    const invite = (c.req.query("invite") ?? "").trim().toUpperCase().slice(0, 32);
    const state = randomToken(16);
    // state 与预填邀请码一起签名塞进短期 Cookie，回调时校验，避免 CSRF 与邀请码被中间人替换
    setCookie(c, STATE_COOKIE, signToken({ state, invite }, 300), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: isSecureRequest(c),
      maxAge: 300,
    });
    const url = new URL(config.linuxdoAuthorizeUrl);
    url.searchParams.set("client_id", config.linuxdoClientId);
    url.searchParams.set("redirect_uri", redirectUri(c));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read");
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.get("/api/auth/linuxdo/callback", async (c) => {
    const access = getAccessControl();
    if (!access.loginEnabled) return frontendRedirect(c, "login-disabled");
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const rawState = getCookie(c, STATE_COOKIE) ?? "";
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    const statePayload = rawState ? verifySignedToken<{ state: string; invite: string }>(rawState) : null;
    if (!code) return frontendRedirect(c, "login-failed");
    if (!statePayload || statePayload.state !== state) return frontendRedirect(c, "login-state-mismatch");

    try {
      const accessToken = await exchangeCode(code, redirectUri(c));
      const profile = await fetchProfile(accessToken);
      const blocked = rejectReason(profile, access);
      if (blocked) return frontendRedirect(c, "login-" + blocked);

      const existing = findUserByLinuxdoId(profile.id);
      return finishLogin(c, profile, statePayload.invite);
    } catch (err) {
      console.error("[auth] OAuth 回调失败:", err instanceof Error ? err.message : err);
      return frontendRedirect(c, "login-failed");
    }
  });


  /** GitHub 登录：与 LINUX DO 共用准入链路，只是拿 profile 的方式不同 */
  app.get("/api/auth/github/login", (c) => {
    const access = getAccessControl();
    if (!access.loginEnabled) return frontendRedirect(c, "login-disabled");
    if (!githubConfigured) return frontendRedirect(c, "login-unconfigured");
    const invite = (c.req.query("invite") ?? "").trim().toUpperCase().slice(0, 32);
    const state = randomToken(16);
    setCookie(c, STATE_COOKIE, signToken({ state, invite }, 300), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: isSecureRequest(c),
      maxAge: 300,
    });
    const url = new URL(config.githubAuthorizeUrl);
    url.searchParams.set("client_id", config.githubClientId);
    url.searchParams.set("redirect_uri", githubRedirectUri(c));
    url.searchParams.set("scope", "read:user user:email");
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.get("/api/auth/github/callback", async (c) => {
    const access = getAccessControl();
    if (!access.loginEnabled) return frontendRedirect(c, "login-disabled");
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const rawState = getCookie(c, STATE_COOKIE) ?? "";
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    const statePayload = rawState ? verifySignedToken<{ state: string; invite: string }>(rawState) : null;
    if (!code) return frontendRedirect(c, "login-failed");
    if (!statePayload || statePayload.state !== state) return frontendRedirect(c, "login-state-mismatch");

    try {
      const http = oauthHttp(config.githubProxy);
      const tokenJson = await http.json<{ access_token?: string; error_description?: string }>(config.githubTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          client_id: config.githubClientId,
          client_secret: config.githubClientSecret,
          code,
          redirect_uri: githubRedirectUri(c),
        }).toString(),
      });
      const tokenData = tokenJson.data;
      const accessToken = tokenData.access_token ?? "";
      if (!accessToken) throw new Error(tokenData.error_description ?? "GitHub 未返回 access_token");

      const userRes = await http.json<{ id?: number; login?: string; name?: string | null; avatar_url?: string | null }>(config.githubUserUrl, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "freebie-radar" },
      });
      const gh = userRes.data;
      if (!gh.id) throw new Error("GitHub 用户信息缺少 id");

      // GitHub id 存成负数做命名空间，避免和 LINUX DO 的 id 撞车（两边的 id 空间互不相干）
      const profile: LinuxdoProfile = {
        id: -Math.abs(gh.id),
        username: gh.login ?? `gh_${gh.id}`,
        name: gh.name ?? gh.login ?? null,
        avatar_url: gh.avatar_url ?? null,
        trust_level: 0,
        active: true,
        silenced: false,
      };
      return finishLogin(c, profile, statePayload.invite);
    } catch (err) {
      console.error("[auth] GitHub 回调失败:", err instanceof Error ? err.message : err);
      return frontendRedirect(c, "login-failed");
    }
  });
  /** 待补码用户提交邀请码：核销成功才真正建号，避免「先建号再失败」留下空用户 */
  app.post("/api/auth/redeem-invite", async (c) => {
    const raw = getCookie(c, PENDING_COOKIE) ?? "";
    const pending = raw ? verifySignedToken<{ profile: LinuxdoProfile }>(raw) : null;
    if (!pending?.profile) return c.json({ error: "注册凭证已过期，请重新登录 LINUX DO", expired: true }, 400);
    const body = (await c.req.json().catch(() => null)) as { code?: string } | null;
    const code = (body?.code ?? "").trim();
    if (!code) return c.json({ error: "请输入邀请码" }, 400);

    const access = getAccessControl();
    if (!access.loginEnabled) return c.json({ error: "站点当前已关闭登录" }, 403);
    if (access.registrationMode === "closed") return c.json({ error: "站点当前已停止新用户注册" }, 403);
    const blocked = admissionBlocked();
    if (blocked) return c.json({ error: blocked }, 403);

    const existing = findUserByLinuxdoId(pending.profile.id);
    if (existing) {
      // 重复提交：已经建过号就直接登录，别让用户卡在补码页
      createSession(c, existing.id);
      deleteCookie(c, PENDING_COOKIE, { path: "/" });
      return c.json({ ok: true, user: toAuthUser(existing) });
    }

    const row = upsertUser(pending.profile, null);
    const redeemed = redeemInviteCode(code, row.id);
    if (!redeemed.ok) {
      run("DELETE FROM users WHERE id = ?", row.id);
      return c.json({ error: redeemed.error }, 400);
    }
    createSession(c, row.id);
    deleteCookie(c, PENDING_COOKIE, { path: "/" });
    return c.json({ ok: true, user: toAuthUser(row) });
  });

  app.post("/api/auth/logout", (c) => {
    destroySession(c);
    return c.json({ ok: true });
  });

  /** 本地模拟登录：只在非生产 + 显式开启时可用，用来验证多账号隔离与双 Bot 推送 */
  app.post("/api/auth/dev-login", async (c) => {
    if (!devMockEnabled || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(c.req.url).hostname)) return c.json({ error: "本地模拟登录未开启" }, 403);
    const access = getAccessControl();
    if (!access.loginEnabled) return c.json({ error: "站点当前已关闭登录" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { preset?: string; trustLevel?: number; invite?: string };
    const preset = body.preset === "bob" ? "bob" : "alice";
    const linuxdoId = preset === "bob" ? 900002 : 900001;
    const username = preset === "bob" ? "bob_ld" : "alice_ld";
    const profile: LinuxdoProfile = {
      id: linuxdoId,
      username,
      name: preset === "bob" ? "测试账号 B" : "测试账号 A",
      avatar_url: null,
      trust_level: Number.isFinite(Number(body.trustLevel)) ? Number(body.trustLevel) : 3,
      active: true,
      silenced: false,
    };
    const existing = findUserByLinuxdoId(linuxdoId);
    if (existing) {
      if (existing.disabled === 1) return c.json({ error: "该测试账号已被停用" }, 403);
      upsertUser(profile, existing.invited_by_id ?? null);
      createSession(c, existing.id);
      return c.json({ ok: true, user: toAuthUser(existing) });
    }
    if (access.registrationMode === "closed") return c.json({ error: "站点当前已停止新用户注册" }, 403);
    const blocked = admissionBlocked();
    if (blocked) return c.json({ error: blocked }, 403);
    // 邀请码模式下，本地模拟登录也走真实准入：带码直接核销，没带码就发「待补码」凭证
    if (access.registrationMode === "invite") {
      const invite = (body.invite ?? "").trim();
      if (!invite) {
        setCookie(c, PENDING_COOKIE, signToken({ profile }, 600), {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          secure: isSecureRequest(c),
          maxAge: 600,
        });
        return c.json({ ok: false, needInvite: true, message: "站点开启了邀请码注册，请填写邀请码完成注册" });
      }
      const row = upsertUser(profile, null);
      const redeemed = redeemInviteCode(invite, row.id);
      if (!redeemed.ok) {
        run("DELETE FROM users WHERE id = ?", row.id);
        return c.json({ ok: false, needInvite: true, error: redeemed.error });
      }
      createSession(c, row.id);
      return c.json({ ok: true, user: toAuthUser(row) });
    }
    const row = upsertUser(profile, null);
    createSession(c, row.id);
    return c.json({ ok: true, user: toAuthUser(row) });
  });

  /** 个人 RSS Token 重置 */
  app.post("/api/me/rss-token/reset", (c) => {
    const id = identityOf(c);
    if (!id.user) return c.json({ error: "需要登录" }, 401);
    if (id.personalSuspended) return c.json({ error: "站点已暂停个人功能" }, 403);
    const token = randomToken(24);
    run("UPDATE users SET rss_token = ? WHERE id = ?", token, id.user.id);
    return c.json({ ok: true, rssToken: token });
  });
}

/** 按 rss_token 反查用户（RSS 用，不走 Cookie） */
export function userByRssToken(token: string): AuthUser | null {
  if (!token || token.length < 8) return null;
  const row = get<UserRow>("SELECT * FROM users WHERE rss_token = ?", token);
  if (!row || row.disabled === 1) return null;
  return toAuthUser(row);
}

export function sessionCount(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?", new Date().toISOString())?.n ?? 0;
}

export function purgeExpiredSessions(): number {
  const res = run("DELETE FROM sessions WHERE expires_at <= ?", new Date().toISOString());
  return Number(res.changes);
}

/** 个人状态批量读取：列表接口一次查完，避免逐条 N+1 */
export function loadUserStates(
  userId: number,
  itemIds: readonly number[],
): Map<number, { hidden: boolean; starred: boolean; read: boolean }> {
  const out = new Map<number, { hidden: boolean; starred: boolean; read: boolean }>();
  if (!userId || !itemIds.length) return out;
  const ph = itemIds.map(() => "?").join(",");
  const rows = all<{ item_id: number; hidden: number; starred: number; read_at: string | null }>(
    `SELECT item_id, hidden, starred, read_at FROM user_item_states WHERE user_id = ? AND item_id IN (${ph})`,
    userId,
    ...itemIds,
  );
  for (const r of rows) {
    out.set(r.item_id, { hidden: r.hidden === 1, starred: r.starred === 1, read: Boolean(r.read_at) });
  }
  return out;
}
