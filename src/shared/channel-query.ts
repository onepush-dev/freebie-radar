import { channelExcluded } from "./taxonomy.ts";

/** Shared by API, exports and RSS. Explicit selectors can narrow a channel, never evade its exclusions. */
export function applyChannelQuery(input: Record<string, string | undefined>): Record<string, string | undefined> {
  const q = { ...input };
  const defaults: Record<string, Record<string, string>> = {
    verified: { unexpired: "1", aiOnly: "1", kind: "freebie", obtain: "free,conditional", maxAgeDays: "7" },
    pan: { unexpired: "1", hideRejected: "1", category: "pan,course", kind: "freebie,deal,info,opensource,news" },
    offline: { unexpired: "1", hideRejected: "1", category: "offline" },
    deal: { unexpired: "1", hideRejected: "1", kind: "deal" },
    opensource: { hideRejected: "1", kind: "opensource" },
    news: { hideRejected: "1", kind: "news" },
    info: { hideRejected: "1", kind: "info" },
    codes: { unexpired: "1", hasCodes: "1" },
    urgent: { expiring: "1" },
    starred: { starred: "1" },
    hidden: { status: "ignored" },
    all: { hideRejected: "1" },
  };
  for (const [key, value] of Object.entries(defaults[q.preset ?? ""] ?? {})) {
    if (q[key] === undefined) q[key] = value;
  }
  const excluded = [...new Set([...channelExcluded(q.preset ?? ""), ...(q.excludeCategory ?? "").split(",").filter(Boolean)])];
  if (excluded.length) q.excludeCategory = excluded.join(",");
  return q;
}
