import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

import { EDIT_DEFAULT_OUTPUT, type EditProject } from "@/types/edit";
import { useEditStore } from "@/stores/use-edit-store";
import { useAssetStore } from "@/stores/use-asset-store";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-timeline-markup");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

const DEMO: EditProject = {
    id: "edit-1",
    name: "预告片剪辑",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "m1", name: "开场.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m2", name: "画布成片.mp4", kind: "video", source: "canvas", url: "asset://localhost/x.mp4", durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "m1", start: 1, end: 5, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
    ],
    audioTracks: [],
    output: { ...EDIT_DEFAULT_OUTPUT },
};

function render() {
    useEditStore.setState({ hydrated: true, projects: [DEMO], history: {} });
    useAssetStore.setState({ assets: [], hydrated: true });
    return dump(
        "editor-timeline-ui",
        renderToStaticMarkup(
            <MemoryRouter initialEntries={["/editor/edit-1"]}>
                <App>
                    <Routes>
                        <Route path="/editor/:id" element={<EditProjectPage />} />
                    </Routes>
                </App>
            </MemoryRouter>,
        ),
    );
}

describe("剪辑台时间线：新增交互元素真的渲染出来了", () => {
    it("吸附导引线容器与播放头同时存在，导引线默认隐藏（只由拖动过程直写 DOM）", () => {
        const markup = render();

        expect(markup).toContain("data-edit-snap-guide");
        expect(markup).toContain("data-edit-playhead");
        // 导引线初始不给位置，靠 paintGuide 写 style.left / opacity。
        const guide = markup.slice(markup.indexOf("data-edit-snap-guide") - 260, markup.indexOf("data-edit-snap-guide") + 120);
        expect(guide).toContain("opacity:0");
    });

    it("撤销 / 重做按钮带禁用态与中文无障碍标签", () => {
        const markup = render();

        expect(markup).toContain("data-edit-history");
        expect(markup).toContain('aria-label="撤销"');
        expect(markup).toContain('aria-label="重做"');
        // 新建的项目还没有任何编辑记录，两个按钮都必须是禁用态。
        expect(markup).toContain('disabled=""');
    });

    it("吸附开关按钮默认开启，并带 aria-pressed 状态", () => {
        const markup = render();

        expect(markup).toContain('aria-label="吸附开关"');
        expect(markup).toContain('aria-pressed="true"');
        expect(markup).toContain("lucide-magnet");
    });

    it("时间线角落常驻展示快捷键，并且有打开完整键位表的入口", () => {
        const markup = render();

        expect(markup).toContain("data-edit-shortcut-hint");
        // 常驻提示上的按键与它们的用途（title 里写着中文说明）。
        for (const display of ["Space", "S", "Del", "Shift + Del", "Ctrl + Z", "N"]) expect(markup).toContain(`>${display}</kbd>`);
        expect(markup).toContain("播放 / 暂停");
        expect(markup).toContain("涟漪删除（前移后续片段）");
        expect(markup).toContain("在播放头拆分片段");
        // 完整键位表的入口（antd Popover 内容按需渲染，这里先确认入口按钮）。
        expect(markup).toContain('aria-label="剪辑台快捷键"');
        expect(markup).toContain("快捷键");
    });

    it("时间线提示与四区结构没有被破坏", () => {
        const markup = render();

        for (const area of ["media", "preview", "timeline", "inspector"]) expect(markup).toContain(`data-edit-area="${area}"`);
        expect(markup).toContain("拖动片段换序，拖两端裁剪入点 / 出点，松手才生效");
        expect(markup).toContain("片段 1 · 4.0s · 开场.mp4");
        expect(markup).toContain("片段 2 · 5.0s · 画布成片.mp4");
    });

    it("预览区的取帧载体（<video>）真的渲染出来了，且带着暂停态取帧需要的 preload", () => {
        const markup = render();

        expect(markup).toContain("data-edit-preview-video");
        // 暂停态要显示画面就必须拿到首帧数据：preload="metadata" 只取元数据，暂停时画不出这一帧。
        expect(markup).toContain('preload="auto"');
        expect(markup).toContain("playsInline");
        // 画面的 src 与 currentTime 只由取帧路径直写 DOM，静态产物里不应有 src 属性。
        const video = markup.slice(markup.indexOf("data-edit-preview-video") - 120, markup.indexOf("data-edit-preview-video") + 160);
        expect(video).not.toContain("src=");
    });
});
