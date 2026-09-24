import { Clapperboard, Columns2, FileText, Group, Image as ImageIcon, Layers, Music2, Settings2, Video } from "lucide-react";

import i18n from "@/i18n";

import { COMPARE_IMAGE_PORT_ID } from "@/lib/canvas/compare-sources";
import { COLLAGE_RESULT_PORT_ID, COLLAGE_SOURCE_PORT_ID } from "@/lib/canvas/collage-layout";
import { NODE_SPECS } from "@/constant/canvas";
import { registerNodeDefinitions } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodePort } from "@/types/canvas";
import type { CanvasNodeDefinition, CanvasNodeResource } from "@/types/canvas-plugin";

// Extensible metadata for built-in nodes, reusing NODE_SPECS for size and initial metadata.
// Rendering remains in canvas-node's internal renderer, so no Content component is provided.
function builtinResource(node: CanvasNodeData): CanvasNodeResource | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return { kind: "image", url: node.metadata.content };
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return { kind: "video", url: node.metadata.content };
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return { kind: "audio", url: node.metadata.content };
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return { kind: "text", text: node.metadata.content || node.metadata.prompt };
    return null;
}

const iconClass = "size-5";

// 视频合成节点的连接端口：多个视频片段 + 一路背景音乐，输出合成后的视频。
export const COMPOSITE_SEGMENTS_PORT_ID = "segments";
export const COMPOSITE_MUSIC_PORT_ID = "music";
export const COMPOSITE_VOICE_PORT_ID = "voice";
export const COMPOSITE_VIDEO_OUTPUT_PORT_ID = "video";

const COMPOSITE_PORTS: CanvasNodePort[] = [
    { id: COMPOSITE_SEGMENTS_PORT_ID, label: "片段", direction: "input", dataType: "video", multiple: true, description: "连接多个视频节点作为片段，连线顺序即拼接顺序" },
    { id: COMPOSITE_VOICE_PORT_ID, label: "配音", direction: "input", dataType: "audio", description: "可连接 1 个音频节点作为人声/配音轨" },
    { id: COMPOSITE_MUSIC_PORT_ID, label: "音乐", direction: "input", dataType: "audio", description: "可连接 1 个音频节点作为背景音乐" },
    { id: COMPOSITE_VIDEO_OUTPUT_PORT_ID, label: "视频", direction: "output", dataType: "video" },
];

// 对比节点的连接端口：只吃图片、只取前两张，不产出内容。
const COMPARE_PORTS: CanvasNodePort[] = [{ id: COMPARE_IMAGE_PORT_ID, label: "图片", direction: "input", dataType: "image", multiple: true, description: "连接 2 张图片节点做左右滑动对比，连线顺序决定左右" }];

// 拼合节点的连接端口：最多 10 张图片当图层，另有一路输出承接保存后的拼合图。
const COLLAGE_PORTS: CanvasNodePort[] = [
    { id: COLLAGE_SOURCE_PORT_ID, label: "图片", direction: "input", dataType: "image", multiple: true, description: "最多连接 10 张图片节点当图层，双击节点进全屏编辑器摆放" },
    { id: COLLAGE_RESULT_PORT_ID, label: "拼合图", direction: "output", dataType: "image", description: "保存后把拼合结果接到新的图片节点" },
];

const BUILTIN_DEFINITIONS: CanvasNodeDefinition[] = [
    { type: CanvasNodeType.Text, title: i18n.t("assets.kinds.text"), icon: <FileText className={iconClass} />, minimapColor: undefined, resource: builtinResource },
    { type: CanvasNodeType.Image, title: i18n.t("assets.kinds.image"), icon: <ImageIcon className={iconClass} />, minimapColor: "#10b981", keepAspectRatio: (node: CanvasNodeData) => !node.metadata?.freeResize, resource: builtinResource },
    { type: CanvasNodeType.Video, title: i18n.t("assets.kinds.video"), icon: <Video className={iconClass} />, minimapColor: "#f97316", keepAspectRatio: () => true, resource: builtinResource },
    { type: CanvasNodeType.Audio, title: i18n.t("assets.kinds.audio"), icon: <Music2 className={iconClass} />, minimapColor: "#a855f7", resource: builtinResource },
    { type: CanvasNodeType.Composite, title: i18n.t("canvas.nodeTypes.composite"), icon: <Clapperboard className={iconClass} />, minimapColor: "#14b8a6", ports: COMPOSITE_PORTS, description: "用 FFmpeg 拼接多个视频片段并可叠加背景音乐" },
    { type: CanvasNodeType.Compare, title: i18n.t("canvas.nodeTypes.compare"), icon: <Columns2 className={iconClass} />, minimapColor: "#8b5cf6", ports: COMPARE_PORTS, hasSourceHandle: false, description: "连接 2 张图片左右滑动对比，双击可全屏比对" },
    { type: CanvasNodeType.Collage, title: i18n.t("canvas.nodeTypes.collage"), icon: <Layers className={iconClass} />, minimapColor: "#f97316", ports: COLLAGE_PORTS, description: "最多 10 张图片当图层自由摆放，双击进全屏编辑器" },
    { type: CanvasNodeType.Config, title: i18n.t("canvas.configNode.title"), icon: <Settings2 className={iconClass} />, minimapColor: "#60a5fa", hasSourceHandle: false, showInCreateMenu: false },
    { type: CanvasNodeType.Group, title: i18n.t("canvas.node.group"), icon: <Group className={iconClass} />, minimapColor: "#94a3b8" },
].map((def) => {
    const spec = NODE_SPECS[def.type];
    return { ...def, title: spec.title, defaultSize: { width: spec.width, height: spec.height }, defaultMetadata: spec.metadata };
});

let registered = false;
export function registerBuiltinNodes() {
    if (registered) return;
    registered = true;
    registerNodeDefinitions(BUILTIN_DEFINITIONS, "builtin");
}
