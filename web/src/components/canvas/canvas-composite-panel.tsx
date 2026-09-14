import { useEffect, useState } from "react";
import { Button, InputNumber, Select, Tooltip } from "antd";
import { ChevronDown, ChevronUp, Clapperboard, LoaderCircle, Music2, Video, X } from "lucide-react";

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

export function CanvasCompositePanel({ node, segments, music, isRunning, onChange, onRun, onReorderConnections, onRemoveConnection, onFocusReference }: CanvasCompositePanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const settings = node.metadata?.compositeSettings || {};
    const desktop = isTauriRuntime();
    const [ffmpegState, setFfmpegState] = useState<{ status: "checking" | "ready" | "missing"; path: string }>({ status: "checking", path: "" });

    useEffect(() => {
        if (!desktop) return;
        let active = true;
        void detectFfmpeg()
            .then((path) => {
                if (active) setFfmpegState(path ? { status: "ready", path } : { status: "missing", path: "" });
            })
            .catch(() => {
                if (active) setFfmpegState({ status: "missing", path: "" });
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

    const totalSeconds = segments.reduce((sum, segment) => {
        const item = settings.segments?.[segment.node.id] || {};
        const durationSec = (segment.node.metadata?.durationMs || 0) / 1000;
        return sum + Math.max(0, (item.end && durationSec ? Math.min(item.end, durationSec) : durationSec) - (item.start || 0));
    }, 0);

    const segmentLabel = (index: number) => `片段 ${index + 1}`;

    return (
        <div
            data-canvas-no-zoom
            className="overflow-visible rounded-2xl border shadow-xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
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
                    {segments.length ? `已连接 ${segments.length} 段 · 总时长约 ${totalSeconds.toFixed(1)} 秒${music ? " · 含背景音乐" : ""}` : "未连接片段"}
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
                        <div key={segment.connectionId} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg px-1 py-1" style={{ background: `${theme.node.fill}55` }}>
                            <span className="w-4 shrink-0 text-center text-[10px] tabular-nums" style={{ color: theme.node.faint }}>
                                {index + 1}
                            </span>
                            {segment.node.metadata?.content ? (
                                <video src={segment.node.metadata.content} preload="metadata" muted playsInline className="size-9 shrink-0 rounded-md object-cover" style={{ pointerEvents: "none" }} />
                            ) : (
                                <Video className="size-4 shrink-0 opacity-45" />
                            )}
                            <Tooltip title={segment.node.title}>
                                <button type="button" className="h-6 max-w-[150px] truncate rounded-md px-1.5 text-left text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} onClick={() => onFocusReference(segment.node.id)}>
                                    {segmentLabel(index)} · {segment.node.title || "未命名"}
                                </button>
                            </Tooltip>
                            <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: theme.node.faint }}>
                                入
                                <InputNumber
                                    size="small"
                                    min={0}
                                    max={durationSec || undefined}
                                    step={0.1}
                                    controls={false}
                                    value={typeof item.start === "number" && Number.isFinite(item.start) ? item.start : undefined}
                                    placeholder={durationSec ? "0.0" : "—"}
                                    style={{ width: 72 }}
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
                                    style={{ width: 72 }}
                                    onChange={(value) => updateSegment(segment.node.id, { end: value === null || !Number.isFinite(Number(value)) ? undefined : Number(value) })}
                                />
                                <span>秒</span>
                            </span>
                            <InputNumber size="small" min={0} max={400} step={5} addonAfter="%" controls={false} value={Math.round((item.volume ?? 1) * 100)} style={{ width: 92 }} onChange={(value) => updateSegment(segment.node.id, { volume: clampPercent(value, 100) / 100 })} />
                            <span className="ml-auto inline-flex shrink-0 items-center">
                                <Button size="small" type="text" disabled={index === 0 || isRunning} icon={<ChevronUp className="size-3.5" />} aria-label="上移" onClick={() => onReorderConnections(segment.connectionId, segments[index - 1]!.connectionId)} />
                                <Button size="small" type="text" disabled={index === segments.length - 1 || isRunning} icon={<ChevronDown className="size-3.5" />} aria-label="下移" onClick={() => onReorderConnections(segment.connectionId, segments[index + 1]!.connectionId)} />
                                <Button size="small" type="text" disabled={isRunning} icon={<X className="size-3.5" />} aria-label="移除连线" onClick={() => onRemoveConnection(segment.connectionId)} />
                            </span>
                        </div>
                    );
                })}
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
            </div>

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
