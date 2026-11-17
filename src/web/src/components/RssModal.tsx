import { useState } from "react";
import { Check, Copy, Globe2, Lock, X } from "lucide-react";
import type { Bootstrap } from "../lib/session.ts";

function CopyRow({ label, hint, url }: { label: string; hint: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-ink-200 bg-surface-hover p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink-900">{label}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* 剪贴板不可用时用户可手动选中 */
            }
          }}
          className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-2 py-1 text-[11.5px] font-medium text-ink-700 hover:bg-ink-100"
        >
          {copied ? <Check size={12} className="text-deal" /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{hint}</p>
      <code className="mt-1.5 block overflow-x-auto rounded border border-ink-200 bg-surface px-2 py-1.5 font-mono text-[11px] whitespace-nowrap text-ink-700">
        {url}
      </code>
    </div>
  );
}

/**
 * RSS 订阅助手：把「当前筛选」直接变成一条订阅地址，
 * 登录用户还能拿到带个人屏蔽规则的专属地址。
 */
export function RssModal({
  boot,
  currentQuery,
  onClose,
}: {
  boot: Bootstrap;
  currentQuery: string;
  onClose: () => void;
}) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const qs = currentQuery.replace(/^\?/, "").replace(/&?limit=\d+/, "");
  const publicUrl = origin + "/rss.xml" + (qs ? "?" + qs : "");
  const user = boot.user;

  return (
    <div className="backdrop-enter fixed inset-0 z-[70] flex items-center justify-center bg-ink-950/35 px-4">
      <div className="sheet-enter panel w-full max-w-[520px] overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Globe2 size={15} className="text-accent" />
            <div>
              <h2 className="text-[15px] font-semibold text-ink-950">RSS 订阅</h2>
              <p className="mt-0.5 text-[11.5px] text-ink-500">丢进任意阅读器即可，公开源不需要登录</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-900"
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="max-h-[62vh] space-y-2.5 overflow-auto px-5 py-4">
          <CopyRow label="公开订阅（按当前筛选）" hint="套用全站屏蔽词与跨源去重，任何人都能订阅" url={publicUrl} />
          <CopyRow
            label="公开订阅（真福利精选）"
            hint="固定按「真福利」频道输出，不受当前筛选影响"
            url={origin + "/rss.xml?preset=verified&limit=50"}
          />

          {user ? (
            <>
              <div className="pt-1 text-[11.5px] font-medium text-ink-500">我的专属订阅</div>
              <CopyRow
                label="个人订阅（常规）"
                hint="自动排除你点过「不想看」的条目，并套用你的个人屏蔽词"
                url={origin + "/rss/u/" + user.rssToken + ".xml"}
              />
              <CopyRow
                label="个人订阅（按推送规则）"
                hint="完全按你在「我的推送」里设的分数、分类、获取方式过滤"
                url={origin + "/rss/u/" + user.rssToken + ".xml?mode=push"}
              />
              <CopyRow
                label="个人订阅（只看关注词）"
                hint="只输出命中你关注关键词的条目"
                url={origin + "/rss/u/" + user.rssToken + ".xml?mode=subs"}
              />
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-500">
                <Lock size={11} className="mt-0.5 shrink-0" />
                这条链接本身就是凭据，别贴到公开场合；泄露了就到「我的」里重置 Token。
              </p>
            </>
          ) : (
            <p className="rounded-md border border-ink-200 bg-surface-hover px-3 py-2 text-[11.5px] leading-relaxed text-ink-600">
              登录后还能拿到带个人屏蔽规则的专属订阅地址。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}