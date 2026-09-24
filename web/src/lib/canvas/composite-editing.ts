import { CanvasNodeType, type CanvasCompositeSettings, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

// 视频合成编辑的纯计算层：端口、按连线取源、片段快照、播放头、标尺刻度。
// 合成节点的数据口径（片段顺序 = 连线顺序、入出点 = 秒）只在这里实现一份，
// 画布与剪辑台都从这里取，避免两处时长/刻度口径漂移。
// 这里只放纯函数与常量，不引入 i18n / 平台能力 / React，便于在 node 环境直接单测。

// 视频合成节点的连接端口：多个视频片段 + 两路音频，输出合成后的视频。
export const COMPOSITE_SEGMENTS_PORT_ID = "segments";
export const COMPOSITE_MUSIC_PORT_ID = "music";
export const COMPOSITE_VOICE_PORT_ID = "voice";
export const COMPOSITE_VIDEO_OUTPUT_PORT_ID = "video";

export type CompositeSegmentSource = { connectionId: string; node: CanvasNodeData };
export type CompositeSourceSet = { segments: CompositeSegmentSource[]; music: CompositeSegmentSource | null; voice: CompositeSegmentSource | null };

/** 按连线读取合成节点的三类输入：片段（可多路）、配音、背景音乐，连线顺序即片段顺序。 */
export function resolveCompositeSources(nodes: CanvasNodeData[], connections: CanvasConnection[], compositeNodeId: string): CompositeSourceSet {
    const segments: CompositeSegmentSource[] = [];
    let music: CompositeSegmentSource | null = null;
    let voice: CompositeSegmentSource | null = null;
    connections.forEach((connection) => {
        if (connection.toNodeId !== compositeNodeId) return;
        const source = nodes.find((item) => item.id === connection.fromNodeId);
        if (!source || !source.metadata?.content) return;
        if (connection.toPortId === COMPOSITE_SEGMENTS_PORT_ID && source.type === CanvasNodeType.Video) segments.push({ connectionId: connection.id, node: source });
        if (!voice && connection.toPortId === COMPOSITE_VOICE_PORT_ID && source.type === CanvasNodeType.Audio) voice = { connectionId: connection.id, node: source };
        if (!music && connection.toPortId === COMPOSITE_MUSIC_PORT_ID && source.type === CanvasNodeType.Audio) music = { connectionId: connection.id, node: source };
    });
    return { segments, music, voice };
}

// 顺序连播预览的片段快照：入出点、音量、淡入淡出都取当前参数，offset 是该段在总时间轴上的起点。
// 预览只读这份快照，不回写画布，也不改 metadata.compositeSettings 的结构。
export type CompositePreviewClip = { id: string; connectionId: string; title: string; src: string; source: number; start: number; length: number; offset: number; volume: number; fadeIn: number; fadeOut: number };

export function segmentTiming(sourceSeconds: number, item: NonNullable<CanvasCompositeSettings["segments"]>[string]) {
    const start = Math.max(0, item.start || 0);
    const end = item.end && sourceSeconds ? Math.min(item.end, sourceSeconds) : sourceSeconds;
    return { start, length: Math.max(0, (end || 0) - start) };
}

/** 按连线顺序（即片段顺序）算出每段的秒数与起点，总时长只由各段净时长决定，与顺序无关。 */
export function buildCompositePreviewClips(segments: CompositeSegmentSource[], settings: CanvasCompositeSettings): CompositePreviewClip[] {
    let offset = 0;
    return segments.map((segment) => {
        const item = settings.segments?.[segment.node.id] || {};
        const source = (segment.node.metadata?.durationMs || 0) / 1000;
        const { start, length } = segmentTiming(source, item);
        const clip: CompositePreviewClip = {
            id: segment.node.id,
            connectionId: segment.connectionId,
            title: segment.node.title || "未命名",
            src: segment.node.metadata?.content || "",
            source,
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

export function clipTotalSeconds(clips: CompositePreviewClip[]) {
    return clips.reduce((sum, clip) => sum + clip.length, 0);
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

export function timelineTickStep(total: number) {
    return TIMELINE_TICK_STEPS.find((step) => total / step <= 8) ?? TIMELINE_TICK_STEPS[TIMELINE_TICK_STEPS.length - 1]!;
}

export function timelineTickLabel(seconds: number, step: number) {
    if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
    return step < 1 ? seconds.toFixed(1) : String(Math.round(seconds));
}

/** 0 到总时长之间按步长铺开刻度，末位刻度不贴右边（总时长在读数里单独显示）。 */
export function timelineTicks(total: number, step: number) {
    const ticks: number[] = [];
    for (let tick = 0; total > 0 && tick < total; tick += step) ticks.push(Number(tick.toFixed(3)));
    return ticks;
}

/** 播放头读数与总时长统一用「分:秒.十分位」，与导出时长口径一致。 */
export function formatTimelineTime(seconds: number) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safe / 60);
    return `${minutes}:${(safe - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

/** 与下一段之间的转场选项；存 undefined 表示硬切。 */
export const COMPOSITE_TRANSITION_OPTIONS = [
    { value: "none", label: "硬切" },
    { value: "fade", label: "交叉溶解" },
    { value: "dissolve", label: "柔和溶解" },
    { value: "wipeleft", label: "左滑" },
    { value: "wiperight", label: "右滑" },
    { value: "slideleft", label: "左推" },
    { value: "slideup", label: "上推" },
    { value: "circleopen", label: "圆形展开" },
];
