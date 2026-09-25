import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "@/types/canvas";

import { CanvasProjectCard } from "./canvas-project-card";
import { CanvasProjectPreview } from "./canvas-project-preview";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: "zh-CN" } }),
}));

// 卡片会拉进 @/i18n（模块顶层读 localStorage）与导出链路，读回测试只关心渲染产物，按需隔离。
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/canvas/canvas-export", () => ({ exportCanvasProjects: vi.fn() }));

const baseProject: CanvasProject = {
    id: "project-1",
    title: "测试画布",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "dots",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
};

describe("canvas project preview", () => {
    it("renders a stable empty-canvas preview without loading persisted media", () => {
        const html = renderToStaticMarkup(<CanvasProjectPreview project={baseProject} />);
        expect(html).toContain('data-canvas-project-preview="empty"');
        expect(html).not.toContain("<img");
    });

    it("renders project nodes and valid connections as a lightweight vector preview", () => {
        const project: CanvasProject = {
            ...baseProject,
            nodes: [
                { id: "text", type: CanvasNodeType.Text, title: "提示词", position: { x: 0, y: 0 }, width: 240, height: 120 },
                { id: "image", type: CanvasNodeType.Image, title: "图片", position: { x: 420, y: 80 }, width: 320, height: 240 },
            ],
            connections: [{ id: "connection", fromNodeId: "text", toNodeId: "image" }],
        };
        const html = renderToStaticMarkup(<CanvasProjectPreview project={project} />);

        expect(html).toContain('data-canvas-project-preview="nodes"');
        expect(html).toContain('data-preview-node-type="text"');
        expect(html).toContain('data-preview-node-type="image"');
        expect(html).toContain("<path");
        expect(html).not.toContain("<img");
    });
});

describe("canvas project card actions", () => {
    const renderCard = () =>
        renderToStaticMarkup(
            <MemoryRouter>
                <CanvasProjectCard project={baseProject} />
            </MemoryRouter>,
        );
    /** 取出某个操作按钮自己的标签，用于断言它的类名而不是整页文本。 */
    const actionButton = (html: string, action: string) => html.match(new RegExp(`<button[^>]*data-canvas-project-action="${action}"[^>]*>`))?.[0] ?? "";
    /** 取出操作条容器自身的 class，用于证明它不靠悬停才出现。 */
    const actionBar = (html: string) => html.match(/<div class="[^"]*td-home-project-actions[^"]*"/)?.[0] ?? "";

    it("默认状态（未悬停、未聚焦）就渲染出下载 / 重命名 / 删除三个按钮，并各带 Tooltip 文案", () => {
        const html = renderCard();

        expect([...html.matchAll(/data-canvas-project-action="(\w+)"/g)].map((match) => match[1])).toEqual(["export", "rename", "delete"]);
        expect(actionButton(html, "export")).toContain('aria-label="canvas.project.export"');
        expect(actionButton(html, "rename")).toContain('aria-label="canvas.project.rename"');
        expect(actionButton(html, "delete")).toContain('aria-label="canvas.project.delete"');
    });

    it("操作条自带深色磨砂底色，且没有 opacity-0 这类初始隐藏类", () => {
        const bar = actionBar(renderCard());

        expect(bar).toContain("bg-stone-950/75");
        expect(bar).toContain("border-white/15");
        expect(bar).toContain("backdrop-blur-xl");
        expect(bar).not.toContain("opacity-0");
        expect(bar).not.toContain("group-hover:opacity-100");
    });

    it("图标用近乎不透明的白色，删除单独走危险色，三个按钮都有 focus-visible 样式", () => {
        const html = renderCard();
        const download = actionButton(html, "export");
        const rename = actionButton(html, "rename");
        const remove = actionButton(html, "delete");

        for (const button of [download, rename, remove]) {
            expect(button).toContain("focus-visible:ring-2");
            expect(button).toContain("focus-visible:ring-[#a59eff]");
            expect(button).not.toContain("opacity-0");
        }
        expect(download).toContain("text-white/85");
        expect(rename).toContain("text-white/85");
        expect(remove).toContain("text-red-300");
        expect(remove).toContain("hover:bg-red-500/25");
        expect(remove).toContain("hover:text-red-200");
    });

    it("左下角序号徽标自带底色，不再把白字直接压在封面上", () => {
        const badge = renderCard().match(/<span class="[^"]*">01<\/span>/)?.[0] ?? "";

        expect(badge).toContain("bg-stone-950/70");
        expect(badge).toContain("text-white/90");
    });
});
