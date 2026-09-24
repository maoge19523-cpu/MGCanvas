import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { COMPOSITE_VIDEO_OUTPUT_PORT_ID, resolveCompositeSources } from "@/lib/canvas/composite-editing";
import { composeVideo, readFfmpegPath, resolveCanvasMediaLocalPath, type ComposeVideoResult } from "@/services/platform/desktop-ffmpeg";
import { desktopFileUrl } from "@/services/platform/desktop-runtime";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

// 成片（视频节点）的尺寸上限，与画布上其它视频节点保持一致。
export const VIDEO_NODE_MAX_WIDTH = 660;
export const VIDEO_NODE_MAX_HEIGHT = 520;

/**
 * 按节点上的 compositeSettings 调 Rust 侧的 compose_video，返回 FFmpeg 结果。
 * 画布上的「开始合成」与剪辑台的「导出成片」都走这里，两条入口的参数与调用方式完全一致。
 */
export async function composeCompositeVideo(compositeNode: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): Promise<ComposeVideoResult> {
    const settings = compositeNode.metadata?.compositeSettings || {};
    const { segments, music, voice } = resolveCompositeSources(nodes, connections, compositeNode.id);
    if (!segments.length) throw new Error("请先连接至少 1 个视频节点作为片段");
    const requestSegments = await Promise.all(
        segments.map(async (segment) => {
            const segmentSettings = settings.segments?.[segment.node.id] || {};
            return {
                path: await resolveCanvasMediaLocalPath(segment.node),
                start: segmentSettings.start,
                end: segmentSettings.end,
                volume: segmentSettings.volume,
                transition: segmentSettings.transition,
                transitionDuration: segmentSettings.transitionDuration,
                subtitle: segmentSettings.subtitle,
                fadeIn: segmentSettings.fadeIn,
                fadeOut: segmentSettings.fadeOut,
            };
        }),
    );
    // 配音与背景音乐是两条独立音轨，各自音量与淡出都在剪辑台属性区调。
    const tracks: { path: string; volume?: number; fadeOut?: number; loop?: boolean }[] = [];
    if (voice) tracks.push({ path: await resolveCanvasMediaLocalPath(voice.node), volume: settings.voiceVolume, fadeOut: settings.voiceFadeOut, loop: settings.voiceLoop });
    if (music) tracks.push({ path: await resolveCanvasMediaLocalPath(music.node), volume: settings.musicVolume, fadeOut: settings.musicFadeOut, loop: settings.musicLoop });
    return composeVideo({
        ffmpegPath: readFfmpegPath() || undefined,
        segments: requestSegments,
        tracks,
        longEdge: settings.longEdge,
        fps: settings.fps,
        fadeIn: settings.fadeIn,
        fadeOut: settings.fadeOut,
        title: compositeNode.title,
        subtitleStyle: settings.subtitleStyle,
        subtitleSize: settings.subtitleSize,
    });
}

/** 成片回落成的新视频节点：放在合成节点右侧，尺寸按 FFmpeg 返回的实际像素算。 */
export function buildCompositeOutputNode(compositeNode: CanvasNodeData, result: ComposeVideoResult): CanvasNodeData {
    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
    const videoSize = fitNodeSize(result.width || spec.width, result.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
    return {
        id: `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type: CanvasNodeType.Video,
        title: `${compositeNode.title || "合成"} · 成片`,
        position: { x: compositeNode.position.x + compositeNode.width + 96, y: compositeNode.position.y + compositeNode.height / 2 - videoSize.height / 2 },
        width: videoSize.width,
        height: videoSize.height,
        metadata: {
            content: desktopFileUrl(result.absolutePath),
            localPath: result.absolutePath,
            filename: result.filename,
            mimeType: result.mimeType,
            bytes: result.bytes,
            naturalWidth: result.width,
            naturalHeight: result.height,
            durationMs: result.durationMs,
            status: "success",
            sourceOrigin: "generated",
        },
    };
}

/** 合成节点 → 成片的自动连线（成片回落流程的一部分）。 */
export function buildCompositeOutputConnection(compositeNodeId: string, outputNodeId: string): CanvasConnection {
    return { id: nanoid(), fromNodeId: compositeNodeId, toNodeId: outputNodeId, fromPortId: COMPOSITE_VIDEO_OUTPUT_PORT_ID };
}
