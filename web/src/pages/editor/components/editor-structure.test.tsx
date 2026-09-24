import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReactElement } from "react";

import zhCN from "@/i18n/locales/zh-CN";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildCompositePreviewClips, resolveCompositeSources } from "@/lib/canvas/composite-editing";

import { EditorInspector } from "./editor-inspector";
import { EditorMaterialList } from "./editor-material-list";
import { EditorPreview } from "./editor-preview";
import { EditorTimeline } from "./editor-timeline";
import { useCompositePreview } from "../use-composite-preview";

const noop = () => undefined;

const i18n = createInstance();
beforeAll(async () => {
    await i18n.init({ resources: { "zh-CN": { translation: zhCN } }, lng: "zh-CN", fallbackLng: "zh-CN", interpolation: { escapeValue: false }, react: { useSuspense: false } });
});

/** 用真实的中文资源渲染，断言读到的是界面上真正会出现的文案，而不是 i18n 键名。 */
function markup(element: ReactElement) {
    return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

function videoNode(id: string, seconds: number): CanvasNodeData {
    return { id, type: CanvasNodeType.Video, title: `素材${id}`, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: `blob:${id}`, durationMs: seconds * 1000, status: "success" } };
}

function audioNode(id: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Audio, title: `音频${id}`, position: { x: 0, y: 0 }, width: 320, height: 120, metadata: { content: `blob:${id}`, status: "success" } };
}

const composite: CanvasNodeData = { id: "composite-1", type: CanvasNodeType.Composite, title: "合成", position: { x: 0, y: 0 }, width: 420, height: 240, metadata: { compositeSettings: { fps: 30, longEdge: 1080 } } };
const nodes = [videoNode("a", 4), videoNode("b", 3), audioNode("v")];
const connections = [
    { id: "c1", fromNodeId: "a", toNodeId: "composite-1", toPortId: "segments" },
    { id: "c2", fromNodeId: "b", toNodeId: "composite-1", toPortId: "segments" },
    { id: "c3", fromNodeId: "v", toNodeId: "composite-1", toPortId: "voice" },
];
const sources = resolveCompositeSources(nodes, connections, "composite-1");
const clips = buildCompositePreviewClips(sources.segments, composite.metadata!.compositeSettings!);

/** 用真实的预览引擎渲染时间线：播放头/读数只写 DOM，静态渲染里也应有完整骨架。 */
function Timeline() {
    const preview = useCompositePreview(clips, clips.reduce((sum, clip) => sum + clip.length, 0));
    return <EditorTimeline preview={preview} clips={clips} settings={composite.metadata!.compositeSettings!} totalSeconds={7} selectedClipId="a" disabled={false} onSelectClip={noop} onReorder={noop} onTrim={noop} />;
}

function Preview({ hasClips }: { hasClips: boolean }) {
    const preview = useCompositePreview(clips, 7);
    return <EditorPreview preview={preview} totalSeconds={7} hasClips={hasClips} />;
}

describe("剪辑台：素材区", () => {
    it("列出视频与音频节点，并提供加入时间线 / 配音 / 音乐入口，已加入的有区分", () => {
        const html = markup(
            <EditorMaterialList videoNodes={[videoNode("a", 4), videoNode("c", 2)]} audioNodes={[audioNode("v")]} segmentNodeIds={new Set(["a"])} voiceNodeId="v" musicNodeId="" disabled={false} onAddSegment={noop} onRemoveSegment={noop} onSetTrack={noop} />,
        );

        expect(html).toContain("素材");
        expect(html).toContain("视频 · 加入时间线");
        expect(html).toContain("音频 · 配音 / 音乐");
        expect(html).toContain("素材a");
        expect(html).toContain("已在时间线");
        expect(html).toContain("移出时间线");
        // 未加入的那一条才有「加入时间线」按钮。
        expect(html).toContain("加入时间线");
        expect(html).toContain("配音轨");
        expect(html).toContain("设为音乐");
    });

    it("画布上没有可用的视频/音频节点时给出引导", () => {
        const html = markup(<EditorMaterialList videoNodes={[]} audioNodes={[]} segmentNodeIds={new Set()} voiceNodeId="" musicNodeId="" disabled={false} onAddSegment={noop} onRemoveSegment={noop} onSetTrack={noop} />);
        expect(html).toContain("当前画布没有可用的视频或音频节点");
        expect(html).toContain("先在画布上添加或生成视频、音频节点");
    });
});

describe("剪辑台：预览区", () => {
    it("渲染可见的预览播放器、播放按钮与「以导出为准」提示", () => {
        const html = markup(<Preview hasClips />);

        expect(html).toContain("data-editor-preview");
        expect(html).toContain('aria-label="播放"');
        expect(html).toContain("预览用于对时，成片效果以导出为准");
        expect(html).toContain("0:07.0");
    });

    it("没有片段时不渲染播放器，改为「合成节点还没有片段」+ 引导去左侧素材区", () => {
        const html = markup(<Preview hasClips={false} />);
        expect(html).not.toContain("data-editor-preview");
        expect(html).toContain("合成节点还没有片段");
        expect(html).toContain("从左侧素材区把视频节点");
    });
});

describe("剪辑台：时间线", () => {
    it("按真实时长铺开片段条，带转场标记、裁剪手柄与可定位的标尺和播放头", () => {
        const html = markup(<Timeline />);

        // 7s 总时长走 1s 一档刻度，标尺上出现 0～6。
        for (const tick of ["0", "1", "2", "3", "4", "5", "6"]) expect(html).toContain(`>${tick}</span>`);
        expect(html).toContain("data-editor-playhead");
        expect(html).toContain("片段 1 · 4.0秒");
        expect(html).toContain("片段 2 · 3.0秒");
        expect(html).toContain('title="拖动裁剪入点"');
        expect(html).toContain('title="拖动裁剪出点"');
        expect(html).toContain("总时长 7.0秒");
        expect(html).toContain("松手才写入画布");
        // 两条片段 + 2 个手柄 + 1 个间隔标记。
        expect(html.match(/data-clip-bar=/g)?.length).toBe(2);
    });
});

describe("剪辑台：属性区", () => {
    it("选中片段后可编辑入出点/音量/淡入淡出/转场与时长/字幕，并有输出参数", () => {
        const html = markup(
            <EditorInspector
                clip={clips[0]!}
                clipIndex={0}
                settings={{ ...composite.metadata!.compositeSettings!, segments: { a: { start: 1, end: 3, transition: "fade", subtitle: "台词" } } }}
                voice={nodes[2]!}
                music={null}
                disabled={false}
                onUpdateSegment={noop}
                onUpdateSettings={noop}
            />,
        );

        expect(html).toContain("属性");
        expect(html).toContain("片段 1");
        expect(html).toContain("入点");
        expect(html).toContain("出点");
        expect(html).toContain("音量");
        expect(html).toContain("淡入");
        expect(html).toContain("淡出");
        expect(html).toContain("转场");
        expect(html).toContain("交叉溶解");
        expect(html).toContain("台词");
        expect(html).toContain("输出参数");
        expect(html).toContain("1080P");
        expect(html).toContain("30fps");
        expect(html).toContain("配音");
    });

    it("没选片段时给出引导文案", () => {
        const html = markup(<EditorInspector clip={null} clipIndex={-1} settings={{}} voice={null} music={null} disabled={false} onUpdateSegment={noop} onUpdateSettings={noop} />);
        expect(html).toContain("在时间线上点一个片段");
    });
});
