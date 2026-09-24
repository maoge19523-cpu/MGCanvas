import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

// @/i18n 在模块初始化时读 localStorage，node 测试环境没有它；界面文案由下面的真实 zh-CN 资源提供。
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));

import zhCN from "@/i18n/locales/zh-CN";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

import { CanvasNode } from "./canvas-node";

const i18n = createInstance();
beforeAll(async () => {
    registerBuiltinNodes();
    await i18n.init({ resources: { "zh-CN": { translation: zhCN } }, lng: "zh-CN", fallbackLng: "zh-CN", interpolation: { escapeValue: false }, react: { useSuspense: false } });
});

const noop = () => undefined;

const composite: CanvasNodeData = { id: "composite-1", type: CanvasNodeType.Composite, title: "合成", position: { x: 0, y: 0 }, width: 420, height: 240, metadata: { compositeSettings: {} } };

function renderNode(onOpenEditor?: (node: CanvasNodeData) => void) {
    const html = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
            <CanvasNode
                data={composite}
                scale={1}
                isSelected={false}
                isRelated={false}
                isFocusRelated={false}
                isConnectionTarget={false}
                isConnecting={false}
                showPanel={false}
                showImageInfo={false}
                onMouseDown={noop}
                onHoverStart={noop}
                onHoverEnd={noop}
                onConnectStart={noop}
                onResizeStart={noop}
                onResize={noop}
                onResizeEnd={noop}
                onContentChange={noop}
                onTitleChange={noop}
                onOpenEditor={onOpenEditor}
                onContextMenu={noop}
            />
        </I18nextProvider>,
    );
    return html;
}

describe("画布合成节点：入口改为「在剪辑台打开」", () => {
    it("节点上不再弹出合成面板，而是显示跳转剪辑台的入口", () => {
        const html = renderNode(noop);

        expect(html).toContain("在剪辑台打开");
        expect(html).toContain("在剪辑台里拼接、裁剪与试听");
        // 合成节点已标记 hidePanel：不再有任何浮动面板容器渲染出来。
        expect(html).not.toContain("开始合成");
    });

    it("没有传入口回调时不渲染按钮（不影响其它宿主渲染合成节点）", () => {
        expect(renderNode(undefined)).not.toContain("在剪辑台打开");
    });
});
