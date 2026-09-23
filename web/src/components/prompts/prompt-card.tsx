import { Copy, FileText, ImagePlus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    onSetCover,
    actionLabel,
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
    compact = false,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    /** 只有内置风格源会传，用来把用户自己的图设成这张风格卡的封面。 */
    onSetCover?: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
    compact?: boolean;
}) {
    const { i18n, t } = useTranslation();
    return (
        <article className={`group flex min-w-0 flex-col overflow-hidden rounded-[16px] border border-black/[0.08] bg-black/[0.015] transition duration-200 hover:-translate-y-0.5 hover:border-black/[0.17] dark:border-white/[0.08] dark:bg-white/[0.025] dark:hover:border-white/[0.17] ${compact ? "cursor-pointer" : "h-full"}`}>
            <div className="relative">
                <button type="button" className="block w-full cursor-pointer overflow-hidden text-left" onClick={onOpen}>
                    {item.coverUrl ? <img src={item.coverUrl} alt={item.title} className={compact ? "aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]" : "aspect-[16/10] w-full object-cover transition-transform duration-300 group-hover:scale-[1.018]"} loading="lazy" /> : <span className={compact ? "grid aspect-square w-full place-items-center bg-black/[0.025] text-stone-400 dark:bg-white/[0.025] dark:text-zinc-600" : "grid aspect-[16/10] w-full place-items-center bg-black/[0.025] text-stone-400 dark:bg-white/[0.025] dark:text-zinc-600"}><FileText className="size-7" /></span>}
                </button>
                {/* 按钮放在封面按钮外层，避免 button 嵌套 button；悬停或已有封面常显，平时不干扰浏览。 */}
                {onSetCover ? (
                    <button
                        type="button"
                        title={item.coverUrl ? "换封面" : "设为封面"}
                        aria-label={item.coverUrl ? "换封面" : "设为封面"}
                        className={`absolute right-1.5 top-1.5 grid size-6 cursor-pointer place-items-center rounded-full bg-black/45 text-white backdrop-blur transition hover:bg-black/65 ${item.coverUrl ? "" : "opacity-0 group-hover:opacity-100"}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            onSetCover();
                        }}
                    >
                        <ImagePlus className="size-3.5" />
                    </button>
                ) : null}
            </div>
            <button type="button" className={compact ? "block w-full cursor-pointer text-left" : "block w-full flex-1 cursor-pointer text-left"} onClick={onOpen}>
                <div className={compact ? "px-3 py-2.5" : "p-4"}>
                    <div className="flex items-start justify-between gap-3">
                        <h2 className="line-clamp-1 text-[13px] font-semibold tracking-[-0.01em] text-stone-950 dark:text-zinc-100">{item.title}</h2>
                        {!compact ? <span className="shrink-0 text-[9px] text-stone-400 dark:text-zinc-600">{formatPromptDate(item.updatedAt, i18n.resolvedLanguage)}</span> : null}
                    </div>
                    {!compact ? <><p className="mt-2 line-clamp-3 min-h-[54px] text-[11px] leading-[18px] text-stone-500 dark:text-zinc-500">{item.description || item.prompt}</p><div className="mt-3 flex flex-wrap gap-1.5">{item.tags.slice(0, 4).map((tag) => <span key={tag} className="rounded-full bg-black/[0.045] px-2 py-1 text-[9px] text-stone-500 dark:bg-white/[0.045] dark:text-zinc-500">{tag}</span>)}</div></> : null}
                </div>
            </button>
            {!compact ? <div className="mt-auto flex min-h-12 items-center gap-1 border-t border-black/[0.06] px-3 dark:border-white/[0.06]"><Button block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>{actionLabel || t("common.copy")}</Button>{extraAction}</div> : null}
        </article>
    );
}
