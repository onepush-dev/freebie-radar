import { useCallback, useEffect, useState } from "react";
import {
  Ban,
  Check,
  Copy,
  DownloadCloud,
  Loader2,
  Megaphone,
  RefreshCw,
  ShieldCheck,
  Ticket,
  Users,
} from "lucide-react";
import { getToken } from "../lib/auth.ts";

type Access = {
  loginEnabled: boolean;
  suspendUserSessionsOnClose: boolean;
  registrationMode: "open" | "invite" | "closed";
  minTrustLevel: number;
  maxUsers: number;
};

type Onboarding = { enabled: boolean; title: string; content: string; showGuideCards: boolean; version: number };

type Invite = {
  id: number;
  code: string;
  max_uses: number;
  used_count: number;
  disabled: number;
  note: string | null;
  expires_at: string | null;
  created_at: string;
};

type AdminUser = {
  id: number;
  linuxdo_id: number;
  username: string;
  name: string | null;
  trust_level: number;
  disabled: number;
  created_at: string;
  last_login_at: string;
  hidden: number;
  starred: number;
  push_enabled: number;
};

type BuildInfo = {
  version: string;
  commitShort: string | null;
  branch: string | null;
  runtimeMode: "git" | "docker-webhook" | "docker-readonly";
  buildTime: string | null;
};

type UpdateCheck = {
  runtimeMode: string;
  current: BuildInfo;
  available: boolean;
  behind: number;
  latest: { short: string; message: string; date: string; author: string } | null;
  commits: { short: string; message: string; date: string; author: string }[];
  dirtyFiles: string[];
  canAutoUpdate: boolean;
  notes: string[];
};

type UpdateJob = {
  id: string;
  status: "running" | "done" | "failed";
  steps: { name: string; status: string; detail?: string }[];
  log: string;
  error: string | null;
  restartScheduled: boolean;
};

const authHeaders = (): Record<string, string> => {
  const t = getToken();
  return t ? { authorization: "Bearer " + t } : {};
};

const jsonAuth = (): Record<string, string> => ({ "content-type": "application/json", ...authHeaders() });

function Section({ icon: Icon, title, desc, children }: { icon: typeof Users; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="panel space-y-3 p-5">
      <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-950">
        <Icon size={14} className="text-accent" /> {title}
      </div>
      {desc && <p className="text-[11.5px] leading-relaxed text-ink-500">{desc}</p>}
      {children}
    </section>
  );
}

const MODE_LABEL: Record<string, string> = {
  git: "Git 源码直跑",
  "docker-webhook": "Docker + 宿主机 Webhook",
  "docker-readonly": "Docker（只读，需宿主机操作）",
};

export function SiteAdminPanel() {
  const [access, setAccess] = useState<Access | null>(null);
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [hostCmd, setHostCmd] = useState("");
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [inviteCount, setInviteCount] = useState(5);
  const [inviteUses, setInviteUses] = useState(1);
  const [inviteDays, setInviteDays] = useState(0);
  const [inviteNote, setInviteNote] = useState("");

  const notify = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2600);
  }, []);

  const loadAll = useCallback(async () => {
    const [ov, inv, usr] = await Promise.all([
      fetch("/api/admin/overview", { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/admin/invites", { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/admin/users?limit=200", { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (ov) {
      setAccess(ov.access as Access);
      setOnboarding(ov.onboarding as Onboarding);
      setBuild(ov.build as BuildInfo);
      setHostCmd(String(ov.hostUpdateCommand ?? ""));
    }
    if (inv) setInvites((inv.codes ?? []) as Invite[]);
    if (usr) setUsers((usr.users ?? []) as AdminUser[]);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const patchAccess = async (patch: Partial<Access>) => {
    const res = await fetch("/api/admin/access", { method: "PATCH", headers: jsonAuth(), body: JSON.stringify(patch) });
    const data = (await res.json().catch(() => ({}))) as { access?: Access; error?: string };
    if (!res.ok) return notify(data.error ?? "保存失败");
    setAccess(data.access ?? null);
    notify("已保存");
  };

  const saveOnboarding = async (patch: Record<string, unknown>) => {
    const res = await fetch("/api/admin/onboarding", { method: "PATCH", headers: jsonAuth(), body: JSON.stringify(patch) });
    const data = (await res.json().catch(() => ({}))) as { onboarding?: Onboarding; error?: string };
    if (!res.ok) return notify(data.error ?? "保存失败");
    setOnboarding(data.onboarding ?? null);
    notify("已保存");
  };

  const runCheck = async () => {
    setBusy("check");
    try {
      const res = await fetch("/api/admin/update/check", { headers: authHeaders() });
      const data = (await res.json().catch(() => ({}))) as UpdateCheck & { error?: string };
      if (!res.ok) return notify(data.error ?? "检查失败");
      setCheck(data);
      notify(data.available ? `发现 ${data.behind} 个新提交` : "已是最新");
    } finally {
      setBusy(null);
    }
  };

  const runUpdate = async () => {
    setBusy("update");
    try {
      const res = await fetch("/api/admin/update/run", { method: "POST", headers: authHeaders() });
      const data = (await res.json().catch(() => ({}))) as { job?: UpdateJob; error?: string };
      if (!res.ok) return notify(data.error ?? "启动失败");
      setJob(data.job ?? null);
      pollJob();
    } finally {
      setBusy(null);
    }
  };

  const pollJob = useCallback(() => {
    let n = 0;
    const timer = setInterval(async () => {
      n += 1;
      const res = await fetch("/api/admin/update/status", { headers: authHeaders() });
      if (res.ok) {
        const data = (await res.json()) as { job: UpdateJob | null };
        setJob(data.job);
        if (data.job && data.job.status !== "running") {
          clearInterval(timer);
          notify(data.job.status === "done" ? "更新完成" : "更新失败：" + (data.job.error ?? ""));
        }
      }
      if (n > 100) clearInterval(timer);
    }, 2000);
  }, [notify]);

  return (
    <div className="space-y-4">
      {msg && (
        <div className="toast-enter fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-ink-800 bg-ink-950 px-3.5 py-2 text-[12.5px] font-medium text-white">
          {msg}
        </div>
      )}

      <Section
        icon={ShieldCheck}
        title="访问控制"
        desc="登录入口与注册模式热生效，无需重启。管理权限始终只认 ADMIN_TOKEN，LINUX DO 登录不会提权。"
      >
        {!access ? (
          <div className="text-[12.5px] text-ink-500">加载中…</div>
        ) : (
          <div className="space-y-2.5">
            <label className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 bg-surface-hover px-3 py-2 text-[12.5px] text-ink-800">
              <span>开放登录入口</span>
              <input
                type="checkbox"
                checked={access.loginEnabled}
                onChange={(e) => void patchAccess({ loginEnabled: e.target.checked })}
                className="h-3.5 w-3.5 accent-[#111318]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 bg-surface-hover px-3 py-2 text-[12.5px] text-ink-800">
              <span>关闭登录时同步暂停个人端（维护模式）</span>
              <input
                type="checkbox"
                checked={access.suspendUserSessionsOnClose}
                onChange={(e) => void patchAccess({ suspendUserSessionsOnClose: e.target.checked })}
                className="h-3.5 w-3.5 accent-[#111318]"
              />
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-ink-700">注册模式</span>
              {(
                [
                  ["open", "开放注册"],
                  ["invite", "邀请码注册"],
                  ["closed", "停止新注册"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => void patchAccess({ registrationMode: key })}
                  className={
                    "rounded-lg border px-2.5 py-1 text-[11.5px] font-medium " +
                    (access.registrationMode === key
                      ? "border-brand bg-ink-950 text-white"
                      : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100")
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 bg-surface-hover px-3 py-2 text-[12.5px] text-ink-800">
              <span>最低 LINUX DO 信任等级</span>
              <select
                value={access.minTrustLevel}
                onChange={(e) => void patchAccess({ minTrustLevel: Number(e.target.value) })}
                className="rounded border border-ink-200 bg-surface px-2 py-1 text-[12px] text-ink-900 outline-none focus:border-accent"
              >
                {[0, 1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    TL{n}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 bg-surface-hover px-3 py-2 text-[12.5px] text-ink-800">
              <span>
                注册名额上限
                <span className="ml-1.5 text-[11px] text-ink-500">0 = 不限；满了只挡新注册，老用户照常登录</span>
              </span>
              <input
                type="number"
                min={0}
                max={100000}
                value={access.maxUsers}
                onChange={(e) => void patchAccess({ maxUsers: Number(e.target.value) })}
                className="w-24 rounded border border-ink-200 bg-surface px-2 py-1 text-right text-[12px] text-ink-900 outline-none focus:border-accent"
              />
            </label>
          </div>
        )}
      </Section>

      <Section icon={Ticket} title="邀请码" desc="核销是原子的（BEGIN IMMEDIATE + 条件 UPDATE），并发不会超发；老用户永远免码。">
        <div className="flex flex-wrap items-end gap-2">
          {[
            { label: "数量", value: inviteCount, set: setInviteCount, max: 50 },
            { label: "每码可用次数", value: inviteUses, set: setInviteUses, max: 10000 },
            { label: "有效天数（0=永久）", value: inviteDays, set: setInviteDays, max: 3650 },
          ].map((f) => (
            <label key={f.label} className="block">
              <span className="text-[11.5px] text-ink-600">{f.label}</span>
              <input
                type="number"
                min={0}
                max={f.max}
                value={f.value}
                onChange={(e) => f.set(Number(e.target.value))}
                className="mt-1 w-[110px] rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-950 outline-none focus:border-accent"
              />
            </label>
          ))}
          <label className="block">
            <span className="text-[11.5px] text-ink-600">备注</span>
            <input
              value={inviteNote}
              onChange={(e) => setInviteNote(e.target.value)}
              placeholder="可选"
              className="mt-1 w-[150px] rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-950 outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            onClick={async () => {
              setBusy("invite");
              try {
                const res = await fetch("/api/admin/invites", {
                  method: "POST",
                  headers: jsonAuth(),
                  body: JSON.stringify({ count: inviteCount, maxUses: inviteUses, expiresDays: inviteDays, note: inviteNote }),
                });
                const data = (await res.json().catch(() => ({}))) as { created?: Invite[]; codes?: Invite[]; error?: string };
                if (!res.ok) return notify(data.error ?? "生成失败");
                setInvites((data.codes ?? []) as Invite[]);
                notify(`已生成 ${data.created?.length ?? 0} 个邀请码`);
                setInviteNote("");
              } finally {
                setBusy(null);
              }
            }}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-950 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-hover disabled:opacity-60"
          >
            {busy === "invite" ? <Loader2 size={12} className="animate-spin" /> : <Ticket size={12} />} 生成
          </button>
        </div>

        <div className="max-h-[260px] divide-y divide-ink-100 overflow-auto rounded-lg border border-ink-200">
          {invites.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-ink-500">还没有邀请码</div>}
          {invites.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
              <code className="font-mono font-medium text-ink-900">{v.code}</code>
              <span className="text-ink-500">
                {v.used_count}/{v.max_uses}
              </span>
              {v.note && <span className="text-ink-500">· {v.note}</span>}
              {v.expires_at && <span className="text-ink-400">· {v.expires_at.slice(0, 10)} 到期</span>}
              {v.disabled === 1 && <span className="rounded bg-ink-100 px-1.5 py-0.5 text-ink-600">已停用</span>}
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(v.code);
                      notify("已复制");
                    } catch {
                      /* ignore */
                    }
                  }}
                  className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-900"
                  title="复制"
                >
                  <Copy size={12} />
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await fetch("/api/admin/invites/" + v.id, {
                      method: "PATCH",
                      headers: jsonAuth(),
                      body: JSON.stringify({ disabled: v.disabled !== 1 }),
                    });
                    if (res.ok) setInvites(((await res.json()) as { codes: Invite[] }).codes);
                  }}
                  className="rounded px-1.5 py-0.5 text-[11.5px] text-ink-600 hover:bg-ink-100"
                >
                  {v.disabled === 1 ? "启用" : "停用"}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await fetch("/api/admin/invites/" + v.id, { method: "DELETE", headers: authHeaders() });
                    if (res.ok) setInvites(((await res.json()) as { codes: Invite[] }).codes);
                  }}
                  className="rounded px-1.5 py-0.5 text-[11.5px] text-alert hover:bg-ink-100"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={Users} title={`已注册用户（${users.length}）`} desc="封禁会同时清掉该用户的登录态；个人 Bot 推送也会随之停用。">
        <div className="max-h-[280px] divide-y divide-ink-100 overflow-auto rounded-lg border border-ink-200">
          {users.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-ink-500">还没有用户</div>}
          {users.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
              <span className="font-medium text-ink-900">{u.name ?? u.username}</span>
              <span className="text-ink-500">@{u.username}</span>
              <span className="rounded bg-ink-100 px-1.5 py-0.5 text-ink-600">TL{u.trust_level}</span>
              <span className="text-ink-500">
                收藏 {u.starred} · 关闭 {u.hidden} {u.push_enabled === 1 ? "· 个人推送" : ""}
              </span>
              <span className="text-ink-400">最近 {u.last_login_at.slice(0, 10)}</span>
              {u.disabled === 1 && <span className="rounded bg-alert-subtle px-1.5 py-0.5 text-alert">已封禁</span>}
              <button
                type="button"
                onClick={async () => {
                  const res = await fetch("/api/admin/users/" + u.id, {
                    method: "PATCH",
                    headers: jsonAuth(),
                    body: JSON.stringify({ disabled: u.disabled !== 1 }),
                  });
                  if (res.ok) {
                    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, disabled: u.disabled === 1 ? 0 : 1 } : x)));
                    notify(u.disabled === 1 ? "已解封" : "已封禁");
                  }
                }}
                className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-ink-600 hover:bg-ink-100"
              >
                {u.disabled === 1 ? <Check size={11} /> : <Ban size={11} />}
                {u.disabled === 1 ? "解封" : "封禁"}
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={Megaphone} title="入站公告" desc="按版本号只弹一次；点「保存并重新弹出」会让所有访客下次进站重新看到。">
        {!onboarding ? (
          <div className="text-[12.5px] text-ink-500">加载中…</div>
        ) : (
          <div className="space-y-2.5">
            <label className="block">
              <span className="text-[12px] text-ink-700">标题</span>
              <input
                defaultValue={onboarding.title}
                onBlur={(e) => e.target.value !== onboarding.title && void saveOnboarding({ title: e.target.value })}
                className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink-950 outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-ink-700">正文</span>
              <textarea
                defaultValue={onboarding.content}
                rows={6}
                onBlur={(e) => e.target.value !== onboarding.content && void saveOnboarding({ content: e.target.value })}
                className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink-950 outline-none focus:border-accent"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-700">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={onboarding.enabled}
                  onChange={(e) => void saveOnboarding({ enabled: e.target.checked })}
                  className="h-3.5 w-3.5 accent-[#111318]"
                />
                启用公告
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={onboarding.showGuideCards}
                  onChange={(e) => void saveOnboarding({ showGuideCards: e.target.checked })}
                  className="h-3.5 w-3.5 accent-[#111318]"
                />
                显示功能引导卡片
              </label>
              <span className="text-ink-400">当前版本 v{onboarding.version}</span>
              <button
                type="button"
                onClick={() => void saveOnboarding({ bumpVersion: true })}
                className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-700 hover:bg-ink-100"
              >
                保存并重新弹出
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section icon={DownloadCloud} title="版本与更新" desc="容器内无法重建镜像，会如实提示边界，不会假装能自更新。">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-700">
          <span className="rounded bg-ink-100 px-2 py-0.5 font-mono">
            v{build?.version ?? "?"} {build?.commitShort ? "· " + build.commitShort : ""}
          </span>
          <span className="text-ink-500">{build ? (MODE_LABEL[build.runtimeMode] ?? build.runtimeMode) : ""}</span>
          <button
            type="button"
            onClick={() => void runCheck()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-60"
          >
            {busy === "check" ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} 检查更新
          </button>
          {check?.canAutoUpdate && (
            <button
              type="button"
              onClick={() => void runUpdate()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink-950 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-brand-hover disabled:opacity-60"
            >
              {busy === "update" ? <Loader2 size={11} className="animate-spin" /> : <DownloadCloud size={11} />} 备份并一键更新
            </button>
          )}
        </div>

        {check && (
          <div className="space-y-2 rounded-lg border border-ink-200 bg-surface-hover p-3 text-[11.5px] leading-relaxed">
            <div className="text-ink-700">
              {check.available ? `落后 ${check.behind} 个提交` : "已是最新"}
              {check.latest ? ` · 最新 ${check.latest.short} ${check.latest.message}` : ""}
            </div>
            {check.notes.map((n) => (
              <div key={n} className="text-ink-500">
                · {n}
              </div>
            ))}
            {check.dirtyFiles.length > 0 && (
              <div className="font-mono text-[11px] text-alert">{check.dirtyFiles.slice(0, 6).join(" · ")}</div>
            )}
            {check.commits.slice(0, 8).map((c) => (
              <div key={c.short} className="flex gap-2 text-ink-600">
                <span className="font-mono text-ink-400">{c.short}</span>
                <span className="truncate">{c.message}</span>
              </div>
            ))}
            {check.runtimeMode === "docker-readonly" && hostCmd && (
              <div className="rounded border border-ink-200 bg-surface px-2 py-1.5 font-mono text-[11px] break-all text-ink-700">
                {hostCmd}
              </div>
            )}
          </div>
        )}

        {job && (
          <div className="space-y-1.5 rounded-lg border border-ink-200 bg-surface-hover p-3 text-[11.5px]">
            <div className="flex items-center gap-2">
              <span className="font-medium text-ink-800">更新任务 {job.status}</span>
              {job.restartScheduled && <span className="text-ink-500">· 已安排重启</span>}
              {job.error && <span className="text-alert">· {job.error}</span>}
            </div>
            {job.steps.map((s) => (
              <div key={s.name} className="flex items-center gap-2 text-ink-600">
                <span className={s.status === "done" ? "text-deal" : s.status === "failed" ? "text-alert" : "text-ink-400"}>
                  {s.status === "done" ? "✔" : s.status === "failed" ? "✘" : "…"}
                </span>
                {s.name}
                {s.detail && <span className="truncate text-ink-500">· {s.detail}</span>}
              </div>
            ))}
            {job.log && (
              <pre className="max-h-[160px] overflow-auto rounded border border-ink-200 bg-surface p-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-600">
                {job.log}
              </pre>
            )}
          </div>
        )}
      </Section>

      <p className="px-1 text-[11.5px] leading-relaxed text-ink-500">
        <ShieldCheck size={11} className="mr-1 inline" />
        这些接口全部要求 ADMIN_TOKEN；用 LINUX DO 登录的普通账号访问会返回 401。
      </p>
    </div>
  );
}