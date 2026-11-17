/**
 * 管理端凭据：只存在 sessionStorage，关掉标签页就没了。
 * 用全局 fetch 包装统一带上 Authorization，避免每个调用点都要改。
 */
const KEY = "radar-admin-token";

export function getToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* 隐私模式下不可用，退化为不保存 */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}

let installed = false;
export const ADMIN_AUTH_EVENT = "radar-admin-auth-change";

/** 在 main.tsx 里调用一次：所有 fetch 自动附带管理密码。 */
export function installAuthFetch(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const orig = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = getToken();
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (!token || url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return orig(input, init);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return orig(input, { ...init, headers }).then((response) => {
      if (response.status === 401 && headers.get("authorization") === `Bearer ${token}`) {
        // Personal-session expiry must not log the administrator out.
        if (!url.pathname.startsWith("/api/me/")) {
          clearToken();
          window.dispatchEvent(new Event(ADMIN_AUTH_EVENT));
        }
      }
      return response;
    });
  }) as typeof fetch;
}

/** 验证密码：命中返回 true。 */
export async function verifyToken(token: string): Promise<boolean> {
  const r = await fetch("/api/auth/check", { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return false;
  return Boolean(((await r.json()) as { isAdmin?: boolean }).isAdmin);
}
