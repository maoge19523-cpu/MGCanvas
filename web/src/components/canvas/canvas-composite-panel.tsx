import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, InputNumber, Select, Switch, Tooltip, message } from "antd";
import { ChevronDown, ChevronUp, Clapperboard, Info, LoaderCircle, Mic, Music2, Pause, Play, Video, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { detectFfmpeg } from "@/services/platform/desktop-ffmpeg";
import { isTauriRuntime } from "@/services/platform/desktop-runtime";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasCompositeSettings, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { getCanvasNodePopupContainer } from "./canvas-node-popup";

export type CompositeSegmentSource = { connectionId: string; node: CanvasNodeData };

export type CanvasCompositePanelProps = {
    node: CanvasNodeData;
    segments: CompositeSegmentSource[];
    music: CompositeSegmentSource | null;
    voice: CompositeSegmentSource | null;
    isRunning: boolean;
    onChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onRun: (node: CanvasNodeData) => void;
    onReorderConnections: (sourceConnectionId: string, targetConnectionId: string) => void;
    onRemoveConnection: (connectionId: string) => void;
    onFocusReference: (nodeId: string) => void;
};

function clampPercent(value: number | string | null | undefined, fallback: number) {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (parsed === null || parsed === undefined || Number.isNaN(parsed)) return fallback;
    return Math.min(400, Math.max(0, parsed));
}

// 顺序连播预览的片段快照：入出点、音量、淡入淡出都取面板当前参数，offset 是该段在总时间轴上的起点。
// 预览只读这份快照，不回写画布，也不改 metadata.compositeSettings 的结构。
export type CompositePreviewClip = { id: string; connectionId: string; title: string; src: string; start: number; length: number; offset: number; volume: number; fadeIn: number; fadeOut: number };

function segmentTiming(sourceSeconds: number, item: NonNullable<CanvasCompositeSettings["segments"]>[string]) {
    const start = Math.max(0, item.start || 0);
    const end = item.end && sourceSeconds ? Math.min(item.end, sourceSeconds) : sourceSeconds;
    return { start, length: Math.max(0, (end || 0) - start) };
}

/** 按连线顺序（即片段顺序）算出每段的秒数与起点，总时长只由各段净时长决定，与顺序无关。 */
export function buildCompositePreviewClips(segments: CompositeSegmentSource[], settings: CanvasCompositeSettings): CompositePreviewClip[] {
    let offset = 0;
    return segments.map((segment) => {
        const item = settings.segments?.[segment.node.id] || {};
        const { start, length } = segmentTiming((segment.node.metadata?.durationMs || 0) / 1000, item);
        const clip: CompositePreviewClip = {
            id: segment.node.id,
            connectionId: segment.connectionId,
            title: segment.node.title || "未命名",
            src: segment.node.metadata?.content || "",
            start,
            length,
            offset,
            volume: item.volume ?? 1,
            fadeIn: item.fadeIn ?? 0,
            fadeOut: item.fadeOut ?? 0,
        };
        offset += length;
        return clip;
    });
}

/**
 * 播放头纯计算：给当前段与媒体时间，算出全局秒数、该段音量（含淡入淡出）以及这一段是否播完。
 * 抽成纯函数既让 requestAnimationFrame 循环体保持一行调用，也便于单测直接覆盖连播切换。
 */
export function resolveCompositePlayback(clips: CompositePreviewClip[], index: number, currentTime: number) {
    const clip = clips[index];
    if (!clip) return null;
    const local = Math.max(0, Math.min(currentTime - clip.start, clip.length));
    const fadeIn = clip.fadeIn > 0 ? local / clip.fadeIn : 1;
    const fadeOut = clip.fadeOut > 0 ? (clip.length - local) / clip.fadeOut : 1;
    return {
        index,
        local,
        seconds: clip.offset + local,
        // 浏览器音量上限是 1，面板允许的 400% 只能在 FFmpeg 侧生效，这里封顶。
        volume: Math.min(1, Math.max(0, clip.volume * Math.min(1, fadeIn, fadeOut))),
        finished: local >= clip.length - 0.03,
    };
}

/** 播放中拖动/点击播放头时，把全局秒数反查成「第几段 + 段内媒体时间」。 */
export function resolveCompositeSeek(clips: CompositePreviewClip[], seconds: number) {
    const last = clips.length - 1;
    let index = clips.findIndex((clip) => seconds < clip.offset + clip.length);
    if (index < 0) index = last;
    const clip = clips[index];
    return clip ? { index, currentTime: clip.start + Math.max(0, Math.min(seconds - clip.offset, clip.length)) } : null;
}

// 标尺刻度步长：在 0.5s～120s 里挑一档，让刻度数不超过 8 个。
const TIMELINE_TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];

function timelineTickStep(total: number) {
    return TIMELINE_TICK_STEPS.find((step) => total / step <= 8) ?? TIMELINE_TICK_STEPS[TIMELINE_TICK_STEPS.length - 1];
}

function timelineTickLabel(seconds: number, step: number) {
    if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
    return step < 1 ? seconds.toFixed(1) : String(Math.round(seconds));
}

/** 播放头读数与总时长统一用「分:秒.十分位」，与导出时长口径一致。 */
export function formatTimelineTime(seconds: number) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safe / 60);
    return `${minutes}:${(safe - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

export function CanvasCompositePanel({ node, segments: segmentsProp, music, voice, isRunning, onChange, onRun, onReorderConnections, onRemoveConnection, onFocusReference }: CanvasCompositePanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const settings = node.metadata?.compositeSettings || {};
    const desktop = isTauriRuntime();
    const [ffmpegState, setFfmpegState] = useState<{ status: "checking" | "ready" | "missing"; path: string }>({ status: "checking", path: "" });

    useEffect(() => {
        if (!desktop) return;
        let active = true;
        // 探测结果与当前状态一致时必须返回同一个对象：每次都塞新对象会让这个 effect 反复触发
        // 渲染，与拖动写入叠加就形成渲染风暴（React #185）。
        const applyFfmpegState = (next: { status: "ready" | "missing"; path: string }) =>
            setFfmpegState((current) => (current.status === next.status && current.path === next.path ? current : next));
        void detectFfmpeg()
            .then((path) => {
                if (active) applyFfmpegState(path ? { status: "ready", path } : { status: "missing", path: "" });
            })
            .catch(() => {
                if (active) applyFfmpegState({ status: "missing", path: "" });
            });
        return () => {
            active = false;
        };
    }, [desktop, node.id]);

    const update = (patch: Partial<CanvasCompositeSettings>) => onChange(node.id, { compositeSettings: { ...node.metadata?.compositeSettings, ...patch } });
    const updateSegment = (sourceNodeId: string, patch: Partial<NonNullable<CanvasCompositeSettings["segments"]>[string]>) =>
        onChange(node.id, {
            compositeSettings: {
                ...node.metadata?.compositeSettings,
                segments: { ...node.metadata?.compositeSettings?.segments, [sourceNodeId]: { ...node.metadata?.compositeSettings?.segments?.[sourceNodeId], ...patch } },
            },
        });

    // 片段顺序即连线顺序。时间标尺、播放头与顺序连播预览都以这份快照为唯一口径：
    // 拖动预览期间显示的 segments 可能临时换序，但总时长与顺序无关，播放也只按已提交的顺序走。
    const previewClips = buildCompositePreviewClips(segmentsProp, settings);
    const totalSeconds = previewClips.reduce((sum, clip) => sum + clip.length, 0);

    const segmentLabel = (index: number) => `片段 ${index + 1}`;

    // 时间轴上的直接操作：拖片段本体换顺序，拖两端裁剪入点/出点。
    // 不锁定指针，也不做坐标换算——按指针每挪过一小段就与相邻片段交换一次，避免画布缩放带来的坐标麻烦。
    const dragRef = useRef<{ index: number; x: number; target: number | null } | null>(null);
    const trimRef = useRef<{ index: number; edge: "start" | "end"; x: number; perPixel: number; pending: number | null } | null>(null);
    const draggedRef = useRef(false);
    // 拖动过程的实时预览只放在组件内：不写画布数据，避免逐帧写入形成渲染风暴。
    const [previewTarget, setPreviewTarget] = useState<number | null>(null);
    const [previewTrim, setPreviewTrim] = useState<{ id: string; start?: number; end?: number } | null>(null);

    const startDrag = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
        event.stopPropagation();
        draggedRef.current = false;
        dragRef.current = { index, x: event.clientX, target: null };
        setPreviewTarget(null);
    };

    const startTrim = (event: ReactPointerEvent<HTMLSpanElement>, index: number, edge: "start" | "end") => {
        event.stopPropagation();
        const box = (event.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
        const segment = segmentsProp[index];
        if (!segment) return;
        const source = (segment.node.metadata?.durationMs || 0) / 1000;
        const item = settings.segments?.[segment.node.id] || {};
        const length = Math.max(0.1, (item.end && source ? Math.min(item.end, source) : source) - (item.start || 0));
        draggedRef.current = true;
        trimRef.current = { index, edge, x: event.clientX, perPixel: box && box.width > 0 ? length / box.width : 0.05, pending: null };
        setPreviewTrim(null);
    };

    // 拖动过程中只记录目标值并刷新组件内预览，不写画布；松手时一次性提交。
    const handleTimelineMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const trim = trimRef.current;
        if (trim) {
            event.stopPropagation();
            const segment = segmentsProp[trim.index];
            if (!segment) return;
            const item = settings.segments?.[segment.node.id] || {};
            const source = (segment.node.metadata?.durationMs || 0) / 1000;
            const delta = (event.clientX - trim.x) * trim.perPixel;
            if (trim.edge === "start") {
                const from = item.start || 0;
                const until = (item.end && source ? Math.min(item.end, source) : source) - 0.1;
                trim.pending = Number(Math.min(Math.max(0, from + delta), Math.max(0, until)).toFixed(2));
                setPreviewTrim({ id: segment.node.id, start: trim.pending });
            } else {
                const from = item.start || 0;
                const until = item.end && source ? Math.min(item.end, source) : source;
                const next = Math.max(from + 0.1, until + delta);
                trim.pending = Number((source ? Math.min(next, source) : next).toFixed(2));
                setPreviewTrim({ id: segment.node.id, end: trim.pending });
            }
            return;
        }
        const drag = dragRef.current;
        if (!drag) return;
        event.stopPropagation();
        const dx = event.clientX - drag.x;
        if (Math.abs(dx) < 24) return;
        const target = drag.index + (dx > 0 ? 1 : -1);
        if (target < 0 || target >= segmentsProp.length) return;
        draggedRef.current = true;
        drag.target = target;
        setPreviewTarget(target);
    };

    const endTimelineDrag = () => {
        const drag = dragRef.current;
        const trim = trimRef.current;
        dragRef.current = null;
        trimRef.current = null;
        setPreviewTarget(null);
        setPreviewTrim(null);
        if (drag && drag.target !== null) {
            const target = drag.target;
            if (target >= 0 && target < segmentsProp.length && target !== drag.index) {
                onReorderConnections(segmentsProp[drag.index]!.connectionId, segmentsProp[target]!.connectionId);
            }
        }
        if (trim && trim.pending !== null) {
            const segment = segmentsProp[trim.index];
            if (segment) {
                const item = settings.segments?.[segment.node.id] || {};
                const current = trim.edge === "start" ? item.start || 0 : item.end || 0;
                if (trim.pending !== current) {
                    updateSegment(segment.node.id, trim.edge === "start" ? { start: trim.pending } : { end: trim.pending });
                }
            }
        }
    };

    // ── 时间标尺 / 播放头 / 顺序连播预览 ─────────────────────────────────────
    // 播放头秒数是纯 UI 状态：只存在 ref 里，不进画布 store、不进节点 metadata，也**不进 React 状态**。
    // 播放期间每帧只写 ref 并直接改 DOM（播放头 left、读数 textContent），组件一次都不重渲染，
    // 从根上避免重演「逐帧写状态 → 渲染风暴 → React #185」。播放/暂停这一个低频开关才用 state。
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const previewVideoRef = useRef<HTMLVideoElement | null>(null);
    const playheadRef = useRef<HTMLDivElement | null>(null);
    const previewTimeRef = useRef<HTMLSpanElement | null>(null);
    const previewClipRef = useRef<HTMLSpanElement | null>(null);
    const timelineRef = useRef<HTMLDivElement | null>(null);
    const previewSecondsRef = useRef(0);
    const previewTotalRef = useRef(0);
    const previewPlayingRef = useRef(false);
    const previewIndexRef = useRef(0);
    const previewClipsRef = useRef<CompositePreviewClip[]>([]);
    const previewFrameRef = useRef(0);
    const previewAwaitingRef = useRef(false);
    const previewHandlersRef = useRef<{ loaded: () => void; failed: () => void } | null>(null);
    const seekDraggingRef = useRef(false);

    // 播放头与读数一律直接改 DOM：这两个节点的 style/textContent 不参与 React 渲染，
    // 因此其它原因引起的重渲染也不会把播放中的位置冲掉。
    const paintPlayhead = (seconds: number, total = totalSeconds) => {
        if (playheadRef.current) playheadRef.current.style.left = `${total > 0 ? Math.min(100, Math.max(0, (seconds / total) * 100)) : 0}%`;
        if (previewTimeRef.current) previewTimeRef.current.textContent = formatTimelineTime(seconds);
        const index = previewClipsRef.current.findIndex((clip) => seconds < clip.offset + clip.length);
        const active = previewPlayingRef.current && index >= 0 ? previewClipsRef.current[index] : null;
        if (previewClipRef.current) previewClipRef.current.textContent = active ? `· 片段 ${index + 1} ${active.title}` : "";
    };

    const detachPreviewHandlers = (video: HTMLVideoElement) => {
        const handlers = previewHandlersRef.current;
        if (!handlers) return;
        video.removeEventListener("loadedmetadata", handlers.loaded);
        video.removeEventListener("error", handlers.failed);
        previewHandlersRef.current = null;
    };

    // 清干净一个 <video>：pause + 移除 src + load()，否则元素被卸载后仍会在后台继续出声。
    const releasePreviewVideo = (video: HTMLVideoElement) => {
        detachPreviewHandlers(video);
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.volume = 1;
    };

    const stopPreview = () => {
        if (previewFrameRef.current) cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = 0;
        previewPlayingRef.current = false;
        previewAwaitingRef.current = false;
        if (previewVideoRef.current) releasePreviewVideo(previewVideoRef.current);
        setPreviewPlaying(false);
    };

    // 用稳定的 callback ref 接管 <video>：元素被移除（关闭面板、片段清空、切换节点）时 React 会先回调 null
    // 再摘 DOM，正好在这里停播；普通 useEffect 清理拿到的 ref 那时已经是 null，拦不住后台播放。
    const attachPreviewVideo = useCallback((element: HTMLVideoElement | null) => {
        const previous = previewVideoRef.current;
        if (previous && previous !== element) releasePreviewVideo(previous);
        previewVideoRef.current = element;
    }, []);

    // 逐段播放：切 src → 等元数据 → 定位到入点 → play()，段尾由 rAF 循环判定后切下一段。
    const startPreviewClip = (index: number, seekTo?: number) => {
        const video = previewVideoRef.current;
        const clip = previewClipsRef.current[index];
        if (!video || !clip) {
            stopPreview();
            return;
        }
        detachPreviewHandlers(video);
        previewIndexRef.current = index;
        previewAwaitingRef.current = true;
        // 换段瞬间先把播放头放到该段落点：等元数据的空档里读数不会停在上一段末尾。
        const landing = seekTo ?? clip.start;
        paintPlayhead(clip.offset + Math.max(0, landing - clip.start), previewTotalRef.current);
        const loaded = () => {
            detachPreviewHandlers(video);
            previewAwaitingRef.current = false;
            if (landing > 0) video.currentTime = landing;
            void video.play().catch(() => {
                message.warning("预览播放被系统拦截，请再点一次播放");
                stopPreview();
            });
        };
        const failed = () => {
            detachPreviewHandlers(video);
            message.warning(`片段「${clip.title}」无法在预览中播放`);
            stopPreview();
        };
        previewHandlersRef.current = { loaded, failed };
        video.addEventListener("loadedmetadata", loaded);
        video.addEventListener("error", failed);
        video.src = clip.src;
        video.load();
    };

    // 播放心跳：读 <video>.currentTime → 算播放头秒数与音量 → 段尾切下一段，末段播完停表。
    // 抽成一步是为了让两条驱动共用：rAF 负责播放头平滑跟随，timeupdate 兜住「窗口不可见时浏览器停掉 rAF」
    // 的情况（否则当前段会越过出点一直放下去）。两处同时触发也安全——previewAwaitingRef 会挡住重复切段。
    const stepPreview = () => {
        if (!previewPlayingRef.current) return false;
        const video = previewVideoRef.current;
        if (!video) {
            stopPreview();
            return false;
        }
        if (previewAwaitingRef.current) return true;
        const clips = previewClipsRef.current;
        const state = resolveCompositePlayback(clips, previewIndexRef.current, video.currentTime);
        if (!state) {
            stopPreview();
            return false;
        }
        video.volume = state.volume;
        previewSecondsRef.current = state.seconds;
        paintPlayhead(state.seconds, previewTotalRef.current);
        if (state.finished) {
            // 跳过零时长的片段（源视频没有探测到时长），找不到下一段就停表。
            const next = clips.findIndex((clip, index) => index > state.index && clip.length > 0);
            if (next < 0) {
                stopPreview();
                paintPlayhead(previewTotalRef.current, previewTotalRef.current);
                return false;
            }
            startPreviewClip(next);
        }
        return true;
    };

    const tickPreview = () => {
        previewFrameRef.current = 0;
        if (!stepPreview()) return;
        previewFrameRef.current = requestAnimationFrame(tickPreview);
    };

    // 播放中定位：把播放头秒数换成「第几段 + 段内时间」，同段只 seek，跨段才重新起播。
    const seekPreview = (seconds: number) => {
        if (!previewPlayingRef.current) return;
        const target = resolveCompositeSeek(previewClipsRef.current, seconds);
        if (!target) return;
        if (target.index === previewIndexRef.current && !previewAwaitingRef.current) {
            if (previewVideoRef.current) previewVideoRef.current.currentTime = target.currentTime;
            return;
        }
        startPreviewClip(target.index, target.currentTime);
    };

    // 点击/拖动标尺只改播放头（ref + DOM）；拖动过程中不提交给 <video>，松手时才 seekPreview 一次。
    const movePlayheadFromClientX = (clientX: number, commit: boolean) => {
        const box = timelineRef.current?.getBoundingClientRect();
        if (!box || box.width <= 0 || totalSeconds <= 0) return;
        const seconds = Math.min(totalSeconds, Math.max(0, ((clientX - box.left) / box.width) * totalSeconds));
        previewSecondsRef.current = seconds;
        paintPlayhead(seconds);
        if (commit) seekPreview(seconds);
    };

    const startSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.stopPropagation();
        seekDraggingRef.current = true;
        movePlayheadFromClientX(event.clientX, false);
    };

    const moveSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!seekDraggingRef.current) return;
        event.stopPropagation();
        movePlayheadFromClientX(event.clientX, false);
    };

    const endSeek = () => {
        if (!seekDraggingRef.current) return;
        seekDraggingRef.current = false;
        seekPreview(previewSecondsRef.current);
    };

    const togglePreview = () => {
        if (previewPlayingRef.current) {
            stopPreview();
            return;
        }
        const clips = previewClips;
        const total = clips.reduce((sum, clip) => sum + clip.length, 0);
        const first = clips.findIndex((clip) => clip.length > 0 && clip.src);
        if (first < 0 || total <= 0) {
            message.warning("暂无可预览的片段时长");
            return;
        }
        previewClipsRef.current = clips;
        previewTotalRef.current = total;
        // 播放头停在末尾时从头开始，否则从当前播放头位置续播。
        const from = previewSecondsRef.current >= total - 0.05 ? 0 : Math.max(0, previewSecondsRef.current);
        const resolved = resolveCompositeSeek(clips, from);
        const target = resolved && clips[resolved.index]!.length > 0 ? resolved : { index: first, currentTime: clips[first]!.start };
        previewPlayingRef.current = true;
        setPreviewPlaying(true);
        startPreviewClip(target.index, target.currentTime);
        if (!previewFrameRef.current) previewFrameRef.current = requestAnimationFrame(tickPreview);
    };

    // 总时长变化（改入出点、增删片段）后重新对齐读数——同样只写 DOM，不触发重渲染。
    useEffect(() => {
        const clamped = Math.min(previewSecondsRef.current, totalSeconds);
        previewSecondsRef.current = clamped;
        paintPlayhead(clamped, totalSeconds);
    }, [totalSeconds]);

    // 组件卸载（关闭面板等）时停表；<video> 已由上面的 callback ref 释放。
    useEffect(() => () => stopPreview(), []);

    // 面板换到另一个合成节点时停播，播放头回到 0。
    useEffect(() => {
        stopPreview();
        previewSecondsRef.current = 0;
    }, [node.id]);

    // 这一屏显示的顺序：拖动中按预览重排，松手后与画布数据一致。只影响显示，不写画布。
    const segments = (() => {
        const from = dragRef.current?.index ?? -1;
        if (previewTarget === null || from < 0 || from >= segmentsProp.length) return segmentsProp;
        if (previewTarget < 0 || previewTarget >= segmentsProp.length) return segmentsProp;
        const list = segmentsProp.slice();
        const [moved] = list.splice(from, 1);
        if (!moved) return segmentsProp;
        list.splice(previewTarget, 0, moved);
        return list;
    })();

    // 标尺刻度：0 到总时长之间按步长铺开，末位刻度不贴右边（总时长在读数里单独显示）。
    const tickStep = timelineTickStep(totalSeconds);
    const ticks: number[] = [];
    for (let tick = 0; totalSeconds > 0 && tick < totalSeconds; tick += tickStep) ticks.push(Number(tick.toFixed(3)));

    return (
        <div
            data-canvas-no-zoom
            className="overflow-visible rounded-2xl border shadow-xl backdrop-blur"
            style={{ background: (theme.node.panelSolid || theme.toolbar.panel), borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5 text-[11px]" style={{ color: theme.node.faint }}>
                <span className="shrink-0" style={{ color: theme.node.muted }}>
                    <Clapperboard className="size-4" />
                </span>
                <span className="shrink-0 font-medium" style={{ color: theme.node.text }}>
                    视频合成
                </span>
                <span className="min-w-0 flex-1 truncate">
                    {segments.length ? `已连接 ${segments.length} 段 · 总时长约 ${totalSeconds.toFixed(1)} 秒${voice ? " · 含配音" : ""}${music ? " · 含背景音乐" : ""}` : "未连接片段"}
                </span>
                {isRunning ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px]" style={{ color: theme.node.muted }}>
                        <LoaderCircle className="size-3 animate-spin" />
                        合成中
                    </span>
                ) : null}
            </div>

            <div className="mx-3 mt-2 flex max-h-[260px] min-h-[64px] flex-col gap-1.5 overflow-y-auto border-b pb-2 thin-scrollbar">
                <div className="pb-0.5 text-[10px] tracking-wide" style={{ color: theme.node.faint }}>
                    片段（连线顺序即拼接顺序，用 FFmpeg 逐段裁剪后拼接）
                </div>
                {segments.length === 0 ? (
                    <div className="flex items-center gap-2 py-1.5 text-[10px]" style={{ color: theme.node.faint }}>
                        <Video className="size-3.5 opacity-50" />
                        把视频节点连到本节点左侧「片段」端口后可在此调整截取与音量
                    </div>
                ) : null}
                {segments.map((segment, index) => {
                    const item = settings.segments?.[segment.node.id] || {};
                    const durationMs = segment.node.metadata?.durationMs || 0;
                    const durationSec = durationMs ? durationMs / 1000 : undefined;
                    return (
                        <div key={segment.connectionId} className="flex flex-col gap-1.5 rounded-lg px-1.5 py-1.5" style={{ background: `${theme.node.fill}55` }}>
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="w-4 shrink-0 text-center text-[10px] tabular-nums" style={{ color: theme.node.faint }}>
                                    {index + 1}
                                </span>
                                {segment.node.metadata?.content ? (
                                    <video src={segment.node.metadata.content} preload="metadata" muted playsInline className="size-9 shrink-0 rounded-md object-cover" style={{ pointerEvents: "none" }} />
                                ) : (
                                    <Video className="size-4 shrink-0 opacity-45" />
                                )}
                                <Tooltip title={segment.node.title}>
                                    <button type="button" className="h-6 min-w-0 flex-1 truncate rounded-md px-1.5 text-left text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={() => onFocusReference(segment.node.id)}>
                                        {segmentLabel(index)} · {segment.node.title || "未命名"}
                                    </button>
                                </Tooltip>
                                <span className="ml-auto inline-flex shrink-0 items-center">
                                    <Button size="small" type="text" disabled={index === 0 || isRunning} icon={<ChevronUp className="size-3.5" />} aria-label="上移" onClick={() => onReorderConnections(segment.connectionId, segments[index - 1]!.connectionId)} />
                                    <Button size="small" type="text" disabled={index === segments.length - 1 || isRunning} icon={<ChevronDown className="size-3.5" />} aria-label="下移" onClick={() => onReorderConnections(segment.connectionId, segments[index + 1]!.connectionId)} />
                                    <Button size="small" type="text" disabled={isRunning} icon={<X className="size-3.5" />} aria-label="移除连线" onClick={() => onRemoveConnection(segment.connectionId)} />
                                </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[10px]" style={{ color: theme.node.faint }}>
                                <span className="inline-flex shrink-0 items-center gap-1">
                                    入
                                    <InputNumber
                                        size="small"
                                        min={0}
                                        max={durationSec || undefined}
                                        step={0.1}
                                        controls={false}
                                        value={typeof item.start === "number" && Number.isFinite(item.start) ? item.start : undefined}
                                        placeholder={durationSec ? "0.0" : "—"}
                                        style={{ width: 76 }}
                                        onChange={(value) => updateSegment(segment.node.id, { start: value === null || !Number.isFinite(Number(value)) ? undefined : Number(value) })}
                                    />
                                    出
                                    <InputNumber
                                        size="small"
                                        min={0}
                                        max={durationSec || undefined}
                                        step={0.1}
                                        controls={false}
                                        value={typeof item.end === "number" && Number.isFinite(item.end) ? item.end : undefined}
                                        placeholder={durationSec ? String(Number(durationSec.toFixed(1))) : "—"}
                                        style={{ width: 76 }}
                                        onChange={(value) => updateSegment(segment.node.id, { end: value === null || !Number.isFinite(Number(value)) ? undefined : Number(value) })}
                                    />
                                    <span>秒</span>
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1">
                                    音量
                                    <InputNumber size="small" min={0} max={400} step={5} addonAfter="%" controls={false} value={Math.round((item.volume ?? 1) * 100)} style={{ width: 96 }} onChange={(value) => updateSegment(segment.node.id, { volume: clampPercent(value, 100) / 100 })} />
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1">
                                    淡入
                                    <InputNumber size="small" min={0} max={5} step={0.5} controls={false} addonAfter="s" value={item.fadeIn ?? 0} style={{ width: 84 }} onChange={(value) => updateSegment(segment.node.id, { fadeIn: value === null || !Number(value) ? undefined : Math.min(5, Math.max(0, Number(value))) })} />
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1">
                                    淡出
                                    <InputNumber size="small" min={0} max={10} step={0.5} controls={false} addonAfter="s" value={item.fadeOut ?? 0} style={{ width: 84 }} onChange={(value) => updateSegment(segment.node.id, { fadeOut: value === null || !Number(value) ? undefined : Math.min(10, Math.max(0, Number(value))) })} />
                                </span>
                                {index < segments.length - 1 ? (
                                    <span className="inline-flex shrink-0 items-center gap-1">
                                        →下一段
                                        <Select
                                            size="small"
                                            className="w-[92px]"
                                            value={item.transition ?? "none"}
                                            getPopupContainer={getCanvasNodePopupContainer}
                                            options={[
                                                { value: "none", label: "硬切" },
                                                { value: "fade", label: "交叉溶解" },
                                                { value: "dissolve", label: "柔和溶解" },
                                                { value: "wipeleft", label: "左滑" },
                                                { value: "wiperight", label: "右滑" },
                                                { value: "slideleft", label: "左推" },
                                                { value: "slideup", label: "上推" },
                                                { value: "circleopen", label: "圆形展开" },
                                            ]}
                                            onChange={(value) => updateSegment(segment.node.id, { transition: value === "none" ? undefined : value })}
                                        />
                                        {item.transition ? (
                                            <InputNumber size="small" min={0.2} max={1.5} step={0.1} controls={false} addonAfter="s" value={item.transitionDuration ?? 0.5} style={{ width: 82 }} onChange={(value) => updateSegment(segment.node.id, { transitionDuration: value === null || !Number.isFinite(Number(value)) ? undefined : Math.min(1.5, Math.max(0.2, Number(value))) })} />
                                        ) : null}
                                    </span>
                                ) : null}
                                <Input
                                    size="small"
                                    className="min-w-[220px] flex-1"
                                    placeholder="这一段的字幕，留空则该段不显示"
                                    value={item.subtitle ?? ""}
                                    onChange={(event) => updateSegment(segment.node.id, { subtitle: event.target.value || undefined })}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b pb-2 text-[11px]" style={{ borderColor: theme.toolbar.border }}>
                <span className="inline-flex shrink-0 items-center gap-1" style={{ color: theme.node.muted }}>
                    <Mic className="size-3.5" />
                    配音
                </span>
                {voice ? (
                    <>
                        <Tooltip title={voice.node.title}>
                            <button type="button" className="h-6 max-w-[170px] truncate rounded-md px-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={() => onFocusReference(voice.node.id)}>
                                {voice.node.title || "未命名音频"}
                            </button>
                        </Tooltip>
                        <InputNumber size="small" min={0} max={400} step={5} addonAfter="%" controls={false} value={Math.round((settings.voiceVolume ?? 1) * 100)} style={{ width: 92 }} onChange={(value) => update({ voiceVolume: clampPercent(value, 100) / 100 })} />
                        <span style={{ color: theme.node.faint }}>
                            循环
                            <Switch size="small" checked={settings.voiceLoop ?? false} onChange={(checked) => update({ voiceLoop: checked })} />
                        </span>
                        <span style={{ color: theme.node.faint }}>
                            淡出
                            <InputNumber size="small" min={0} max={30} step={0.5} controls={false} value={settings.voiceFadeOut ?? 0} addonAfter="s" style={{ width: 84 }} onChange={(value) => update({ voiceFadeOut: value === null ? undefined : Math.min(30, Math.max(0, Number(value))) })} />
                        </span>
                    </>
                ) : (
                    <span style={{ color: theme.node.faint }}>可选：连接 1 个音频节点到本节点「配音」端口</span>
                )}
            </div>

            <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b pb-2 text-[11px]" style={{ borderColor: theme.toolbar.border }}>
                <span className="inline-flex shrink-0 items-center gap-1" style={{ color: theme.node.muted }}>
                    <Music2 className="size-3.5" />
                    背景音乐
                </span>
                {music ? (
                    <>
                        <Tooltip title={music.node.title}>
                            <button type="button" className="h-6 max-w-[170px] truncate rounded-md px-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={() => onFocusReference(music.node.id)}>
                                {music.node.title || "未命名音频"}
                            </button>
                        </Tooltip>
                        <InputNumber size="small" min={0} max={400} step={5} addonAfter="%" controls={false} value={Math.round((settings.musicVolume ?? 1) * 100)} style={{ width: 92 }} onChange={(value) => update({ musicVolume: clampPercent(value, 100) / 100 })} />
                        <span style={{ color: theme.node.faint }}>
                            循环
                            <Switch size="small" checked={settings.musicLoop ?? false} onChange={(checked) => update({ musicLoop: checked })} />
                        </span>
                        <span style={{ color: theme.node.faint }}>
                            淡出
                            <InputNumber size="small" min={0} max={30} step={0.5} controls={false} value={settings.musicFadeOut ?? 1.5} addonAfter="s" style={{ width: 84 }} onChange={(value) => update({ musicFadeOut: value === null ? undefined : Math.min(30, Math.max(0, Number(value))) })} />
                        </span>
                    </>
                ) : (
                    <span style={{ color: theme.node.faint }}>可选：连接 1 个音频节点到本节点「音乐」端口</span>
                )}
            </div>

            <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px]">
                <span className="shrink-0" style={{ color: theme.node.muted }}>
                    输出
                </span>
                <Select
                    size="small"
                    className="w-[104px]"
                    value={settings.longEdge ?? 1080}
                    getPopupContainer={getCanvasNodePopupContainer}
                    options={[
                        { value: 1080, label: "1080P" },
                        { value: 720, label: "720P" },
                        { value: 480, label: "480P" },
                    ]}
                    onChange={(value) => update({ longEdge: value })}
                />
                <span style={{ color: theme.node.faint }}>长边，画幅跟随第一段</span>
                <Select
                    size="small"
                    className="w-[76px]"
                    value={settings.fps ?? 30}
                    getPopupContainer={getCanvasNodePopupContainer}
                    options={[
                        { value: 24, label: "24fps" },
                        { value: 25, label: "25fps" },
                        { value: 30, label: "30fps" },
                        { value: 50, label: "50fps" },
                        { value: 60, label: "60fps" },
                    ]}
                    onChange={(value) => update({ fps: value })}
                />
                <span style={{ color: theme.node.faint }}>
                    淡入
                    <InputNumber size="small" min={0} max={5} step={0.5} controls={false} value={settings.fadeIn ?? 0.5} addonAfter="s" style={{ width: 80 }} onChange={(value) => update({ fadeIn: value === null ? undefined : Math.min(5, Math.max(0, Number(value))) })} />
                </span>
                <span style={{ color: theme.node.faint }}>
                    淡出
                    <InputNumber size="small" min={0} max={10} step={0.5} controls={false} value={settings.fadeOut ?? 0.5} addonAfter="s" style={{ width: 84 }} onChange={(value) => update({ fadeOut: value === null ? undefined : Math.min(10, Math.max(0, Number(value))) })} />
                </span>
                <Select
                    size="small"
                    className="w-[104px]"
                    value={settings.subtitleStyle ?? "bottom"}
                    getPopupContainer={getCanvasNodePopupContainer}
                    options={[
                        { value: "bottom", label: "字幕底部" },
                        { value: "center", label: "字幕居中" },
                    ]}
                    onChange={(value) => update({ subtitleStyle: value })}
                />
                <Select
                    size="small"
                    className="w-[92px]"
                    value={settings.subtitleSize ?? "medium"}
                    getPopupContainer={getCanvasNodePopupContainer}
                    options={[
                        { value: "small", label: "字号小" },
                        { value: "medium", label: "字号中" },
                        { value: "large", label: "字号大" },
                    ]}
                    onChange={(value) => update({ subtitleSize: value })}
                />
            </div>

            {segments.length ? (
                <div className="mx-3 mt-2 pb-2">
                    <div className="flex min-w-0 items-center gap-2 text-[10px]" style={{ color: theme.node.faint }}>
                        <Button
                            size="small"
                            type="text"
                            className="!h-6 !w-6 !min-w-6 !p-0"
                            disabled={totalSeconds <= 0}
                            icon={previewPlaying ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
                            aria-label={previewPlaying ? "暂停顺序预览" : "顺序连播预览"}
                            onClick={togglePreview}
                        />
                        <span className="shrink-0 tabular-nums" style={{ color: theme.node.muted }}>
                            <span ref={previewTimeRef} />
                            <span style={{ color: theme.node.faint }}> / {formatTimelineTime(totalSeconds)}</span>
                        </span>
                        <span ref={previewClipRef} className="min-w-0 flex-1 truncate" />
                        <Tooltip title="预览用浏览器直接播放各段原始素材，不含转场、字幕烧字与多轨混音；成片由 FFmpeg 合成（画面归一化 pad/scale、烧字、混音），效果以导出为准">
                            <span className="inline-flex shrink-0 cursor-help items-center gap-0.5">
                                <Info className="size-3" />
                                预览仅用于对时
                            </span>
                        </Tooltip>
                    </div>
                    <div className="relative mt-1" ref={timelineRef}>
                        {totalSeconds > 0 ? (
                            <div
                                className="relative h-6 cursor-pointer touch-none select-none"
                                title="点击或拖动定位播放头"
                                onPointerDown={startSeek}
                                onPointerMove={moveSeek}
                                onPointerUp={endSeek}
                                onPointerCancel={endSeek}
                                onPointerLeave={endSeek}
                            >
                                {ticks.map((tick) => (
                                    <span key={tick} className="absolute top-0 flex flex-col items-center" style={{ left: `${(tick / totalSeconds) * 100}%`, transform: tick === 0 ? "none" : "translateX(-50%)" }}>
                                        <span className="h-1.5 w-px" style={{ background: theme.node.faint }} />
                                        <span className="text-[9px] leading-none tabular-nums" style={{ color: theme.node.faint }}>
                                            {timelineTickLabel(tick, tickStep)}
                                        </span>
                                    </span>
                                ))}
                                <span className="absolute right-0 bottom-0 text-[9px] leading-none" style={{ color: theme.node.faint }}>
                                    秒
                                </span>
                            </div>
                        ) : null}
                        <div className="flex items-stretch gap-1" onPointerMove={handleTimelineMove} onPointerUp={endTimelineDrag} onPointerCancel={endTimelineDrag} onPointerLeave={endTimelineDrag}>
                            {segments.map((segment, index) => {
                                const base = settings.segments?.[segment.node.id] || {};
                                // 拖动裁剪时用组件内预览秒数显示时长，仍然不写画布数据。
                                const preview = previewTrim && previewTrim.id === segment.node.id ? previewTrim : null;
                                const item = preview ? { ...base, ...(preview.start !== undefined ? { start: preview.start } : {}), ...(preview.end !== undefined ? { end: preview.end } : {}) } : base;
                                const source = (segment.node.metadata?.durationMs || 0) / 1000;
                                const length = Math.max(0, (item.end && source ? Math.min(item.end, source) : source) - (item.start || 0));
                                const share = totalSeconds > 0 ? length / totalSeconds : 1 / segments.length;
                                return (
                                    <div key={segment.node.id} className="flex min-w-0 flex-[1_1_0%] items-center gap-1" style={{ flexGrow: Math.max(0.35, share * 10) }}>
                                        <div
                                            className="relative h-8 min-w-0 flex-1 cursor-grab select-none rounded-md border transition-colors hover:bg-black/5 active:cursor-grabbing dark:hover:bg-white/10"
                                            style={{ borderColor: theme.toolbar.border }}
                                            title={`${segmentLabel(index)} · ${length.toFixed(1)} 秒（拖动换序，拖两端裁剪）`}
                                            onPointerDown={(event) => startDrag(event, index)}
                                            onClick={(event) => {
                                                if (draggedRef.current) return;
                                                // 点击片段条也是一次性事件：定位播放头到点击位置，再按原逻辑聚焦节点。
                                                movePlayheadFromClientX(event.clientX, true);
                                                onFocusReference(segment.node.id);
                                            }}
                                        >
                                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center truncate px-2 text-[10px]" style={{ color: theme.node.muted }}>
                                                {segmentLabel(index)} · {length.toFixed(1)}s
                                            </span>
                                            <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l-md hover:bg-black/10 dark:hover:bg-white/15" title="拖动裁剪入点" onPointerDown={(event) => startTrim(event, index, "start")} />
                                            <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-md hover:bg-black/10 dark:hover:bg-white/15" title="拖动裁剪出点" onPointerDown={(event) => startTrim(event, index, "end")} />
                                        </div>
                                        {index < segments.length - 1 ? (
                                            <span className="shrink-0 text-[10px]" style={{ color: item.transition ? theme.node.text : theme.node.faint }} title={item.transition ? "已设转场" : "硬切"}>
                                                {item.transition ? "◆" : "│"}
                                            </span>
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                        {/* 播放头：位置只由 paintPlayhead 直接写 style.left，不参与 React 渲染。 */}
                        <div ref={playheadRef} data-composite-playhead className="pointer-events-none absolute inset-y-0 w-px" style={{ left: "0%", background: theme.canvas.selectionStroke }} />
                        {/* 顺序预览的播放器：1px 且不可见，但**不用 display:none**，避免个别 WebView 因不可见而暂停媒体；
                            callback ref 稳定，元素被移除时能在摘 DOM 之前停播并清掉 src。 */}
                        <video ref={attachPreviewVideo} onTimeUpdate={stepPreview} className="pointer-events-none absolute h-px w-px opacity-0" playsInline preload="metadata" />
                    </div>
                    <div className="mt-1 text-[10px]" style={{ color: theme.node.faint }}>
                        拖动片段换顺序，拖两端裁剪入点/出点，点一下定位到画布；点标尺或拖播放头可定位预览进度
                    </div>
                </div>
            ) : null}

            <div className="mx-3 mt-2 flex items-center justify-between gap-2 border-t pt-2 pb-2.5" style={{ borderColor: theme.toolbar.border }}>
                <span className="min-w-0 truncate text-[10px]" style={{ color: ffmpegState.status === "missing" && desktop ? "#fbbf24" : theme.node.faint }} title={ffmpegState.path}>
                    {!desktop ? "视频合成仅在桌面客户端可用" : ffmpegState.status === "checking" ? "检测 FFmpeg 中…" : ffmpegState.status === "ready" ? `FFmpeg：${ffmpegState.path}` : "未检测到 FFmpeg，请在设置 → 本地 FFmpeg 手动指定"}
                </span>
                <Button
                    type="primary"
                    className="!h-9 shrink-0 !rounded-full !px-5"
                    loading={isRunning}
                    disabled={!desktop || isRunning || segments.length === 0 || ffmpegState.status === "missing"}
                    onClick={() => onRun(node)}
                >
                    开始合成
                </Button>
            </div>
        </div>
    );
}
