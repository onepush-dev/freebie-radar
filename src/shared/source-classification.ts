import { isCategory, type Category } from "./taxonomy.ts";

export type SourceHints = {
  kindHint?: string | null;
  categoryHint?: string | null;
  /** Empty string explicitly opts out of a built-in fixed category. */
  fixedCategory?: string | null;
  guardEnabled?: boolean;
};

/** Resource sharing is not a claimable promotion, regardless of its title keywords. */
export const DEFAULT_FIXED_CATEGORIES: Readonly<Record<string, Category>> = {
  "linuxdo-resource": "pan",
};

export function fixedCategoryForSource(sourceId: string, hints?: SourceHints): Category | null {
  const value = hints?.fixedCategory === undefined ? DEFAULT_FIXED_CATEGORIES[sourceId] : hints.fixedCategory;
  return isCategory(value) ? value : null;
}

/** Hard source routing always wins over keywords, per-feed fallback hints and AI. */
export function categoryForSource<T extends string | null>(sourceId: string, proposed: T, hints?: SourceHints): T | Category {
  return fixedCategoryForSource(sourceId, hints) ?? proposed;
}
