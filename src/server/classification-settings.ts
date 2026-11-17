import { get, run } from "./db.ts";

export function getClassificationSettings(): { guardEnabled: boolean } {
  try {
    const row = get<{ value: string }>("SELECT value FROM settings WHERE key = 'classification'");
    const value = JSON.parse(row?.value ?? "{}") as { guardEnabled?: unknown };
    return { guardEnabled: typeof value.guardEnabled === "boolean" ? value.guardEnabled : true };
  } catch { return { guardEnabled: true }; }
}

export function saveClassificationSettings(guardEnabled: boolean): { guardEnabled: boolean } {
  run("INSERT INTO settings(key,value,updated_at) VALUES('classification',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    JSON.stringify({ guardEnabled }), new Date().toISOString());
  return { guardEnabled };
}
