import { Clapperboard, FileText, Group, Image as ImageIcon, Music2, Settings2, Video } from "lucide-react";

import i18n from "@/i18n";

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
export const COMPOSITE_VIDEO_OUTPUT_PORT_ID = "video";

const COMPOSITE_PORTS: CanvasNodePort[] = [
    { id: COMPOSITE_SEGMENTS_PORT_ID, label: "片段", direction: "input", dataType: "video", multiple: true, description: "连接多个视频节点作为片段，连线顺序即拼接顺序" },
    { id: COMPOSITE_MUSIC_PORT_ID, label: "音乐", direction: "input", dataType: "audio", description: "可连接 1 个音频节点作为背景音乐" },
    { id: COMPOSITE_VIDEO_OUTPUT_PORT_ID, label: "视频", direction: "output", dataType: "video" },
];

const BUILTIN_DEFINITIONS: CanvasNodeDefinition[] = [
    { type: CanvasNodeType.Text, title: i18n.t("assets.kinds.text"), icon: <FileText className={iconClass} />, minimapColor: undefined, resource: builtinResource },
    { type: CanvasNodeType.Image, title: i18n.t("assets.kinds.image"), icon: <ImageIcon className={iconClass} />, minimapColor: "#10b981", keepAspectRatio: (node: CanvasNodeData) => !node.metadata?.freeResize, resource: builtinResource },
    { type: CanvasNodeType.Video, title: i18n.t("assets.kinds.video"), icon: <Video className={iconClass} />, minimapColor: "#f97316", keepAspectRatio: () => true, resource: builtinResource },
    { type: CanvasNodeType.Audio, title: i18n.t("assets.kinds.audio"), icon: <Music2 className={iconClass} />, minimapColor: "#a855f7", resource: builtinResource },
    { type: CanvasNodeType.Composite, title: i18n.t("canvas.nodeTypes.composite"), icon: <Clapperboard className={iconClass} />, minimapColor: "#14b8a6", ports: COMPOSITE_PORTS, description: "用 FFmpeg 拼接多个视频片段并可叠加背景音乐" },
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
