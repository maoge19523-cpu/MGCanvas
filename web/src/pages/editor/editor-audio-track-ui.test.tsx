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

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-audio-track-markup");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

/** 视频 4s + 5s = 成片 9 秒；音轨一条 20 秒（比成片长，应被裁到全片），一条时长未探测到。 */
const DEMO: EditProject = {
    id: "edit-audio",
    name: "音画对齐",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "m1", name: "开场.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m2", name: "画布成片.mp4", kind: "video", source: "canvas", url: "asset://localhost/x.mp4", durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m3", name: "背景乐.mp3", kind: "audio", source: "local", url: "blob:m3", durationMs: 20000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m4", name: "对白.wav", kind: "audio", source: "local", url: "blob:m4", createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "m1", start: 1, end: 5, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
    ],
    audioTracks: [
        { id: "t1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
        { id: "t2", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
    ],
    output: { ...EDIT_DEFAULT_OUTPUT },
};

function render(project: EditProject, name: string) {
    useEditStore.setState({ hydrated: true, projects: [project], history: {} });
    useAssetStore.setState({ assets: [], hydrated: true });
    return dump(
        name,
        renderToStaticMarkup(
            <MemoryRouter initialEntries={[`/editor/${project.id}`]}>
                <App>
                    <Routes>
                        <Route path="/editor/:id" element={<EditProjectPage />} />
                    </Routes>
                </App>
            </MemoryRouter>,
        ),
    );
}

describe("剪辑台时间线：音轨行与波形画布真的渲染出来了", () => {
    it("时间线下方有独立的音轨行容器，每条音轨一个 canvas（不是 DOM 逐点堆出来的）", () => {
        const markup = render(DEMO, "editor-audio-track");

        expect(markup).toContain("data-edit-audio-track");
        // 每条音轨一个画布容器 + 一个 canvas。
        expect(markup).toContain('data-edit-waveform-strip="t1"');
        expect(markup).toContain('data-edit-waveform-strip="t2"');
        expect(markup).toContain('data-edit-waveform="t1"');
        expect(markup).toContain('data-edit-waveform="t2"');
        expect((markup.match(/<canvas/g) || []).length).toBe(2);
        // 波形绝不是用一堆 DOM 元素画出来的：整份产物里没有逐点元素。
        expect(markup).not.toContain("data-edit-waveform-point");
    });

    it("波形条宽度按「音轨秒数 / 成片秒数」的百分比铺开，与标尺、播放头同一套时间轴", () => {
        const markup = render(DEMO, "editor-audio-track-width");

        // 成片 9 秒；20 秒的音轨被裁到全片 → 100%。
        const t1 = markup.slice(markup.indexOf('data-edit-waveform-strip="t1"'), markup.indexOf('data-edit-waveform-strip="t1"') + 400);
        expect(t1).toContain("width:100%");
        // 时长未探测到的音轨宽度是 0%（没有时间轴位置可放），但容器与降级提示依然渲染出来。
        const t2 = markup.slice(markup.indexOf('data-edit-waveform-strip="t2"'), markup.indexOf('data-edit-waveform-strip="t2"') + 400);
        expect(t2).toContain("width:0%");
    });

    it("时长未探测到的音频与既有口径一致：给一行提示，不把界面弄坏", () => {
        const markup = render(DEMO, "editor-audio-track-degraded");

        expect(markup).toContain("data-edit-waveform-hint");
        expect(markup).toContain("时长未探测到，暂不能进入时间线");
        // 拿得到时长的音轨在静态产物里是「波形生成中…」，说明确实走了取峰值的路径。
        expect(markup).toContain("波形生成中…");
    });

    it("没有音轨时这一行仍然占位，并给出加入音轨的提示", () => {
        const markup = render({ ...DEMO, audioTracks: [] }, "editor-audio-track-empty");

        expect(markup).toContain("data-edit-audio-track");
        expect(markup).toContain("还没有音轨：在左侧音频素材上点「加入音轨」即可作为背景音或配音混进成片。");
        expect((markup.match(/<canvas/g) || []).length).toBe(0);
    });

    it("原有的四区结构与视频片段条没被破坏", () => {
        const markup = render(DEMO, "editor-audio-track-structure");

        for (const area of ["media", "preview", "timeline", "inspector"]) expect(markup).toContain(`data-edit-area="${area}"`);
        expect(markup).toContain("片段 1 · 4.0s · 开场.mp4");
        expect(markup).toContain("片段 2 · 5.0s · 画布成片.mp4");
        expect(markup).toContain("data-edit-playhead");
    });
});
