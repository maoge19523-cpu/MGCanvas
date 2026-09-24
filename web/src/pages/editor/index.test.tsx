import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createInstance } from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 页面链路上会间接导入 @/i18n（它在模块初始化时读 localStorage），node 测试环境没有 localStorage，
// 这里按仓库里既有测试的做法把它换成桩；界面文案由下面的真实 zh-CN 资源提供。
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import zhCN from "@/i18n/locales/zh-CN";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

import EditorPage from "./index";

const i18n = createInstance();
beforeAll(async () => {
    await i18n.init({ resources: { "zh-CN": { translation: zhCN } }, lng: "zh-CN", fallbackLng: "zh-CN", interpolation: { escapeValue: false }, react: { useSuspense: false } });
});

function videoNode(id: string, seconds: number): CanvasNodeData {
    return { id, type: CanvasNodeType.Video, title: `素材${id}`, position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { content: `blob:${id}`, durationMs: seconds * 1000, status: "success" } };
}

function project(nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasProject {
    return { id: "p1", title: "测试画布", createdAt: "", updatedAt: "", nodes, connections, chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
}

const composite: CanvasNodeData = { id: "composite-1", type: CanvasNodeType.Composite, title: "合成", position: { x: 0, y: 0 }, width: 420, height: 240, metadata: { compositeSettings: { fps: 30, longEdge: 1080 } } };

function renderEditor(projects: CanvasProject[], path = "/editor/p1") {
    useCanvasStore.setState({ hydrated: true, projects });
    return renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/editor/:id" element={<EditorPage />} />
                    <Route path="/editor" element={<EditorPage />} />
                </Routes>
            </MemoryRouter>
        </I18nextProvider>,
    );
}

beforeEach(() => {
    useCanvasStore.setState({ hydrated: false, projects: [] });
});

describe("剪辑台页面：空状态", () => {
    it("未打开画布时引导去我的画布", () => {
        const html = renderEditor([], "/editor");
        expect(html).toContain("还没有打开画布");
        expect(html).toContain("请先在「我的画布」里打开一个画布项目，再回到剪辑台。");
        expect(html).toContain("去我的画布");
    });

    it("画布上没有合成节点时引导回画布创建", () => {
        const html = renderEditor([project([videoNode("a", 4)], [])]);
        expect(html).toContain("当前画布还没有合成节点");
        expect(html).toContain("再把视频节点连到它的「片段」端口");
        expect(html).toContain("回到画布");
    });

    it("合成节点没有片段时引导从左侧素材区加入", () => {
        const html = renderEditor([project([composite, videoNode("a", 4)], [])]);
        expect(html).toContain("从左侧素材区把视频节点");
        expect(html).toContain("加入时间线");
    });

    it("画布没有任何可用视频/音频节点时给出引导", () => {
        const html = renderEditor([project([composite], [])]);
        expect(html).toContain("当前画布没有可用的视频或音频节点");
    });
});

describe("剪辑台页面：四区结构", () => {
    it("有片段时四区都在，导出按钮与预览提示都可读回", () => {
        const connections: CanvasConnection[] = [{ id: "c1", fromNodeId: "a", toNodeId: "composite-1", toPortId: "segments" }];
        const html = renderEditor([project([composite, videoNode("a", 4)], connections)]);

        // 素材区 / 预览区 / 属性区 / 时间线
        expect(html).toContain("素材");
        expect(html).toContain("属性");
        expect(html).toContain("时间线");
        expect(html).toContain("data-editor-preview");
        expect(html).toContain("data-editor-playhead");
        expect(html).toContain("data-clip-bar");
        // 预览诚实提示 + 导出按钮
        expect(html).toContain("预览用于对时，成片效果以导出为准");
        expect(html).toContain("导出成片");
        // 片段顺序 = 连线顺序：唯一一段显示为「片段 1」
        expect(html).toContain("片段 1 · 4.0秒");
    });
});
