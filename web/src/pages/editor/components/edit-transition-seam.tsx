import { Button, InputNumber, Popover, Select, theme } from "antd";
import { ArrowLeft, ArrowUp, Blend, CircleDashed, Layers, Lock, PanelLeft, PanelRight, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { EditSeam } from "@/lib/edit/timeline-seams";
import { EDIT_TRANSITIONS } from "@/types/edit";

/**
 * 接缝标记（chip）：**绝对定位压在相邻两段的分界线上、不占任何布局宽度**。
 * 片段条、波形条、标尺刻度、播放头的定位因此一个像素都没变（见 edit-stage 顶部的时间轴对齐纪律）。
 *
 * 两种状态：
 * - 有转场：一个胶囊，图标区分种类（7 种各一个图标）＋ 短名字；
 * - 硬切（没有转场）：一个很小的虚线槽——**是接缝本身的可见痕迹，不是空白**，
 *   悬停 / 聚焦才展开成圆形「＋」。这是刻意补上的可点入口：只有「加了转场才看得见」的话，
 *   用户永远找不到「怎么加转场」（参考产品自己承认过这个 v1 缺陷）。
 *
 * chip 尺寸刻意压到最小（默认 12×16、有转场时高 18px），且居中压在分界线上——
 * 分界线上下各留 15px 仍可抓片段两端的裁剪把手，不把整条边界变成按钮。
 * z-index 取 3：压在片段条（auto）之上，但在裁剪中被抬到 5 的那条片段、播放头 / 导引线（10）之下——
 * 拖动过程中 chip 本来就不跟着动（松手才提交），让被拖的片段与播放头保持在上层。
 * 片段极短（chip 比片段还宽）时不做任何收缩或退让：chip 照旧居中压在分界线上、与邻居重叠，
 * 位置仍然等于分界线（宁可重叠也不让「转场标记指错位置」）。
 */

/** 每种转场一个图标：单看接缝标记就能分辨种类，名字在提示与面板里给出。 */
const SEAM_ICONS: Record<string, typeof Blend> = {
    fade: Blend,
    dissolve: Layers,
    wipeleft: PanelLeft,
    wiperight: PanelRight,
    slideleft: ArrowLeft,
    slideup: ArrowUp,
    circleopen: CircleDashed,
};

type EditTransitionSeamProps = {
    seam: EditSeam;
    /** 提交转场改动：落点永远是**左段**（EditClip.transition 的语义是「本段 → 下一段」）。 */
    onChange: (patch: { transition?: string; transitionDuration?: number }) => void;
};

/** 接缝面板：选类型（7 种 + 硬切）、改时长、删除转场。渲染在 antd Popover 的弹层里（portal），
 *  因此它自己的高度 / 宽度完全不参与时间轴排版——这是它不占轨道宽度的第二重保证。 */
export function EditTransitionSeamPanel({ seam, onChange }: EditTransitionSeamProps) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const transition = seam.transition;
    const range = { from: seam.index + 1, to: seam.index + 2 };
    const locked = seam.locked;

    return (
        <div className="flex w-[212px] flex-col gap-2">
            <span className="text-[10px] leading-4 text-stone-400 dark:text-zinc-600">{t("editor.seamPanelHint", range)}</span>
            {locked ? (
                <span className="flex items-center gap-1 text-[10px] leading-4" style={{ color: token.colorWarning }}>
                    <Lock className="size-3" />
                    {t("editor.trackLockedNotice")}
                </span>
            ) : null}
            <Select
                disabled={locked}
                size="small"
                className="w-full"
                value={transition ?? "none"}
                options={[{ value: "none", label: t("editor.transitionNone") }, ...EDIT_TRANSITIONS.map((value) => ({ value, label: t(`editor.transitions.${value}`) }))]}
                onChange={(value) => onChange({ transition: value === "none" ? undefined : value })}
            />
            <div className="flex items-center justify-between gap-2 text-[11px] text-stone-500 dark:text-zinc-500">
                <span className="shrink-0">{t("editor.transitionDuration")}</span>
                <InputNumber
                    disabled={locked || !transition}
                    size="small"
                    min={0.2}
                    max={1.5}
                    step={0.1}
                    controls={false}
                    value={seam.transitionDuration}
                    style={{ width: 108 }}
                    onChange={(value) => {
                        const parsed = Number(value);
                        if (value === null || !Number.isFinite(parsed)) return;
                        onChange({ transitionDuration: Math.min(1.5, Math.max(0.2, parsed)) });
                    }}
                />
            </div>
            <Button size="small" type="text" danger className="self-start !px-1.5" disabled={locked || !transition} icon={<Trash2 className="size-3.5" />} onClick={() => onChange({ transition: undefined })}>
                {t("editor.transitionRemove")}
            </Button>
        </div>
    );
}

export function EditTransitionSeam({ seam, onChange }: EditTransitionSeamProps) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const transition = seam.transition;
    const Icon = transition ? SEAM_ICONS[transition] ?? Blend : Plus;
    const name = transition ? t(`editor.transitions.${transition}`) : t("editor.transitionNone");
    const range = { from: seam.index + 1, to: seam.index + 2 };

    return (
        <Popover trigger="click" placement="top" title={t("editor.seamTitle", range)} content={<EditTransitionSeamPanel seam={seam} onChange={onChange} />}>
            <button
                data-edit-transition-seam={seam.leftClipId}
                // 有转场才写这个属性：测试与排查都能一眼看出「这条接缝是硬切」。
                data-edit-seam-transition={transition}
                type="button"
                aria-label={transition ? t("editor.seamEditHint", { ...range, transition: name }) : t("editor.seamAddHint", range)}
                title={transition ? t("editor.seamEditHint", { ...range, transition: name }) : t("editor.seamAddHint", range)}
                className={
                    transition
                        ? "absolute top-1/2 z-[3] flex h-[18px] max-w-[86px] -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                        : "group absolute top-1/2 z-[3] flex h-4 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-dashed transition-all hover:h-[18px] hover:w-[18px] focus-visible:h-[18px] focus-visible:w-[18px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                }
                // 只写 left：位置与片段条的右边缘是同一个数（见 editTimelineSeams），宽度由内容决定，不占轨道像素。
                style={{ left: `${seam.percent}%`, background: token.colorBgElevated, borderColor: token.colorBorderSecondary, color: transition ? token.colorPrimary : token.colorTextQuaternary, outlineColor: token.colorPrimary }}
            >
                <Icon className={transition ? "size-3 shrink-0" : "size-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"} />
                {transition ? <span className="truncate">{name}</span> : null}
            </button>
        </Popover>
    );
}
