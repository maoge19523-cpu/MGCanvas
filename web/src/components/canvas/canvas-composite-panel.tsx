import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Input, InputNumber, Select, Switch, Tooltip } from "antd";
import { ChevronDown, ChevronUp, Clapperboard, LoaderCircle, Mic, Music2, Video, X } from "lucide-react";

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

    const totalSeconds = segmentsProp.reduce((sum, segment) => {
        const item = settings.segments?.[segment.node.id] || {};
        const durationSec = (segment.node.metadata?.durationMs || 0) / 1000;
        return sum + Math.max(0, (item.end && durationSec ? Math.min(item.end, durationSec) : durationSec) - (item.start || 0));
    }, 0);

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
                    <div className="flex items-stretch gap-1" onPointerMove={handleTimelineMove} onPointerUp={endTimelineDrag} onPointerCancel={endTimelineDrag} onPointerLeave={endTimelineDrag}>
                        {segments.map((segment, index) => {
                            const item = settings.segments?.[segment.node.id] || {};
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
                                        onClick={() => {
                                            if (!draggedRef.current) onFocusReference(segment.node.id);
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
                    <div className="mt-1 text-[10px]" style={{ color: theme.node.faint }}>
                        拖动片段换顺序，拖两端裁剪入点/出点，点一下定位到画布
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
