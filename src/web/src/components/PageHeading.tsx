import type { ReactNode } from "react";

/** A quiet, consistent page hierarchy; metrics and actions stay secondary to the task. */
export function PageHeading({ eyebrow, title, description, actions }: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return <div className="page-heading">
    <div className="min-w-0">
      {eyebrow && <p className="mb-1 text-[11px] font-semibold tracking-wide text-ink-500">{eyebrow}</p>}
      <h2 className="text-[20px] font-semibold leading-tight tracking-tight text-ink-950 sm:text-[22px]">{title}</h2>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-500">{description}</p>
    </div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
  </div>;
}
