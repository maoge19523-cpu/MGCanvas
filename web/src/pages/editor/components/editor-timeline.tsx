import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { timelineTickLabel, timelineTickStep, timelineTicks, type CompositePreviewClip } from "@/lib/canvas/composite-editing";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasCompositeSettings } from "@/types/canvas";
import type { CompositePreview } from "../use-composite-preview";

type EditorTimelineProps = {
    preview: CompositePreview;
    clips: CompositePreviewClip[];
    settings: CanvasCompositeSettings;
    totalSeconds: number;
    selectedClipId: string;
    disabled: boolean;
    onSelectClip: (sourceNodeId: string) => void;
    onReorder: (sourceConnectionId: string, targetConnectionId: string) => void;
    onTrim: (sourceNodeId: string, patch: { start?: number; end?: number }) => void;
};

// 拖动换序的触发阈值（像素），沿用合成面板时代的经验值。
const REORDER_THRESHOLD = 24;

/**
 * 时间线：标尺 + 播放头 + 按真实时长铺开的片段条。
 *
 * 纪律（React #185 的教训）：拖动过程中**一个 setState 都不写**——
 * 换序只把被拖的片段条做 CSS translateX 预览，裁剪只直接写该条的 flexGrow 与时长文字，
 * 目标值全部记在 ref 里，pointerup/pointercancel/pointerleave 时一次性提交给页面。
 * 播放头同理：位置与读数由 paintPlayhead 直接改 DOM，不参与 React 渲染。
 */
export function EditorTimeline({ preview, clips, settings, totalSeconds, selectedClipId, disabled, onSelectClip, onReorder, onTrim }: EditorTimelineProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const barsRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ index: number; x: number; target: number | null } | null>(null);
    const trimRef = useRef<{ index: number; edge: "start" | "end"; x: number; perPixel: number; pending: number | null } | null>(null);
    const draggedRef = useRef(false);

    const clipText = (index: number, length: number) => `${t("editor.clipIndex", { index: index + 1 })} · ${length.toFixed(1)}${t("editor.seconds")}`;
    const barNode = (index: number, kind: "bar" | "label") => barsRef.current?.querySelector<HTMLElement>(`[data-clip-${kind}="${index}"]`) || null;

    // 拖动换序：过程只用 transform 做视觉预览，松手才提交连线顺序。
    const startDrag = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
        if (disabled) return;
        event.stopPropagation();
        draggedRef.current = false;
        dragRef.current = { index, x: event.clientX, target: null };
    };

    // 拖动裁剪：过程直接写 DOM（flexGrow + 时长文字），松手才写入 compositeSettings。
    const startTrim = (event: ReactPointerEvent<HTMLSpanElement>, index: number, edge: "start" | "end") => {
        if (disabled) return;
        event.stopPropagation();
        const bar = event.currentTarget.parentElement;
        const box = bar?.getBoundingClientRect();
        const clip = clips[index];
        if (!bar || !box || !clip || box.width <= 0) return;
        draggedRef.current = true;
        trimRef.current = { index, edge, x: event.clientX, perPixel: Math.max(0.001, clip.length / box.width), pending: null };
    };

    const previewTrim = (trim: NonNullable<typeof trimRef.current>, clip: CompositePreviewClip, clientX: number) => {
        const delta = (clientX - trim.x) * trim.perPixel;
        // 入点最大到「出点前 0.1s」，出点最小到「入点后 0.1s」，也都不越过源视频时长。
        const start = trim.edge === "start" ? Number(Math.min(Math.max(0, clip.start + delta), Math.max(0, clip.start + clip.length - 0.1)).toFixed(2)) : clip.start;
        const end = trim.edge === "end" ? Number(Math.min(Math.max(clip.start + 0.1, clip.start + clip.length + delta), clip.source).toFixed(2)) : clip.start + clip.length;
        trim.pending = trim.edge === "start" ? start : end;
        const length = Math.max(0, end - start);
        const total = Math.max(0.1, totalSeconds - clip.length + length);
        const bar = barNode(trim.index, "bar");
        if (bar) bar.style.flexGrow = String(Math.max(0.35, (length / total) * 10));
        const label = barNode(trim.index, "label");
        if (label) label.textContent = clipText(trim.index, length);
    };

    // 拖动过程中只写 DOM，不写画布、也不 setState；松手时一次性提交。
    const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const trim = trimRef.current;
        const clip = trim ? clips[trim.index] : null;
        if (trim && clip) {
            event.stopPropagation();
            previewTrim(trim, clip, event.clientX);
            return;
        }
        const drag = dragRef.current;
        if (!drag) return;
        event.stopPropagation();
        const dx = event.clientX - drag.x;
        if (Math.abs(dx) < REORDER_THRESHOLD) return;
        const target = drag.index + (dx > 0 ? 1 : -1);
        if (target < 0 || target >= clips.length) return;
        draggedRef.current = true;
        drag.target = target;
        const bar = barNode(drag.index, "bar");
        if (bar) bar.style.transform = `translateX(${dx}px)`;
    };

    const endDrag = () => {
        const drag = dragRef.current;
        const trim = trimRef.current;
        dragRef.current = null;
        trimRef.current = null;
        if (drag) {
            const bar = barNode(drag.index, "bar");
            if (bar) bar.style.transform = "";
            if (drag.target !== null && drag.target >= 0 && drag.target < clips.length && drag.target !== drag.index) onReorder(clips[drag.index]!.connectionId, clips[drag.target]!.connectionId);
        }
        if (trim && trim.pending !== null) {
            const clip = clips[trim.index];
            const item = clip ? settings.segments?.[clip.id] : undefined;
            const current = trim.edge === "start" ? item?.start ?? 0 : item?.end ?? clip?.source ?? 0;
            if (clip && trim.pending !== current) onTrim(clip.id, trim.edge === "start" ? { start: trim.pending } : { end: trim.pending });
        }
    };

    // 点击片段条：一次性事件——先把播放头定位到点击位置，再选中这一段。
    const handleClipClick = (event: ReactMouseEvent<HTMLDivElement>, index: number) => {
        if (draggedRef.current) return;
        preview.seekFromClientX(event.clientX, true);
        onSelectClip(clips[index]!.id);
    };

    const step = timelineTickStep(totalSeconds);

    return (
        <section className="shrink-0 border-t px-3 pb-3 pt-2" style={{ borderColor: theme.toolbar.border }}>
            <div className="flex min-w-0 items-center gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                <span className="shrink-0 font-medium">{t("editor.timeline")}</span>
                {clips.length ? (
                    <span className="min-w-0 flex-1 truncate" style={{ color: theme.node.faint }}>
                        {t("editor.timelineHint")}
                    </span>
                ) : (
                    // 空时间线：明确告诉用户还没有片段，以及该去哪里加。
                    <span className="min-w-0 flex-1 truncate" style={{ color: theme.node.muted }}>
                        {t("editor.noClips")}　{t("editor.noClipsHint")}
                    </span>
                )}
                {clips.length ? (
                    <span className="shrink-0 tabular-nums" style={{ color: theme.node.muted }}>
                        {t("editor.totalDuration")} {totalSeconds.toFixed(1)}
                        {t("editor.seconds")}
                    </span>
                ) : null}
            </div>

            <div className="relative mt-1.5" ref={preview.timelineRef}>
                <div
                    className="relative h-6 cursor-pointer touch-none select-none"
                    title={t("editor.timelineHint")}
                    onPointerDown={preview.startSeek}
                    onPointerMove={preview.moveSeek}
                    onPointerUp={preview.endSeek}
                    onPointerCancel={preview.endSeek}
                    onPointerLeave={preview.endSeek}
                >
                    {timelineTicks(totalSeconds, step).map((tick) => (
                        <span key={tick} className="absolute top-0 flex flex-col items-center" style={{ left: `${(tick / totalSeconds) * 100}%`, transform: tick === 0 ? "none" : "translateX(-50%)" }}>
                            <span className="h-1.5 w-px" style={{ background: theme.node.faint }} />
                            <span className="text-[9px] leading-none tabular-nums" style={{ color: theme.node.faint }}>
                                {timelineTickLabel(tick, step)}
                            </span>
                        </span>
                    ))}
                </div>

                <div className="flex items-stretch gap-1" ref={barsRef} onPointerMove={handleMove} onPointerUp={endDrag} onPointerCancel={endDrag} onPointerLeave={endDrag}>
                    {clips.map((clip, index) => {
                        const transition = settings.segments?.[clip.id]?.transition;
                        const selected = clip.id === selectedClipId;
                        return (
                            <div key={clip.connectionId} className="flex min-w-0 items-center gap-1" style={{ flex: `${Math.max(0.35, (totalSeconds > 0 ? clip.length / totalSeconds : 1 / Math.max(1, clips.length)) * 10)} 1 0%` }}>
                                <div
                                    data-clip-bar={index}
                                    className="relative h-9 min-w-0 flex-1 cursor-grab select-none rounded-md border transition-colors hover:bg-black/5 active:cursor-grabbing dark:hover:bg-white/10"
                                    style={{ borderColor: selected ? theme.canvas.selectionStroke : theme.toolbar.border, borderStyle: transition ? "dashed" : "solid", background: selected ? theme.canvas.selectionFill : undefined }}
                                    title={`${clipText(index, clip.length)}${transition ? ` · ${t("editor.transitionMark")}` : ""}`}
                                    onPointerDown={(event) => startDrag(event, index)}
                                    onClick={(event) => handleClipClick(event, index)}
                                >
                                    <span data-clip-label={index} className="pointer-events-none absolute inset-0 flex items-center justify-center truncate px-2 text-[10px]" style={{ color: theme.node.muted }}>
                                        {clipText(index, clip.length)}
                                    </span>
                                    <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-md hover:bg-black/10 dark:hover:bg-white/15" title={t("editor.trimStart")} onPointerDown={(event) => startTrim(event, index, "start")} />
                                    <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-md hover:bg-black/10 dark:hover:bg-white/15" title={t("editor.trimEnd")} onPointerDown={(event) => startTrim(event, index, "end")} />
                                </div>
                                {index < clips.length - 1 ? (
                                    <span className="shrink-0 text-[10px]" style={{ color: transition ? theme.node.text : theme.node.faint }} title={transition ? t("editor.transitionMark") : t("editor.hardCut")}>
                                        {transition ? "◆" : "│"}
                                    </span>
                                ) : null}
                            </div>
                        );
                    })}
                </div>

                {/* 播放头：位置只由 paintPlayhead 直接写 style.left，不参与 React 渲染。 */}
                <div ref={preview.playheadRef} data-editor-playhead className="pointer-events-none absolute inset-y-0 w-px" style={{ left: "0%", background: theme.canvas.selectionStroke }} />
            </div>
        </section>
    );
}
