import { all, get, run } from "./db.ts";
import { DEFAULT_FIXED_CATEGORIES, fixedCategoryForSource, type SourceHints } from "../shared/source-classification.ts";
import { getClassificationSettings } from "./classification-settings.ts";
import type { ContentKind } from "../shared/taxonomy.ts";

export type ManualClassification = { category: string | null; kind: ContentKind | null; note: string; updated_at: string };
export function getManualClassification(itemId: number): ManualClassification | null {
  return get<ManualClassification>("SELECT category,kind,note,updated_at FROM item_classification_overrides WHERE item_id = ?", itemId) ?? null;
}
export function applyManualClassification(itemId: number, category: string | null, kind: ContentKind): { category: string | null; kind: ContentKind } {
  const manual = getManualClassification(itemId);
  return { category: manual?.category ?? category, kind: manual?.kind ?? kind };
}

export function getSourceHints(sourceId: string): SourceHints {
  const row = get<{ config: string }>("SELECT config FROM sources WHERE id = ?", sourceId);
  let cfg: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row?.config ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
  } catch { /* defaults */ }
  const text = (key: string) => typeof cfg[key] === "string" ? (cfg[key] as string).trim() : null;
  return {
    kindHint: text("kindHint"),
    categoryHint: text("categoryHint"),
    fixedCategory: text("fixedCategory") ?? DEFAULT_FIXED_CATEGORIES[sourceId] ?? "",
    guardEnabled: getClassificationSettings().guardEnabled,
  };
}

/** No AI, no push and no deletion: update all retained rows, including favourites. */
export function reconcileSourceCategory(sourceId: string): number {
  const category = fixedCategoryForSource(sourceId, getSourceHints(sourceId));
  if (!category) return 0;
  const result = run(
    `UPDATE items SET category = ?,
       ai = CASE WHEN json_valid(ai) THEN CASE WHEN json_type(ai) = 'object' THEN json_set(ai, '$.category', ?) ELSE ai END ELSE ai END
     WHERE source_id = ? AND NOT EXISTS (SELECT 1 FROM item_classification_overrides o WHERE o.item_id=items.id AND o.category IS NOT NULL) AND (category IS NOT ? OR
       CASE WHEN json_valid(ai) THEN json_extract(ai, '$.category') IS NOT ? ELSE 0 END)`,
    category, category, sourceId, category, category,
  );
  return Number(result.changes);
}

export function reconcileFixedSourceCategories(): number {
  return all<{ id: string }>("SELECT id FROM sources").reduce((count, source) => count + reconcileSourceCategory(source.id), 0);
}
