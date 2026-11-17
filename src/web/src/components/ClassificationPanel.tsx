import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { categoryLabel, KIND_LABEL } from "../lib/sources.ts";
import type { Source } from "../types.ts";

type Audit = {
  scanned: number; updated: number; rerouted: number;
  samples: { id: number; title: string; sourceId: string; fromKind: string | null; toKind: string | null; fromCategory: string | null; toCategory: string | null }[];
};
type Preview = { ruleKind: string; finalKind: string; category: string; signals: Record<string, boolean>; hints: { fixedCategory?: string }; note: string };

export function ClassificationPanel({ sources, onChanged }: { sources: Source[]; onChanged: () => void }) {
  const [enabled, setEnabled] = useState(true);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [title, setTitle] = useState("全美航班停飞4小时，普通旅客当天实际遇到了什么");
  const [summary, setSummary] = useState("");
  const [sourceId, setSourceId] = useState("rss-smzdm");
  const [aiKind, setAiKind] = useState("news");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/classification");
    if (!response.ok) throw new Error("无法读取分类设置，请重试");
    const data = await response.json() as { settings: { guardEnabled: boolean }; audit: Audit };
    setEnabled(data.settings.guardEnabled); setAudit(data.audit);
  }, []);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); }
  };
  const call = async (path: string, body: unknown, method = "POST") => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error ?? "操作失败"));
    return data;
  };
  return <fieldset disabled={busy} className="panel space-y-4 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink-950"><ShieldCheck size={16} className="text-accent" /> 分类证据校验</h3>
        <p className="mt-1 max-w-3xl text-[12px] leading-relaxed text-ink-500">好价必须有促销或交易证据，福利必须有领取对象。来源倾向和 AI 输出都要过校验；固定分类在每个数据源的“编辑”里设置。</p>
      </div>
      <button type="button" role="switch" aria-checked={enabled} aria-label="分类证据校验" onClick={() => void perform(async () => {
        await call("/api/admin/classification", { guardEnabled: !enabled }, "PATCH");
        setPreview(null); await load(); setNotice(enabled ? "已关闭证据校验，恢复宽松分类" : "已开启证据校验；可检查并修正历史误分");
      })} className={"rounded-md border px-3 py-2 text-[12px] font-medium " + (enabled ? "border-deal-border bg-deal-subtle text-deal" : "border-ink-200 text-ink-600")}>{enabled ? "校验已开启" : "校验已关闭"}</button>
    </div>
    {(error || notice) && <p role={error ? "alert" : "status"} className={"text-[12px] " + (error ? "text-alert" : "text-deal")}>{error || notice}</p>}
    <details className="rounded-lg border border-ink-200 bg-surface-hover p-3">
      <summary className="cursor-pointer text-[12.5px] font-medium text-ink-700">检查历史分类{audit ? ` · 已扫描 ${audit.scanned} 条，${audit.rerouted} 条分类待修正` : " · 载入中"}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-[11.5px] text-ink-500">检查最近最多 6000 条有效资源；修正分类并重算分数，不调用付费 AI、不触发推送、不改变收藏和隐藏状态。新规则无法保证零误判，请先查看样本。</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void perform(load)} className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-3 py-1.5 text-[12px]"><RefreshCw size={12} /> 重新检查</button>
          <button type="button" disabled={!audit?.rerouted} onClick={() => {
            if (!window.confirm("按当前分类规则修正最近 6000 条资源？不会调用 AI 或推送。")) return;
            void perform(async () => {
              const result = await call("/api/admin/classification/reclassify", {});
              onChanged(); await load(); setNotice(`已修正 ${result.rerouted ?? 0} 条分类，重算 ${result.updated ?? 0} 条分数`);
            });
          }} className="rounded-md bg-brand px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40">修正历史误分（0 Token）</button>
        </div>
        <div className="max-h-64 divide-y divide-ink-100 overflow-auto">
          {audit?.samples.map((sample) => <div key={sample.id} className="py-2 text-[12px]">
            <p className="font-medium text-ink-900">{sample.title}</p>
            <p className="mt-0.5 text-ink-500">{sources.find((s) => s.id === sample.sourceId)?.name ?? sample.sourceId} · {KIND_LABEL[sample.fromKind ?? ""] ?? sample.fromKind} / {categoryLabel(sample.fromCategory ?? "other")} → <span className="text-accent">{KIND_LABEL[sample.toKind ?? ""] ?? sample.toKind} / {categoryLabel(sample.toCategory ?? "other")}</span></p>
          </div>)}
        </div>
      </div>
    </details>
    <details className="rounded-lg border border-ink-200 p-3">
      <summary className="cursor-pointer text-[12.5px] font-medium text-ink-700">试算标题与误判反例（不调用 AI）</summary>
      <div className="mt-3 space-y-3">
        <label className="block text-[12px] text-ink-700">标题<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className="mt-1 block w-full rounded-md border border-ink-200 px-3 py-2" /></label>
        <label className="block text-[12px] text-ink-700">摘要（可选）<textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} rows={2} className="mt-1 block w-full rounded-md border border-ink-200 px-3 py-2" /></label>
        <div className="flex flex-wrap gap-2">
          <label className="text-[12px] text-ink-700">来源<select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className="ml-2 max-w-full rounded-md border border-ink-200 px-2 py-2"><option value="">普通未指定源</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="text-[12px] text-ink-700">模拟 AI 判定<select value={aiKind} onChange={(e) => setAiKind(e.target.value)} className="ml-2 rounded-md border border-ink-200 px-2 py-2"><option value="">未给形态</option>{Object.entries(KIND_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <button type="button" disabled={!title.trim()} onClick={() => void perform(async () => { setPreview(await call("/api/admin/classification/preview", { title, summary, sourceId, aiKind }) as unknown as Preview); })} className="inline-flex items-center gap-1 rounded-md bg-brand px-3 py-2 text-[12px] text-white">{busy ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} 规则试算</button>
        </div>
        {preview && <div role="status" className="rounded-md bg-brand-subtle p-3 text-[12px] leading-relaxed text-accent">
          规则：{KIND_LABEL[preview.ruleKind]} · 校验后：{KIND_LABEL[preview.finalKind]} · 分类：{categoryLabel(preview.category)}
          <p className="mt-1 text-ink-600">领取证据 {preview.signals.claim ? "有" : "无"} / 促销证据 {preview.signals.promotion ? "有" : "无"} / 新闻叙述 {preview.signals.editorial ? "有" : "无"} / 开源证据 {preview.signals.repository ? "有" : "无"}{preview.hints.fixedCategory ? ` · 源固定分类 ${categoryLabel(preview.hints.fixedCategory)}` : ""}</p>
          <p className="mt-1 text-[11px] text-ink-500">{preview.note}</p>
        </div>}
      </div>
    </details>
  </fieldset>;
}
