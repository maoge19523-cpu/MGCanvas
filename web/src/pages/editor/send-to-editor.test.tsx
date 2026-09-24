import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { describe, expect, it, vi } from "vitest";

// i18n 初始化会读 localStorage：node 环境没有它，必须在任何模块导入前补一个最小替身。
vi.hoisted(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, String(value)),
            removeItem: (key: string) => void store.delete(key),
            clear: () => store.clear(),
        },
    });
});

import { CanvasNodeHoverToolbar } from "@/components/canvas/canvas-node-hover-toolbar";
import { canvasNodeToEditMedia } from "@/services/edit-media";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { useEditStore } from "@/stores/use-edit-store";

const noop = () => undefined;

function videoNode(): CanvasNodeData {
    return {
        id: "video-1",
        type: CanvasNodeType.Video,
        title: "画布成片",
        position: { x: 20, y: 30 },
        width: 320,
        height: 180,
        metadata: { content: "asset://localhost/cache/out.mp4", localPath: "C:\\cache\\out.mp4", mimeType: "video/mp4", bytes: 2048, durationMs: 8400, naturalWidth: 1280, naturalHeight: 720, status: "success" },
    };
}

function audioNode(): CanvasNodeData {
    return { id: "audio-1", type: CanvasNodeType.Audio, title: "配音", position: { x: 0, y: 0 }, width: 260, height: 96, metadata: { content: "asset://localhost/cache/voice.mp3", localPath: "C:\\cache\\voice.mp3", mimeType: "audio/mpeg", durationMs: 3200, status: "success" } };
}

function imageNode(): CanvasNodeData {
    return { id: "image-1", type: CanvasNodeType.Image, title: "图", position: { x: 0, y: 0 }, width: 320, height: 320, metadata: { content: "asset://localhost/cache/a.png", status: "success" } };
}

function renderToolbar(node: CanvasNodeData) {
    return renderToStaticMarkup(
        <App>
            <CanvasNodeHoverToolbar
                node={node}
                viewport={{ x: 0, y: 0, k: 1 }}
                onKeep={noop}
                onLeave={noop}
                onInfo={noop}
                onEditText={noop}
                onDecreaseFont={noop}
                onIncreaseFont={noop}
                onToggleDialog={noop}
                onGenerateImage={noop}
                onUpload={noop}
                onMergeAudio={noop}
                onDownload={noop}
                onSaveAsset={noop}
                onSendToEditor={noop}
                onCrop={noop}
                onSplit={noop}
                onUpscale={noop}
                onAngle={noop}
                onViewImage={noop}
                onReversePrompt={noop}
                onRetry={noop}
                onToggleFreeResize={noop}
                canvasSetAvailable={false}
                onToggleCanvasSet={noop}
                onDelete={noop}
            />
        </App>,
    );
}

describe("画布「发送到剪辑台」入口", () => {
    it("视频节点与音频节点的工具条上都有这个入口", () => {
        for (const node of [videoNode(), audioNode()]) {
            const markup = renderToolbar(node);
            expect(markup).toContain('data-canvas-node-toolbar-action="sendEditor"');
            expect(markup).toContain("送剪辑");
            expect(markup).toContain("lucide-clapperboard");
        }
    });

    it("图片节点上没有这个入口", () => {
        expect(renderToolbar(imageNode())).not.toContain('data-canvas-node-toolbar-action="sendEditor"');
    });
});

describe("画布节点 → 剪辑台素材：只读复制，不改画布数据", () => {
    it("视频节点转成剪辑台素材时带上可解析路径、时长与尺寸", () => {
        const node = videoNode();
        expect(canvasNodeToEditMedia(node)).toEqual({
            name: "画布成片",
            kind: "video",
            source: "canvas",
            localPath: "C:\\cache\\out.mp4",
            storageKey: undefined,
            url: "asset://localhost/cache/out.mp4",
            mimeType: "video/mp4",
            bytes: 2048,
            durationMs: 8400,
            width: 1280,
            height: 720,
        });
        expect(canvasNodeToEditMedia(audioNode())?.kind).toBe("audio");
        expect(canvasNodeToEditMedia(imageNode())).toBeNull();
        // 没有内容的节点不发送。
        expect(canvasNodeToEditMedia({ ...videoNode(), metadata: {} })).toBeNull();
    });

    it("发送前后画布节点对象逐字未变", () => {
        const node = videoNode();
        const before = JSON.stringify(node);
        const media = canvasNodeToEditMedia(node);
        expect(media).not.toBeNull();
        expect(JSON.stringify(node)).toBe(before);
    });

    it("发送确实落进剪辑台项目：没有项目就新建，并把素材登记进去", () => {
        useEditStore.setState({ hydrated: true, projects: [] });
        const media = canvasNodeToEditMedia(videoNode())!;
        const targetId = useEditStore.getState().ensureProject("我的画布");
        useEditStore.getState().addMedia(targetId, media);

        const project = useEditStore.getState().projects.find((item) => item.id === targetId);
        expect(useEditStore.getState().projects.length).toBe(1);
        expect(project?.name).toBe("我的画布");
        expect(project?.media.map((item) => [item.name, item.kind, item.source])).toEqual([["画布成片", "video", "canvas"]]);
        // 再发一次仍然进同一个项目，不会每次都新建。
        expect(useEditStore.getState().ensureProject("我的画布")).toBe(targetId);
    });
});
