import { useEffect, useState } from "react";
import { Loader2, Pencil, RotateCcw } from "lucide-react";
import { CATEGORY_LABEL, KIND_LABEL } from "../lib/sources.ts";
import { categoryOptionGroups } from "../../../shared/taxonomy.ts";
import type { Item } from "../types.ts";

export type ClassificationPatch = { category: string | null; kind: string | null; note?: string } | { clear: true };
export function ItemClassificationEditor({ item, onSave }: { item: Item; onSave: (id: number, patch: ClassificationPatch) => Promise<void> }) {
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const manual = item.manualClassification;
  useEffect(() => {
    setCategory(manual?.category ?? ""); setKind(manual?.kind ?? ""); setNote(manual?.note ?? "");
    setError(""); setNotice("");
  }, [item.id, manual?.category, manual?.kind, manual?.note]);
  const perform = async (patch: ClassificationPatch) => {
    setBusy(true); setError(""); setNotice("");
    try { await onSave(item.id, patch); setNotice("clear" in patch ? "已恢复自动分类（仍遵守来源固定规则）" : "人工分类已保存，后续采集和重审不会覆盖"); }
    catch (e) { setError(e instanceof Error ? e.message : "分类保存失败"); }
    finally { setBusy(false); }
  };
  return <details className="rounded-lg border border-brand-border bg-brand-subtle/30 p-3">
    <summary className="cursor-pointer text-[12.5px] font-medium text-accent"><Pencil size={12} className="mr-1 inline" /> 调整分类（管理员）{manual ? " · 人工分类已锁定" : ""}</summary>
    <fieldset disabled={busy} className="mt-3 min-w-0 space-y-3">
      <p className="text-[11.5px] leading-relaxed text-ink-600">这是全站分类。人工设置优先于源固定规则、关键词和 AI；不会触发推送，也不会把 AI 拒绝的内容重新放行。“网盘资源”改分类即可；“好价 → 资讯”需要同时改内容形态。</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[12px] text-ink-700">人工分类<select aria-label="人工分类" value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 block w-full rounded-md border border-ink-200 bg-surface px-2 py-2">
          <option value="">保持自动分类</option>
          {categoryOptionGroups().map((group) => <optgroup key={group.label} label={group.label}>{group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>)}
        </select></label>
        <label className="block text-[12px] text-ink-700">人工内容形态<select aria-label="人工内容形态" value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block w-full rounded-md border border-ink-200 bg-surface px-2 py-2">
          <option value="">保持自动形态</option>
          {Object.entries(KIND_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
      </div>
      <p className="text-[11px] text-ink-500">当前：{KIND_LABEL[item.kind ?? ""] ?? "未识别"} / {CATEGORY_LABEL[item.category ?? "other"] ?? item.category}</p>
      <label className="block text-[12px] text-ink-700">纠正备注（可选）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="例如：旅客经历，不是促销" className="mt-1 block w-full rounded-md border border-ink-200 bg-surface px-3 py-2" /></label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!category && !kind} onClick={() => void perform({ category: category || null, kind: kind || null, note })} className="inline-flex items-center gap-1 rounded-md bg-brand px-3 py-2 text-[12px] font-medium text-white disabled:opacity-40">{busy && <Loader2 size={12} className="animate-spin" />} 保存人工分类</button>
        {manual && <button type="button" onClick={() => {
          if (window.confirm("取消该条目的人工分类并恢复当前自动规则？来源固定分类仍会生效。")) void perform({ clear: true });
        }} className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-3 py-2 text-[12px] text-ink-700"><RotateCcw size={12} /> 恢复自动分类</button>}
      </div>
      {(error || notice) && <p role={error ? "alert" : "status"} className={"text-[12px] " + (error ? "text-alert" : "text-deal")}>{error || notice}</p>}
    </fieldset>
  </details>;
}
