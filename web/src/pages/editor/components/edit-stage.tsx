import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Tooltip } from "antd";
import { Clapperboard, Info, Music2, Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { buildEditClips, editPlaybackSeconds, editTickLabel, editTickStep, formatEditTime, resolveEditPlayback, resolveEditSeek, type EditClipView } from "@/lib/edit/timeline";
import { createEditClip, useEditState } from "@/stores/use-edit-store";
import type { EditClip, EditMedia } from "@/types/edit";
import { useEditMediaUrls } from "../use-edit-media-urls";

type EditStageProps = {
    projectId: string;
    clipId: string | null;
    hasMedia: boolean;
    onSelectClip: (clipId: string) => void;
};

// 项目还没水合完成时用固定引用兜底：写成 `?? []` 会每次渲染都产生新数组，
// zustand 的 Object.is 比较会因此判定「状态变了」而反复重渲染（React #185 的成因之一）。
const EMPTY_MEDIA: EditMedia[] = [];
const EMPTY_CLIPS: EditClip[] = [];

/**
 * 预览区 + 时间线。两块共用一套播放与播放头状态，所以放在同一个组件里：
 * 预览与时间轴的坐标必须完全一致，拆开就要跨组件同步播放头，反而更容易写入抖动。
 *
 * 高频交互（拖动片段换序、拖两端裁剪、拖播放头、播放）**一次都不写 store / setState**：
 * 过程量只存在 ref 里，视觉反馈直接改 DOM（flexGrow / transform / textContent / style.left），
 * 松手时（pointerup / pointercancel / pointerleave）才一次性提交到剪辑台 store。
 */
export function EditStage({ projectId, clipId, hasMedia, onSelectClip }: EditStageProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { projects, updateClips, updateClip, addClips } = useEditState();
    const project = projects.find((item) => item.id === projectId);
    const media = project?.media ?? EMPTY_MEDIA;
    const clips = project?.clips ?? EMPTY_CLIPS;
    const urls = useEditMediaUrls(media);
    const views = useMemo(() => buildEditClips(media, clips, urls), [media, clips, urls]);
    const totalSeconds = editPlaybackSeconds(views);

    // ── 播放头与预览：全部状态放 ref，播放/暂停这一个低频开关才用 state ──────────────
    const [playing, setPlaying] = useState(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playheadRef = useRef<HTMLDivElement | null>(null);
    const readoutRef = useRef<HTMLSpanElement | null>(null);
    const activeLabelRef = useRef<HTMLSpanElement | null>(null);
    const timelineRef = useRef<HTMLDivElement | null>(null);
    const secondsRef = useRef(0);
    const totalRef = useRef(0);
    const playingRef = useRef(false);
    const indexRef = useRef(0);
    const viewsRef = useRef<EditClipView[]>([]);
    const frameRef = useRef(0);
    const awaitingRef = useRef(false);
    const handlersRef = useRef<{ loaded: () => void; failed: () => void } | null>(null);
    const seekingRef = useRef(false);

    // 播放头与读数一律直接改 DOM：这两个节点的 style/textContent 不参与 React 渲染，
    // 因此其它原因引起的重渲染也不会把播放中的位置冲掉。
    const paintPlayhead = (seconds: number, total = totalRef.current) => {
        if (playheadRef.current) playheadRef.current.style.left = `${total > 0 ? Math.min(100, Math.max(0, (seconds / total) * 100)) : 0}%`;
        if (readoutRef.current) readoutRef.current.textContent = formatEditTime(seconds);
        const index = viewsRef.current.findIndex((view) => seconds < view.offset + view.length);
        const active = playingRef.current && index >= 0 ? viewsRef.current[index] : null;
        if (activeLabelRef.current) activeLabelRef.current.textContent = active ? t("editor.nowPlaying", { index: index + 1, name: active.name }) : "";
    };

    const detachHandlers = (video: HTMLVideoElement) => {
        const handlers = handlersRef.current;
        if (!handlers) return;
        video.removeEventListener("loadedmetadata", handlers.loaded);
        video.removeEventListener("error", handlers.failed);
        handlersRef.current = null;
    };

    // 清干净一个 <video>：pause + 移除 src + load()，否则元素被卸载后仍会在后台继续出声。
    const releaseVideo = (video: HTMLVideoElement) => {
        detachHandlers(video);
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.volume = 1;
    };

    const stopPreview = () => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
        playingRef.current = false;
        awaitingRef.current = false;
        if (videoRef.current) releaseVideo(videoRef.current);
        setPlaying(false);
    };

    // 用稳定的 callback ref 接管 <video>：元素被移除（切项目、关闭页面）时 React 会先回调 null 再摘 DOM，
    // 正好在这里停播；普通 useEffect 清理拿到的 ref 那时已经是 null，拦不住后台播放。
    const attachVideo = useCallback((element: HTMLVideoElement | null) => {
        const previous = videoRef.current;
        if (previous && previous !== element) releaseVideo(previous);
        videoRef.current = element;
    }, []);

    // 逐段播放：切 src → 等元数据 → 定位到入点 → play()，段尾由 rAF 循环判定后切下一段。
    const startClip = (index: number, seekTo?: number) => {
        const video = videoRef.current;
        const view = viewsRef.current[index];
        if (!video || !view) {
            stopPreview();
            return;
        }
        detachHandlers(video);
        indexRef.current = index;
        awaitingRef.current = true;
        const landing = seekTo ?? view.start;
        paintPlayhead(view.offset + Math.max(0, landing - view.start));
        const loaded = () => {
            detachHandlers(video);
            awaitingRef.current = false;
            if (landing > 0) video.currentTime = landing;
            void video.play().catch(() => {
                message.warning(t("editor.previewBlocked"));
                stopPreview();
            });
        };
        const failed = () => {
            detachHandlers(video);
            message.warning(t("editor.previewFailed", { name: view.name }));
            stopPreview();
        };
        handlersRef.current = { loaded, failed };
        video.addEventListener("loadedmetadata", loaded);
        video.addEventListener("error", failed);
        video.src = view.src;
        video.load();
    };

    // 播放心跳：读 <video>.currentTime → 算播放头秒数与音量 → 段尾切下一段，末段播完停表。
    // rAF 负责播放头平滑跟随，timeupdate 兜住「窗口不可见时浏览器停掉 rAF」的情况。
    const stepPreview = () => {
        if (!playingRef.current) return false;
        const video = videoRef.current;
        if (!video) {
            stopPreview();
            return false;
        }
        if (awaitingRef.current) return true;
        const list = viewsRef.current;
        const state = resolveEditPlayback(list, indexRef.current, video.currentTime);
        if (!state) {
            stopPreview();
            return false;
        }
        video.volume = state.volume;
        secondsRef.current = state.seconds;
        paintPlayhead(state.seconds);
        if (state.finished) {
            const next = list.findIndex((view, index) => index > state.index && view.length > 0);
            if (next < 0) {
                stopPreview();
                paintPlayhead(totalRef.current, totalRef.current);
                return false;
            }
            startClip(next);
        }
        return true;
    };

    const tick = () => {
        frameRef.current = 0;
        if (!stepPreview()) return;
        frameRef.current = requestAnimationFrame(tick);
    };

    const seekPreview = (seconds: number) => {
        if (!playingRef.current) return;
        const target = resolveEditSeek(viewsRef.current, seconds);
        if (!target) return;
        if (target.index === indexRef.current && !awaitingRef.current) {
            if (videoRef.current) videoRef.current.currentTime = target.currentTime;
            return;
        }
        startClip(target.index, target.currentTime);
    };

    const togglePreview = () => {
        if (playingRef.current) {
            stopPreview();
            return;
        }
        const list = views;
        const total = list.reduce((sum, view) => sum + view.length, 0);
        const first = list.findIndex((view) => view.length > 0 && view.src);
        if (first < 0 || total <= 0) {
            message.warning(t("editor.previewEmpty"));
            return;
        }
        viewsRef.current = list;
        totalRef.current = total;
        const from = secondsRef.current >= total - 0.05 ? 0 : Math.max(0, secondsRef.current);
        const resolved = resolveEditSeek(list, from);
        const target = resolved && list[resolved.index]!.length > 0 ? resolved : { index: first, currentTime: list[first]!.start };
        playingRef.current = true;
        setPlaying(true);
        startClip(target.index, target.currentTime);
        if (!frameRef.current) frameRef.current = requestAnimationFrame(tick);
    };

    // 总时长变化（改入出点、增删片段）后重新对齐读数——同样只写 DOM，不触发重渲染。
    useEffect(() => {
        totalRef.current = totalSeconds;
        const clamped = Math.min(secondsRef.current, totalSeconds);
        secondsRef.current = clamped;
        paintPlayhead(clamped, totalSeconds);
    }, [totalSeconds]);

    useEffect(() => () => stopPreview(), []);
    useEffect(() => {
        stopPreview();
        secondsRef.current = 0;
    }, [projectId]);

    // ── 时间线上的直接操作：拖片段本体换序，拖两端裁剪入点/出点 ─────────────────────
    // 拖动过程只写 DOM（flexGrow / transform / textContent），一条 store 写入都不发生；
    // 松手时按 ref 里记下的目标值提交一次。这是 React #185 的直接对策。
    const dragRef = useRef<{ index: number; x: number; shift: number; element: HTMLElement } | null>(null);
    const trimRef = useRef<{ index: number; edge: "start" | "end"; x: number; perPixel: number; pending: number | null; element: HTMLElement; label: HTMLElement | null } | null>(null);
    const draggedRef = useRef(false);

    const clipLabel = (view: EditClipView, index: number, seconds: number) => `${t("editor.clipNumber", { index: index + 1 })} · ${seconds.toFixed(1)}s · ${view.name}`;

    const startReorder = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
        event.stopPropagation();
        draggedRef.current = false;
        dragRef.current = { index, x: event.clientX, shift: 0, element: event.currentTarget };
    };

    const startTrim = (event: ReactPointerEvent<HTMLSpanElement>, index: number, edge: "start" | "end") => {
        event.stopPropagation();
        const view = views[index];
        const bar = event.currentTarget.parentElement;
        if (!view || !bar) return;
        draggedRef.current = true;
        trimRef.current = {
            index,
            edge,
            x: event.clientX,
            perPixel: bar.getBoundingClientRect().width > 0 ? Math.max(0.1, view.length) / bar.getBoundingClientRect().width : 0.05,
            pending: null,
            element: bar,
            label: bar.querySelector("[data-clip-label]"),
        };
    };

    const handleTimelineMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const trim = trimRef.current;
        if (trim) {
            event.stopPropagation();
            const view = views[trim.index];
            if (!view) return;
            const delta = (event.clientX - trim.x) * trim.perPixel;
            if (trim.edge === "start") {
                const until = (view.end || view.sourceSeconds) - 0.1;
                trim.pending = Number(Math.min(Math.max(0, view.start + delta), Math.max(0, until)).toFixed(2));
            } else {
                const next = Math.max(view.start + 0.1, (view.end || view.sourceSeconds) + delta);
                trim.pending = Number((view.sourceSeconds ? Math.min(next, view.sourceSeconds) : next).toFixed(2));
            }
            // 只改这一条片段自己的宽度与标签：flex 布局会让后面的片段自动跟着挪，无需 React 参与。
            const length = trim.edge === "start" ? (view.end || view.sourceSeconds) - trim.pending : trim.pending - view.start;
            trim.element.style.flexGrow = String(Math.max(0.2, length));
            if (trim.label) trim.label.textContent = clipLabel(view, trim.index, Math.max(0, length));
            return;
        }
        const drag = dragRef.current;
        if (!drag) return;
        event.stopPropagation();
        const delta = event.clientX - drag.x;
        if (Math.abs(delta) > 4) draggedRef.current = true;
        drag.shift = Math.min(Math.max(Math.round(delta / 40), -drag.index), views.length - 1 - drag.index);
        drag.element.style.transform = `translateX(${delta}px)`;
    };

    const commitReorder = (from: number, to: number) => {
        if (to === from || to < 0 || to >= clips.length) return;
        const next = clips.slice();
        const [moved] = next.splice(from, 1);
        if (!moved) return;
        next.splice(to, 0, moved);
        updateClips(projectId, next);
    };

    const endTimelineDrag = () => {
        const drag = dragRef.current;
        const trim = trimRef.current;
        dragRef.current = null;
        trimRef.current = null;
        if (drag) {
            drag.element.style.transform = "";
            commitReorder(drag.index, drag.index + drag.shift);
        }
        if (trim && trim.pending !== null) {
            const view = views[trim.index];
            const current = trim.edge === "start" ? view?.start : view?.end;
            if (view && trim.pending !== current) updateClip(projectId, view.id, trim.edge === "start" ? { start: trim.pending } : { end: trim.pending });
        }
    };

    const movePlayheadFromClientX = (clientX: number, commit: boolean) => {
        const box = timelineRef.current?.getBoundingClientRect();
        if (!box || box.width <= 0 || totalSeconds <= 0) return;
        const seconds = Math.min(totalSeconds, Math.max(0, ((clientX - box.left) / box.width) * totalSeconds));
        secondsRef.current = seconds;
        paintPlayhead(seconds, totalSeconds);
        if (commit) seekPreview(seconds);
    };

    const tickStep = editTickStep(totalSeconds);
    const ticks: number[] = [];
    for (let tickValue = 0; totalSeconds > 0 && tickValue < totalSeconds; tickValue += tickStep) ticks.push(Number(tickValue.toFixed(3)));
    const empty = views.length === 0;

    // 时间线空状态的一键引导：把已探测到时长的视频素材按素材顺序一次排上时间线（一次写入）。
    const addAllToTimeline = () => {
        const usable = media.filter((item) => item.kind === "video" && item.durationMs);
        if (!usable.length) {
            message.warning(t("editor.emptyClipsActionNone"));
            return;
        }
        addClips(projectId, usable.map((item) => createEditClip(item.id)));
        message.success(t("editor.addedToTimeline"));
    };

    return (
        <section className="flex min-h-0 flex-1 flex-col">
            <div data-edit-area="preview" aria-label={t("editor.preview")} className="flex min-h-0 flex-1 flex-col border-b border-black/[0.07] dark:border-white/[0.07]">
                <header className="flex h-11 shrink-0 items-center gap-2 px-4">
                    <Button
                        type="text"
                        size="small"
                        className="!h-7 !w-7 !min-w-7 !p-0"
                        disabled={totalSeconds <= 0}
                        icon={playing ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
                        aria-label={playing ? t("editor.pause") : t("editor.play")}
                        onClick={togglePreview}
                    />
                    <span className="shrink-0 text-[12px] tabular-nums text-stone-600 dark:text-zinc-400">
                        <span ref={readoutRef}>0:00.0</span>
                        <span className="text-stone-400 dark:text-zinc-600"> / {formatEditTime(totalSeconds)}</span>
                    </span>
                    <span ref={activeLabelRef} className="min-w-0 flex-1 truncate text-[11px] text-stone-400 dark:text-zinc-600" />
                    <Tooltip title={t("editor.previewHintDetail")}>
                        <span className="inline-flex shrink-0 cursor-help items-center gap-1 text-[10px] text-stone-400 dark:text-zinc-600">
                            <Info className="size-3" />
                            {t("editor.previewHint")}
                        </span>
                    </Tooltip>
                </header>
                <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/85">
                    {empty ? (
                        <div className="flex flex-col items-center gap-2 px-6 text-center">
                            <Clapperboard className="size-6 text-white/30" />
                            <span className="text-[12px] text-white/60">{hasMedia ? t("editor.emptyClips") : t("editor.emptyMedia")}</span>
                        </div>
                    ) : (
                        <video ref={attachVideo} onTimeUpdate={stepPreview} playsInline preload="metadata" className="max-h-full max-w-full" />
                    )}
                </div>
            </div>

            <div data-edit-area="timeline" aria-label={t("editor.timeline")} className="flex h-[196px] shrink-0 flex-col px-4 pt-2.5">
                <div className="flex h-6 shrink-0 items-center gap-2">
                    <span className="text-[11px] font-medium text-stone-700 dark:text-zinc-300">{t("editor.timeline")}</span>
                    <span className="text-[10px] tabular-nums text-stone-400 dark:text-zinc-600">{t("editor.clipCount", { count: views.length })}</span>
                    <span className="ml-auto text-[10px] text-stone-400 dark:text-zinc-600">{t("editor.timelineHint")}</span>
                </div>

                {empty ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                        <span className="text-[12px] text-stone-500 dark:text-zinc-500">{hasMedia ? t("editor.emptyClips") : t("editor.emptyMedia")}</span>
                        <span className="text-[10px] text-stone-400 dark:text-zinc-600">{t("editor.emptyClipsHint")}</span>
                        {hasMedia ? (
                            <Button size="small" onClick={addAllToTimeline}>
                                {t("editor.emptyClipsAction")}
                            </Button>
                        ) : null}
                    </div>
                ) : (
                    <div className="relative mt-2" ref={timelineRef}>
                        <div className="relative h-6 cursor-pointer touch-none select-none" title={t("editor.seekHint")} onPointerDown={(event) => { seekingRef.current = true; movePlayheadFromClientX(event.clientX, false); }} onPointerMove={(event) => { if (seekingRef.current) movePlayheadFromClientX(event.clientX, false); }} onPointerUp={() => { seekingRef.current = false; seekPreview(secondsRef.current); }} onPointerCancel={() => { seekingRef.current = false; }} onPointerLeave={() => { seekingRef.current = false; }}>
                            {ticks.map((tickValue) => (
                                <span key={tickValue} className="absolute top-0 flex flex-col items-center" style={{ left: `${(tickValue / totalSeconds) * 100}%`, transform: tickValue === 0 ? "none" : "translateX(-50%)" }}>
                                    <span className="h-1.5 w-px bg-stone-300 dark:bg-zinc-700" />
                                    <span className="text-[9px] leading-none tabular-nums text-stone-400 dark:text-zinc-600">{editTickLabel(tickValue, tickStep)}</span>
                                </span>
                            ))}
                            <span className="absolute bottom-0 right-0 text-[9px] leading-none text-stone-400 dark:text-zinc-600">{t("editor.seconds")}</span>
                        </div>

                        <div className="flex items-stretch gap-1" onPointerMove={handleTimelineMove} onPointerUp={endTimelineDrag} onPointerCancel={endTimelineDrag} onPointerLeave={endTimelineDrag}>
                            {views.map((view, index) => (
                                <div
                                    key={view.id}
                                    data-edit-clip={view.id}
                                    className={`relative h-12 min-w-[14px] cursor-grab touch-none select-none overflow-hidden rounded-[8px] border transition-colors active:cursor-grabbing ${view.id === clipId ? "border-[#756bff]" : "border-black/[0.09] hover:bg-black/[0.03] dark:border-white/[0.09] dark:hover:bg-white/[0.04]"}`}
                                    // 片段条宽度按真实时长铺开：flexGrow 就是该段秒数，拖动裁剪时直接改这个值即可让后面自动让位。
                                    style={{ flex: `${Math.max(0.2, view.length)} 1 0%` }}
                                    title={t("editor.clipHint", { index: index + 1, seconds: view.length.toFixed(1) })}
                                    onPointerDown={(event) => { startReorder(event, index); onSelectClip(view.id); }}
                                >
                                    <span data-clip-label className="pointer-events-none absolute inset-0 flex items-center gap-1 truncate px-2 text-[10px] text-stone-500 dark:text-zinc-400">
                                        {view.hasDuration ? clipLabel(view, index, view.length) : t("editor.clipNoDuration", { index: index + 1 })}
                                    </span>
                                    <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-[8px] hover:bg-black/10 dark:hover:bg-white/15" title={t("editor.trimStart")} onPointerDown={(event) => startTrim(event, index, "start")} />
                                    <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-[8px] hover:bg-black/10 dark:hover:bg-white/15" title={t("editor.trimEnd")} onPointerDown={(event) => startTrim(event, index, "end")} />
                                </div>
                            ))}
                        </div>

                        {/* 播放头：位置只由 paintPlayhead 直接写 style.left，不参与 React 渲染。 */}
                        <div ref={playheadRef} data-edit-playhead className="pointer-events-none absolute inset-y-0 w-px bg-[#756bff]" style={{ left: "0%" }} />
                    </div>
                )}

                <div className="mt-auto flex items-center gap-1.5 pb-2 text-[10px] text-stone-400 dark:text-zinc-600">
                    <Music2 className="size-3" />
                    {t("editor.audioTrackHint")}
                </div>
            </div>
        </section>
    );
}
