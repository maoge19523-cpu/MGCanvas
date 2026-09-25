import { Captions } from "lucide-react";
import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { theme } from "antd";
import { useTranslation } from "react-i18next";

import { formatEditTime } from "@/lib/edit/timeline";
import type { EditSnapPoint, EditSnapResult } from "@/lib/edit/timeline-edit";
import {
    EDIT_SUBTITLE_MIN_PX,
    countEditSubtitlesBeyondEnd,
    editSubtitleBlocks,
    editSubtitleOverlapBands,
    editSubtitlePlacement,
    moveEditSubtitle,
    trimEditSubtitle,
    type EditSubtitleBlock,
} from "@/lib/edit/subtitle-blocks";
import { useEditState } from "@/stores/use-edit-store";
import type { EditSubtitle } from "@/types/edit";

// 写成 `?? []` 会每次渲染都产生新数组，zustand 的 Object.is 比较会因此判定「状态变了」（React #185 的成因之一）。
const EMPTY_SUBTITLES: EditSubtitle[] = [];

/**
 * 字幕块拖动的共用上下文：**由时间线容器（edit-stage）提供**，因为吸附候选点、吸附阈值、
 * 吸附导引线在整条时间线上只有那一份（与片段拖动、音轨拖动共用同一套），
 * 字幕行不另造第二套吸附。
 */
export type EditSubtitleDrag = {
    /** 按下时播种指针速度：「快拖不吸附」判据用的就是它，拖动过程中不再写任何状态。 */
    begin: (event: ReactPointerEvent<HTMLElement>) => void;
    /** 拖块身：整段平移，时长不变。落点已按共用候选点吸附。 */
    placeBody: (event: ReactPointerEvent<HTMLElement>, rawStart: number, durationSeconds: number) => EditSnapResult;
    /** 拖两端：只吸附被拖的那一条边，并夹进合法区间。 */
    placeEdge: (event: ReactPointerEvent<HTMLElement>, rawSeconds: number, edge: "start" | "end", start: number, end: number) => EditSnapResult;
    /** 显示 / 收起吸附导引线（与片段拖动、音轨拖动共用同一条线）。 */
    guide: (point: EditSnapPoint | null) => void;
    /** 松手时才调用：一次性提交这条字幕的新起止。 */
    commit: (id: string, patch: { start: number; end: number }) => void;
};

type DragState = {
    id: string;
    mode: "body" | "start" | "end";
    x: number;
    start: number;
    end: number;
    perPixel: number;
    pendingStart: number;
    pendingEnd: number;
    element: HTMLElement;
};

/**
 * 时间线上的**字幕轨道行**：把导入的字幕逐条画成一个可见、可拖的字幕块。
 *
 * 块是**按时间定位的内容**（与片段条、波形条同类），不是接缝标记那种覆盖层：
 * `left` 与 `width` 都由 lib/timeline-scale 的同一套换算得出（见 lib/edit/subtitle-blocks 的
 * editSubtitlePlacement），所以块的位置与标尺刻度、播放头、片段条、波形条严格同源。
 * 这一行只是共享容器里多出来的一个兄弟行：它不写任何容器的宽度、不套自己的滚动条、
 * 不给自己加会改变定位原点的横向内边距，因此别的元素一个百分比都没动。
 *
 * 拖动纪律与音轨拖动完全一致：过程只写 ref 与 DOM（style.left / style.width），
 * 一次都不写 store / setState，松手（pointerup / pointercancel）才提交一次（React #185 的对策）。
 */
export function EditSubtitleTrack({ projectId, totalSeconds, selectedId, drag, onSelect }: { projectId: string; totalSeconds: number; selectedId: string | null; drag: EditSubtitleDrag; onSelect: (subtitleId: string | null) => void }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const { projects } = useEditState();
    const subtitles = projects.find((item) => item.id === projectId)?.subtitles ?? EMPTY_SUBTITLES;
    const blocks = useMemo(() => editSubtitleBlocks(subtitles, totalSeconds), [subtitles, totalSeconds]);
    const bands = useMemo(() => editSubtitleOverlapBands(subtitles), [subtitles]);
    const rowRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<DragState | null>(null);

    /**
     * 块的定位**只有这一个地方写**（拖动过程中与松手之后都走它），所以 DOM 永远等于
     * 「已经提交 / 正要提交的那个起止」，不会出现视图与数据不一致。
     * 换算仍走 editSubtitlePlacement 这一条（与标尺、播放头、片段条、波形条同一套）。
     */
    const paintBlock = (element: HTMLElement, start: number, end: number) => {
        const { left, width } = editSubtitlePlacement(start, end, totalSeconds);
        element.style.left = `${left}%`;
        element.style.width = `${width}%`;
    };

    const startDrag = (event: ReactPointerEvent<HTMLElement>, block: EditSubtitleBlock, mode: DragState["mode"]) => {
        // 两端把手是压在块里的子元素：无论抓的是块身还是把手，都先选中这条字幕，
        // 再用 mode 区分「整段平移」与「裁剪某一条边」。过程量一律只进 dragRef。
        event.stopPropagation();
        onSelect(block.id);
        drag.begin(event);
        const element = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-edit-subtitle-block]");
        if (!element) return;
        const width = rowRef.current?.getBoundingClientRect().width ?? 0;
        dragRef.current = {
            id: block.id,
            mode,
            x: event.clientX,
            start: block.start,
            end: block.end,
            // 秒 / 像素用「成片总秒数 ÷ 行宽」：行宽就是标尺、片段条、波形条共用的那个可定位宽度。
            perPixel: width > 0 && totalSeconds > 0 ? totalSeconds / width : 0.05,
            pendingStart: block.start,
            pendingEnd: block.end,
            element,
        };
        // 抓住指针：横向拖出这一行（甚至拖出窗口）都不会中途丢事件，松手一定提交。
        element.setPointerCapture(event.pointerId);
    };

    const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
        const state = dragRef.current;
        if (!state) return;
        event.stopPropagation();
        const delta = (event.clientX - state.x) * state.perPixel;
        // 拖动中允许拖到成片之外：上一轮明确允许字幕落在成片之外，这里不偷偷把它拉回来。
        const placed = state.mode === "body" ? drag.placeBody(event, state.start + delta, state.end - state.start) : drag.placeEdge(event, (state.mode === "start" ? state.start : state.end) + delta, state.mode, state.start, state.end);
        const next = state.mode === "body" ? moveEditSubtitle(state.start, state.end, placed.seconds) : trimEditSubtitle(state.start, state.end, state.mode, placed.seconds);
        state.pendingStart = next.start;
        state.pendingEnd = next.end;
        paintBlock(state.element, next.start, next.end);
        drag.guide(placed.point ?? null);
    };

    const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
        const state = dragRef.current;
        dragRef.current = null;
        drag.guide(null);
        if (!state) return;
        event.stopPropagation();
        // 先把 DOM 钉在要提交的那个值上（拖动期间写的是百分比，React 的 style 差分未必覆盖），再提交一次。
        paintBlock(state.element, state.pendingStart, state.pendingEnd);
        if (state.pendingStart !== state.start || state.pendingEnd !== state.end) drag.commit(state.id, { start: state.pendingStart, end: state.pendingEnd });
    };

    /** 键盘可达：块本身就是 button 语义，Enter / 空格与点它一下等价（删除统一走时间线的 Delete 快捷键）。 */
    const onBlockKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, block: EditSubtitleBlock) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(block.id);
    };

    // 没有字幕就**不渲染这一行**：时间线的可用高度是给内容用的，没必要为一个多数项目不用的功能
    // 长期占一行；「还没有导入字幕」的引导本来就在素材区（导入入口）与属性区（空状态）里。
    // 反过来这也让「没导入过字幕的项目」产物与改动前逐字相同——回归断言因此最硬。
    if (!blocks.length) return null;

    const beyond = countEditSubtitlesBeyondEnd(blocks);

    return (
        // className 的第一个属性值就是行容器自己：没有内边距 / 外边距 / 边框，纵向滚动也不在这里
        // （滚动只在外层包住全部时间定位元素的那个容器上），所以它的宽度就是共享的可定位宽度。
        <div
            ref={rowRef}
            data-edit-subtitle-track="true"
            className="relative mt-1.5 h-7 touch-none select-none rounded-[8px] bg-black/[0.03] dark:bg-white/[0.05]"
            title={t("editor.subtitleTrackHint")}
            aria-label={t("editor.subtitleTrack")}
        >
            {/* 轨道标签：与别的轨道头一样不占任何宽度；z-0 压在块**之下**，
                于是从 0 秒起的字幕照旧完整可见，标签只在一块都没有的地方当背景说明。 */}
            <span data-edit-subtitle-track-head className="pointer-events-none absolute left-1 top-1/2 z-0 flex -translate-y-1/2 items-center gap-1 text-[10px] text-stone-400 dark:text-zinc-600">
                <Captions className="size-3" />
                {t("editor.subtitleTrack")}
            </span>

            {/* 重叠区间的斜纹带：**覆盖层**（绝对定位、不参与宽度分配、pointer-events-none），
                压在真正叠了两条以上的那一段上，右上角标出同时有几条。
                字幕块本身仍是内容，照样能点、能拖——带子不吃任何指针事件。 */}
            {bands.map((band, index) => {
                const placement = editSubtitlePlacement(band.start, band.end, totalSeconds);
                return (
                    <span
                        key={`${band.start}-${band.end}-${index}`}
                        data-edit-subtitle-overlap-band={`${band.count}`}
                        className="pointer-events-none absolute inset-y-0 z-[3] rounded-[6px] border border-dashed"
                        style={{
                            left: `${placement.left}%`,
                            width: `${placement.width}%`,
                            borderColor: token.colorWarning,
                            background: `repeating-linear-gradient(45deg, transparent 0 3px, ${token.colorWarningBg} 3px 6px)`,
                        }}
                    >
                        <span
                            data-edit-subtitle-overlap-badge={`${band.count}`}
                            className="absolute left-0 top-0 rounded-[5px] px-1 text-[9px] leading-4 tabular-nums"
                            style={{ background: token.colorBgElevated, color: token.colorWarning }}
                        >
                            {t("editor.subtitleOverlapBadge", { count: band.count })}
                        </span>
                    </span>
                );
            })}

            {blocks.map((block) => {
                const selected = block.id === selectedId;
                const range = `${formatEditTime(block.start)} → ${formatEditTime(block.end)}`;
                const hint = [t("editor.subtitleBlockHint", { range, text: block.label }), block.overlapping ? t("editor.subtitleOverlapNote") : null, block.beyondEnd ? t("editor.subtitleBeyondNote") : block.clipped ? t("editor.subtitleClippedNote") : null]
                    .filter(Boolean)
                    .join(" · ");
                return (
                    <div
                        key={block.id}
                        data-edit-subtitle-block={block.id}
                        // 原始起止逐字给出来：块的百分比位置与这两个数一一对应，读回产物时可以直接核对。
                        data-edit-subtitle-block-start={block.start}
                        data-edit-subtitle-block-end={block.end}
                        data-edit-subtitle-block-out={block.beyondEnd ? "beyond" : block.clipped ? "clipped" : undefined}
                        data-edit-subtitle-block-overlap={block.overlapping ? "true" : undefined}
                        data-edit-subtitle-block-selected={selected ? "true" : undefined}
                        role="button"
                        tabIndex={0}
                        aria-pressed={selected}
                        aria-label={hint}
                        title={hint}
                        className="absolute inset-y-[3px] z-[1] flex items-center overflow-hidden rounded-[6px] border"
                        // left / width **都**来自 editSubtitlePlacement（不是覆盖层，不省 width）：
                        // 位置与标尺刻度、播放头、片段条、波形条同一套换算，右边缘就是 end 的换算值。
                        // min-width 只是极短字幕的可点下限（与片段条的 EDIT_CLIP_MIN_PX 同一先例）：
                        // 绝对定位下它不推动任何邻居，也不改变别的元素的百分比。
                        style={{
                            left: `${block.left}%`,
                            width: `${block.width}%`,
                            minWidth: EDIT_SUBTITLE_MIN_PX,
                            background: token.colorPrimaryBg,
                            color: token.colorText,
                            borderColor: selected ? token.colorPrimary : block.overlapping ? token.colorWarning : token.colorBorderSecondary,
                            borderStyle: block.overlapping ? "dashed" : "solid",
                        }}
                        onPointerDown={(event) => startDrag(event, block, "body")}
                        onPointerMove={moveDrag}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                        onKeyDown={(event) => onBlockKeyDown(event, block)}
                    >
                        <span className="pointer-events-none block truncate px-1.5 text-[10px] leading-none">{block.label}</span>
                        {/* 两端的裁剪把手：与片段条的把手同一写法（很窄的一条，悬停才显底色）。 */}
                        <span
                            data-edit-subtitle-handle="start"
                            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-[6px] hover:bg-black/10 dark:hover:bg-white/15"
                            title={t("editor.trimStart")}
                            onPointerDown={(event) => startDrag(event, block, "start")}
                        />
                        <span
                            data-edit-subtitle-handle="end"
                            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-[6px] hover:bg-black/10 dark:hover:bg-white/15"
                            title={t("editor.trimEnd")}
                            onPointerDown={(event) => startDrag(event, block, "end")}
                        />
                    </div>
                );
            })}

            {/* 落在成片末尾之后的字幕：它们的块被钉在 100%（宽度 0 + 可点下限，最右端仍是一个能抓的小块，
                往左拖就回到成片之内），这里再给一条条数汇总，免得一次只看得见一个。
                与其它覆盖层同一条纪律：绝对定位、right-0，不写 left / width，不吃轨道像素。
                这里的「成片末尾」= totalSeconds，与标尺刻度 / 播放头 / 波形条用的是同一个数
                （editPlaybackSeconds）；属性区那条提示用的是 editOutputSeconds（扣掉转场重叠后的真实成片长度），
                有转场时两者差一个转场时长——时间线必须与标尺同口径，否则块与刻度就错开了。 */}
            {beyond ? (
                <span
                    data-edit-subtitle-track-beyond={beyond}
                    className="pointer-events-none absolute right-0 top-0 z-[4] rounded-[5px] px-1 text-[9px] leading-4 tabular-nums"
                    style={{ background: token.colorBgElevated, color: token.colorWarning }}
                    title={t("editor.subtitleTrackBeyondHint")}
                >
                    {t("editor.subtitleTrackBeyond", { count: beyond })}
                </span>
            ) : null}
        </div>
    );
}
