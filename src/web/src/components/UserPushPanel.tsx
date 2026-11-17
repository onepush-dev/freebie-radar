import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  Clock,
  Eye,
  KeyRound,
  ListOrdered,
  Loader2,
  Moon,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { Bootstrap } from "../lib/session.ts";
import { PageHeading } from "./PageHeading.tsx";

type MePushConfig = {
  enabled: boolean;
  hasToken: boolean;
  botTokenMask: string;
  chatId: string;
  useGlobalBlocks: boolean;
  dailyEnabled: boolean;
  consecutiveFails: number;
  lastError: string | null;
  lastFlushAt: string | null;
  lastPushedAt: string | null;
  settings: Record<string, unknown>;
};

type MePushPayload = {
  config: MePushConfig;
  settings: Record<string, unknown>;
  stats: { queued: number; sentLast24h: number; sentLastHour: number; failures: number; lastError: string | null };
  quiet: boolean;
  ready: boolean;
  caps: { maxPerHour: number; maxPerInstant: number };
};

type Preview = {
  instant: string[];
  batch: string[];
  scanned: number;
  matched: number;
  rejectedBy: Record<string, number>;
  queued: number;
};

const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const REJECTION_LABEL: Record<string, string> = {
  hidden: "已关闭", blocked: "屏蔽词", duplicate: "重复内容", stale: "超出时效",
  source: "来源限制", lang: "语言不符", kind: "形态不符", category: "分类不符",
  price: "价格超限", ai: "AI 拦截", obtain: "获取方式", route: "未命中路由",
  lowScore: "分数不足", disabled: "推送关闭", other: "其他条件",
};

function Toast2({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div role="status" aria-live="polite" className="toast-enter fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-ink-800 bg-ink-950 px-3.5 py-2 text-[12.5px] font-medium text-white">
      {msg}
    </div>
  );
}

export function UserPushPanel({ boot }: { boot: Bootstrap }) {
  const [payload, setPayload] = useState<MePushPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [webhookInput, setWebhookInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const [detected, setDetected] = useState<{ chatId: string; title: string; type: string }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [logsLoading, setLogsLoading] = useState(true);
  const [tested, setTested] = useState(false);
  const credentialsRef = useRef<HTMLElement | null>(null);
  const testButtonRef = useRef<HTMLButtonElement | null>(null);
  const enableRef = useRef<HTMLButtonElement | null>(null);
  const [logs, setLogs] = useState<
    { id: number; kind: string; count: number; ok: number; error: string | null; reason: string | null; created_at: string; text: string }[]
  >([]);

  const notify = useCallback((m: string) => {
    if (!alive.current) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(m);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await fetch("/api/me/push/log?limit=30");
      if (!res.ok) throw new Error("推送记录加载失败");
      const data = await res.json() as { logs: typeof logs };
      if (alive.current) setLogs(data.logs);
    } catch { notify("推送记录加载失败，可点击刷新重试"); }
    finally { if (alive.current) setLogsLoading(false); }
  }, [notify]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/me/push");
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "配置加载失败");
      if (alive.current) {
        const data = (await res.json()) as MePushPayload;
        setPayload(data);
        setLoadError(null);
        setChatInput(data.config.chatId);
        setWebhookInput(str(data.settings.webhookUrl, ""));
        setSecretInput(str(data.settings.webhookSecret, ""));
      }
    } catch (e) {
      if (alive.current) setLoadError(e instanceof Error ? e.message : "无法连接服务端");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    void loadLogs();
    return () => { alive.current = false; if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [load, loadLogs]);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      setSaving(true);
      try {
        const res = await fetch("/api/me/push", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<MePushPayload> & { error?: string };
        if (!res.ok) {
          notify(data.error ?? "保存失败");
          return false;
        }
        if (alive.current) {
          setPayload((prev) => prev ? { ...prev, ...data } : prev);
          setPreview(null);
        }
        return true;
      } catch {
        notify("网络异常，配置未保存，请重试");
        return false;
      } finally { if (alive.current) setSaving(false); }
    },
    [notify],
  );

  const s = (payload?.settings ?? {}) as Record<string, unknown>;
  const cfg = payload?.config;
  useEffect(() => { setTested(false); }, [cfg?.botTokenMask, cfg?.chatId, cfg?.settings.webhookUrl, cfg?.settings.webhookSecret, cfg?.settings.deliverVia]);

  if (loading) return <div className="panel p-6 text-[13px] text-ink-500">加载个人推送配置中…</div>;
  if (!payload || !cfg) return <div role="alert" className="panel p-6 text-[13px] text-alert">{loadError ?? "无法读取个人推送配置"} <button type="button" onClick={() => void load()} className="ml-2 underline">重试</button></div>;
  const viaWebhook = cfg.settings.deliverVia === "webhook";
  const ready = viaWebhook ? Boolean(cfg.settings.webhookUrl) : cfg.hasToken && Boolean(cfg.chatId);
  const credentialsDirty = viaWebhook
    ? webhookInput.trim() !== str(cfg.settings.webhookUrl, "") || secretInput !== str(cfg.settings.webhookSecret, "")
    : Boolean(tokenInput.trim()) || chatInput.trim() !== cfg.chatId;

  return (
    <fieldset disabled={busy !== null || saving} className="min-w-0 space-y-4">
      <Toast2 msg={toast} />
      <PageHeading eyebrow="个人空间" title="个人推送" description="把感兴趣的资源送到自己的渠道。先完成接入，再调整频率；所有设置只影响你自己。"
        actions={!boot.isAdmin && <a href="#push" className="inline-flex min-h-9 items-center gap-1 rounded-md border border-ink-200 px-3 text-[12px] font-medium text-ink-700 hover:bg-surface-hover">完整推送规则 <ChevronRight size={13} /></a>} />

      <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-950">
            <Bot size={15} className="text-accent" /> {viaWebhook ? "Webhook" : "Telegram"} 渠道
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[11.5px] font-medium ${cfg.enabled ? "text-deal" : "text-ink-500"}`}>
            {cfg.enabled ? "已开启" : "未开启"}
          </span>
          <button
            type="button"
            ref={enableRef}
            role="switch"
            aria-checked={cfg.enabled}
            aria-label="开启个人推送"
            disabled={!cfg.enabled && (!ready || credentialsDirty)}
            onClick={async () => { if (await save({ enabled: !cfg.enabled })) notify(cfg.enabled ? "个人推送已关闭" : "个人推送已开启"); }}
            className={
              "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors " +
              (cfg.enabled ? "bg-brand" : "bg-ink-300") + " disabled:opacity-40"
            }
            title={cfg.enabled ? "点击关闭个人推送" : "点击开启个人推送"}
          >
            <span
              className={
                "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform " +
                (cfg.enabled ? "translate-x-4.5" : "translate-x-0.5")
              }
            />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1 p-2">
        {[
          { title: "配置渠道", note: ready && !credentialsDirty ? "凭据已保存" : "填写并保存凭据", done: ready && !credentialsDirty, current: !ready || credentialsDirty, run: () => { credentialsRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); credentialsRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }); } },
          { title: "测试投递", note: tested ? "本次测试成功" : "推荐先发测试消息", done: tested, current: ready && !credentialsDirty && !tested && !cfg.enabled, run: () => testButtonRef.current?.focus() },
          { title: "开启推送", note: cfg.enabled ? "自动推送已开启" : "随时开启或暂停", done: cfg.enabled, current: ready && !credentialsDirty && (tested || cfg.enabled), run: () => enableRef.current?.focus() },
        ].map((step, index) => <button type="button" key={step.title} className="setup-step" data-current={step.current} data-done={step.done} onClick={step.run}>
          <span className="setup-step-number">{step.done ? <Check size={13} /> : index + 1}</span>
          <span><span className="block text-[12px] font-semibold">{step.title}</span><span className="step-note mt-0.5 block text-[11px] text-ink-500">{step.note}</span></span>
        </button>)}
      </div>
      <div role="status" aria-live="polite" className="border-t border-ink-100 bg-surface-hover px-4 py-2.5 text-[12px] leading-relaxed text-ink-500">
        {saving ? "正在保存…" : credentialsDirty ? "凭据有未保存更改，请先保存再测试或开启。" : !ready ? "请先配置当前渠道；配置完成前不会发送消息。" : payload.quiet && cfg.enabled ? "当前处于免打扰时段；手动发送仍会占用小时额度。" : "配置已同步，试算不会真实发送。"}
      </div>
      </div>
      <div className="grid grid-cols-3 gap-3 px-1 py-1">
        {[{ label: "近 24 小时已推", value: payload.stats.sentLast24h }, { label: "等待攒批", value: payload.stats.queued }, { label: "本小时剩余额度", value: Math.max(0, num(s.maxPerHour, 24) - payload.stats.sentLastHour) }].map((metric) => <div key={metric.label} className="border-l-2 border-ink-200 pl-3">
          <span className="block font-mono text-[20px] font-semibold tabular-nums text-ink-900">{metric.value}</span>
          <span className="text-[11.5px] text-ink-500">{metric.label}</span>
        </div>)}
      </div>

      {cfg.lastError && (
        <div className="panel border-alert-border bg-alert-subtle p-3.5 text-[12px] text-alert">
          最近一次失败：{cfg.lastError}
          {cfg.consecutiveFails > 0 ? `（连续失败 ${cfg.consecutiveFails} 次，达 3 次会自动停用）` : ""}
        </div>
      )}

      <div className="settings-layout grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <section ref={credentialsRef} className="panel space-y-4 p-5">
          <div className="settings-section-title">
            <KeyRound size={14} className="text-accent" /> {viaWebhook ? "Webhook 凭据" : "Bot 凭据"}
            <span className="ml-auto rounded-full bg-canvas-subtle px-2 py-0.5 text-[10.5px] font-medium text-ink-600">
              {cfg.settings.deliverVia === "webhook" ? "Webhook" : "Telegram"}
            </span>
          </div>
          <div className="flex gap-1.5">
            {(["telegram", "webhook"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={async () => {
                  if (credentialsDirty && !window.confirm("切换渠道会放弃当前未保存的凭据更改，继续吗？")) return;
                  if (await save({ deliverVia: v, enabled: false })) {
                    setTokenInput(""); setChatInput(cfg.chatId);
                    setWebhookInput(str(cfg.settings.webhookUrl, "")); setSecretInput(str(cfg.settings.webhookSecret, ""));
                    setDetected([]);
                    notify("渠道已切换，推送保持关闭；保存凭据并测试后再开启");
                  }
                }}
                className={
                  "flex-1 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors " +
                  (cfg.settings.deliverVia === v
                    ? "border-ink-950 bg-ink-950 text-white"
                    : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100")
                }
              >
                {v === "telegram" ? "Telegram Bot" : "Webhook"}
              </button>
            ))}
          </div>
          {cfg.settings.deliverVia === "webhook" ? (
            <>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-700">Webhook 地址</span>
                <input
                  value={webhookInput}
                  onChange={(e) => setWebhookInput(e.target.value)}
                  placeholder="https://你的公开推送服务/webhook"
                  className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-accent"
                />
                <span className="mt-1 block text-[11px] text-ink-500">
                  接收 POST JSON：source / text / sentAt。公开站不允许本机、内网地址或重定向，请填最终地址。
                </span>
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-700">校验密钥（可选）</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secretInput}
                  onChange={(e) => setSecretInput(e.target.value)}
                  placeholder="会以 X-Radar-Secret 头发送"
                  className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-accent"
                />
              </label>
              <button type="button" onClick={async () => {
                if (await save({ webhookUrl: webhookInput.trim(), webhookSecret: secretInput.trim() })) {
                  setWebhookInput(webhookInput.trim()); setSecretInput(secretInput.trim()); notify("Webhook 凭据已保存");
                }
              }} className="rounded-lg bg-ink-950 px-3 py-1.5 text-[12px] font-medium text-white">保存 Webhook</button>
            </>
          ) : null}
          {!viaWebhook && <>
          <label className="block">
            <span className="text-[12px] font-medium text-ink-700">Bot Token</span>
            <input
              value={tokenInput}
              type="password"
              autoComplete="new-password"
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={cfg.hasToken ? `已保存：${cfg.botTokenMask}` : "123456789:AA..."}
              className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-accent"
            />
            <span className="mt-1 block text-[11px] text-ink-500">
              在 @BotFather 建 Bot 拿 Token；服务端加密存储，接口只回显打码值。
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => {
                if (!tokenInput.trim()) return notify("先粘贴 Bot Token");
                setBusy("token");
                try {
                  const ok = await save({ botToken: tokenInput.trim() });
                  if (ok) {
                    setTokenInput("");
                    notify("Token 已保存");
                  }
                } finally {
                  setBusy(null);
                }
              }}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink-950 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-hover disabled:opacity-60"
            >
              {busy === "token" ? <Loader2 size={12} className="animate-spin" /> : null}
              保存 Token
            </button>
            <button
              type="button"
              onClick={async () => {
                setBusy("detect");
                try {
                  const res = await fetch("/api/me/push/detect-chat", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ botToken: tokenInput.trim() || undefined }),
                  });
                  const data = (await res.json().catch(() => ({}))) as { error?: string; chats?: typeof detected };
                  if (!res.ok) notify(data.error ?? "探测失败");
                  else {
                    setDetected(data.chats ?? []);
                    notify((data.chats?.length ?? 0) ? `探测到 ${data.chats!.length} 个会话` : "没探测到会话，先给 Bot 发一句 /start");
                  }
                } catch {
                  notify("网络异常，探测失败，请重试");
                } finally {
                  setBusy(null);
                }
              }}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-60"
            >
              {busy === "detect" ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              探测 Chat ID
            </button>
            {cfg.hasToken && (
              <button
                type="button"
                onClick={async () => {
                  if (!window.confirm("清除 Token 会关闭 Telegram 推送，继续吗？")) return;
                  if (await save({ clearToken: true, enabled: false })) notify("Token 已清除，推送已关闭");
                }}
                className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-medium text-alert hover:bg-ink-100"
              >
                清除 Token
              </button>
            )}
          </div>

          {detected.length > 0 && (
            <div className="rounded-lg border border-ink-200 bg-surface-hover p-2.5">
              <div className="mb-1.5 text-[11.5px] font-medium text-ink-700">点击填入 Chat ID</div>
              <div className="flex flex-wrap gap-1.5">
                {detected.map((c) => (
                  <button
                    key={c.chatId}
                    type="button"
                    onClick={() => setChatInput(c.chatId)}
                    className="rounded-md border border-ink-200 bg-surface px-2 py-1 text-[11.5px] text-ink-700 hover:bg-ink-100"
                  >
                    {c.title} · {c.chatId}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="block">
            <span className="text-[12px] font-medium text-ink-700">Chat ID</span>
            <div className="mt-1 flex gap-2">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="你的私聊或频道 ID"
                className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={async () => {
                  const ok = await save({ chatId: chatInput.trim() });
                  if (ok) notify("Chat ID 已保存");
                }}
                className="shrink-0 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100"
              >
                保存
              </button>
            </div>
          </label>

          </>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              ref={testButtonRef}
              onClick={async () => {
                setBusy("test");
                try {
                  const res = await fetch("/api/me/push/test", { method: "POST" });
                  const data = (await res.json().catch(() => ({}))) as { error?: string };
                  notify(res.ok ? "测试消息已发出" : (data.error ?? "发送失败"));
                  if (res.ok) setTested(true);
                  void loadLogs();
                } catch {
                  notify("网络异常，无法确认发送结果，请查看推送记录");
                } finally {
                  setBusy(null);
                }
              }}
              disabled={busy !== null || !ready || credentialsDirty}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-50"
            >
              {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} 发测试消息
            </button>
            <button
              type="button"
              onClick={async () => {
                setBusy("flush");
                try {
                  if (payload.quiet && !window.confirm("当前是免打扰时段，仍要发送自己的攒批队列吗？")) return;
                  const res = await fetch("/api/me/push/flush", { method: "POST" });
                  const data = (await res.json().catch(() => ({}))) as { sent?: number; queued?: number; error?: string };
                  notify(res.ok ? `已发 ${data.sent ?? 0} 条，队列剩 ${data.queued ?? 0}` : (data.error ?? "发送失败"));
                  await load();
                  void loadLogs();
                } catch {
                  notify("网络异常，无法确认发送结果，请查看推送记录");
                } finally {
                  setBusy(null);
                }
              }}
              disabled={busy !== null || !cfg.enabled || credentialsDirty || !payload.stats.queued}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-50"
            >
              {busy === "flush" ? <Loader2 size={12} className="animate-spin" /> : <ListOrdered size={12} />} 立即发攒批
            </button>
          </div>
        </section>

        <section className="panel space-y-4 p-5">
          <div className="settings-section-title">
            <Clock size={14} className="text-accent" /> 推送节奏
          </div>
          <p className="text-[12px] leading-relaxed text-ink-500">达到单发分数立即发送，其余符合攒批分数的内容定时汇总。分数越高，推送越少。</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[12px] text-ink-700">立即单发阈值</span>
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={num(s.instantScore, 70)}
                key={`instant-${num(s.instantScore, 70)}`}
                onBlur={(e) => void save({ instantScore: Number(e.target.value) })}
                className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink-950 outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-ink-700">攒批阈值</span>
              <input
                type="number"
                min={0}
                max={100}
                defaultValue={num(s.batchScore, 60)}
                key={`batch-${num(s.batchScore, 60)}`}
                onBlur={(e) => void save({ batchScore: Number(e.target.value) })}
                className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink-950 outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 overflow-hidden rounded-md border border-ink-200 text-[11.5px]">
            <div className="bg-brand-subtle px-3 py-2 text-accent">≥ {num(s.instantScore, 70)} 分 · 立即单发</div>
            <div className="bg-surface-hover px-3 py-2 text-ink-600">{num(s.batchScore, 60) < num(s.instantScore, 70) ? `${num(s.batchScore, 60)}–${num(s.instantScore, 70) - 1} 分 · 攒批` : "同分阈值 · 超额转攒批"}</div>
          </div>
          <label className="block">
            <span className="text-[12px] text-ink-700">每小时推送上限</span>
            <input
              type="number"
              min={1}
              max={payload.caps.maxPerHour}
              defaultValue={num(s.maxPerHour, 24)}
              key={`hourly-${num(s.maxPerHour, 24)}`}
              onBlur={(e) => void save({ maxPerHour: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink-950 outline-none focus:border-accent"
            />
            <span className="mt-1 block text-[11px] text-ink-500">站点上限 {payload.caps.maxPerHour} 条/小时</span>
          </label>
          <label className="block">
            <span className="text-[12px] text-ink-700">攒批周期</span>
            <select
              value={num(s.batchIntervalMin, 30)}
              onChange={(e) => void save({ batchIntervalMin: Number(e.target.value) })}
              className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12.5px] text-ink-950 outline-none focus:border-accent"
            >
              <option value={0}>关闭攒批</option>
              <option value={5}>每 5 分钟</option>
              <option value={10}>每 10 分钟</option>
              <option value={30}>每 30 分钟</option>
              <option value={60}>每 1 小时</option>
              <option value={120}>每 2 小时</option>
            </select>
          </label>
          <details className="border-t border-ink-100 pt-3">
          <summary className="cursor-pointer text-[12.5px] font-medium text-ink-700">免打扰与其他偏好 <span className="ml-1 text-[11px] font-normal text-ink-500">{bool(s.quietEnabled, true) ? str(s.quietHours, "23:30-08:00") : "未开启免打扰"}</span></summary>
          <div className="mt-3 space-y-1.5 rounded-lg border border-ink-200 bg-surface-hover p-3">
            <label className="flex items-center justify-between gap-2 text-[12px] text-ink-700">
              <span className="inline-flex items-center gap-1.5">
                <Moon size={12} className="text-ink-500" /> 夜间免打扰
              </span>
              <input
                type="checkbox"
                checked={bool(s.quietEnabled, true)}
                onChange={(e) => void save({ quietEnabled: e.target.checked })}
                className="h-3.5 w-3.5 accent-[#111318]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[12px] text-ink-700">
              <span>时段</span>
              <input
                defaultValue={str(s.quietHours, "23:30-08:00")}
                onBlur={(e) => void save({ quietHours: e.target.value })}
                className="w-[130px] rounded border border-ink-200 bg-surface px-2 py-1 font-mono text-[11.5px] text-ink-900 outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[12px] text-ink-700">
              <span>时区</span>
              <select
                value={str(s.timezone, "Asia/Shanghai")}
                onChange={(e) => void save({ timezone: e.target.value })}
                className="rounded border border-ink-200 bg-surface px-2 py-1 text-[11.5px] text-ink-900 outline-none focus:border-accent"
              >
                <option value="Asia/Shanghai">北京时间</option>
                <option value="Asia/Tokyo">东京时间</option>
                <option value="UTC">UTC</option>
                <option value="America/New_York">美东时间</option>
                <option value="Europe/London">伦敦时间</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 pt-1 text-[12px] text-ink-700">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={cfg.useGlobalBlocks}
                onChange={(e) => void save({ useGlobalBlocks: e.target.checked })}
                className="h-3.5 w-3.5 accent-[#111318]"
              />
              继承全站噪音屏蔽词
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={cfg.dailyEnabled}
                onChange={(e) => void save({ dailyEnabled: e.target.checked })}
                className="h-3.5 w-3.5 accent-[#111318]"
              />
              每天发一份个人日报
            </label>
          </div>
          </details>
        </section>
      </div>

      <section className="panel space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-950">
              <Sparkles size={14} className="text-accent" /> 实时效果预览（不会真正发出）
            </div>
            <p className="mt-0.5 text-[12px] text-ink-500">用最近 180 条按你的规则试算，看命中和被拦原因分布。</p>
          </div>
          <button
            type="button"
            onClick={async () => {
              setBusy("preview");
              try {
                const res = await fetch("/api/me/push/preview");
                if (res.ok) setPreview((await res.json()) as Preview);
                else notify(((await res.json()) as { error?: string }).error ?? "试算失败");
              } catch {
                notify("网络异常，试算失败，请重试");
              } finally {
                setBusy(null);
              }
            }}
            disabled={busy !== null || credentialsDirty}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-950 px-3.5 py-2 text-[12.5px] font-medium text-white hover:bg-brand-hover disabled:opacity-50"
          >
            {busy === "preview" ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />} 试算
          </button>
        </div>

        {preview && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-ink-200 bg-surface-hover px-3 py-2 text-[11.5px]">
              <span className="font-medium text-ink-700">
                扫描 {preview.scanned} 条 · 通过 {preview.matched} 条 · 队列中 {preview.queued} 条
              </span>
              {Object.entries(preview.rejectedBy).map(([k, v]) => (
                <span key={k} className="rounded bg-ink-100 px-2 py-0.5 text-ink-600">
                  {REJECTION_LABEL[k] ?? k} <span className="font-mono font-medium">{v}</span>
                </span>
              ))}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-ink-200 bg-surface-hover p-3">
                <div className="mb-1.5 text-[12px] font-medium text-deal">⚡ 会立即推送</div>
                <pre className="max-h-[200px] overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-700">
                  {preview.instant.length ? preview.instant.join("\n") : "（当前条件下没有立即推送的条目）"}
                </pre>
              </div>
              <div className="rounded-lg border border-ink-200 bg-surface-hover p-3">
                <div className="mb-1.5 text-[12px] font-medium text-brand">📦 会进攒批</div>
                <pre className="max-h-[200px] overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-700">
                  {preview.batch.length ? preview.batch.join("\n") : "（当前条件下没有攒批条目）"}
                </pre>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <span className="text-[13.5px] font-semibold text-ink-950">我的推送记录</span>
          <div className="flex items-center gap-3 text-[11.5px] text-ink-500">
            <span>近 24h 已发 {payload.stats.sentLast24h}</span>
            <span>队列 {payload.stats.queued}</span>
            <button
              type="button"
              onClick={() => void loadLogs()}
              className="font-medium text-accent hover:underline"
            >
              刷新
            </button>
          </div>
        </div>
        <div className="max-h-[360px] divide-y divide-ink-100 overflow-auto">
          {logs.length === 0 && <div className="px-5 py-8 text-center text-[12.5px] text-ink-500">{logsLoading ? "正在加载记录…" : "暂无推送记录"}</div>}
          {logs.map((l) => (
            <div key={l.id} className="px-5 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                <span className="rounded-md bg-ink-100 px-2 py-0.5 font-medium text-ink-700">
                  {l.kind === "instant" ? "即时" : l.kind === "batch" ? "攒批" : l.kind}
                </span>
                <span className="font-mono text-ink-500">{l.created_at.replace("T", " ").slice(5, 19)}</span>
                <span className="text-ink-600">{l.count} 条</span>
                {l.ok === 0 && <span className="rounded bg-alert-subtle px-1.5 py-0.5 text-alert">失败</span>}
                {l.reason && <span className="truncate text-ink-500">· {l.reason}</span>}
              </div>
              <pre className="mt-1 max-h-[64px] overflow-hidden font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-600">
                {(l.text ?? "").slice(0, 200)}
              </pre>
              {l.error && <div className="mt-1 font-mono text-[11px] text-alert">{l.error}</div>}
            </div>
          ))}
        </div>
      </section>

      {boot.siteMode === "public" && !boot.isAdmin && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-200 pt-4 text-[12px]">
          <span className="text-ink-500">还想细调？</span>
          <a href="#push" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">分类、价格与路由规则 <ChevronRight size={12} /></a>
          <a href="#rules" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">关注词与屏蔽词 <ChevronRight size={12} /></a>
        </div>
      )}
    </fieldset>
  );
}
