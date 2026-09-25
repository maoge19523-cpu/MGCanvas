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

import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";
import { editAudioPreviewPlan } from "@/lib/edit/audio-preview";
import { useAssetStore } from "@/stores/use-asset-store";
import { useEditStore } from "@/stores/use-edit-store";
import { EDIT_DEFAULT_OUTPUT, type EditProject } from "@/types/edit";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-preview-audio-markup");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

/** 视频 4s + 5s = 成片 9 秒：音轨的起点、夹取与截断都以它为准。 */
const TOTAL = 9;

const DEMO: EditProject = {
    id: "edit-preview-audio",
    name: "预览混音",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "m1", name: "开场.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m2", name: "画布成片.mp4", kind: "video", source: "canvas", url: "asset://localhost/x.mp4", durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m3", name: "背景乐.mp3", kind: "audio", source: "local", url: "blob:m3", durationMs: 20000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m4", name: "对白.wav", kind: "audio", source: "local", url: "blob:m4", durationMs: 30000, createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "m1", start: 1, end: 5, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
    ],
    audioTracks: [
        { id: "t1", mediaId: "m3", volume: 0.6, fadeIn: 1, fadeOut: 2, loop: false, start: 1 },
        // 静音轨：预览里不该有它的元素。
        { id: "t2", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, muted: true },
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

/** 从产物里切出某个元素附近的一段：断言只针对这一段，不会误命中别处的同类字符串。 */
function around(markup: string, marker: string, length = 420) {
    const index = markup.indexOf(marker);
    expect(index, `产物里应该出现 ${marker}`).toBeGreaterThan(-1);
    return markup.slice(index, index + length);
}

/** 预览区那一块（音轨元素必须落在里面，而不是别的地方）。 */
function previewArea(markup: string) {
    const from = markup.indexOf('data-edit-area="preview"');
    const to = markup.indexOf('data-edit-area="timeline"');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return markup.slice(from, to);
}

describe("剪辑台预览：音轨的声音载体真的渲染出来了", () => {
    it("每条可听音轨一个隐藏的 <audio>，源与音量与纯函数给出的混音计划逐字一致", () => {
        const markup = render(DEMO, "editor-preview-audio-elements");
        const preview = previewArea(markup);
        // 期望值不手写：直接取纯函数算出来的那一份计划。
        const plan = editAudioPreviewPlan(DEMO.audioTracks, DEMO.media, {}, TOTAL);
        expect(plan.tracks.map((item) => item.id)).toEqual(["t1"]);

        const element = around(preview, 'data-edit-preview-audio="t1"');
        expect(element).toContain(`src="${plan.tracks[0]!.src}"`);
        expect(element).toContain(`data-edit-preview-audio-volume="${plan.tracks[0]!.volume}"`);
        expect(element).toContain(`data-edit-preview-audio-start="${plan.tracks[0]!.start}"`);
        expect(element).toContain('preload="auto"');
        // 隐藏：它只是声音的载体，绝不参与预览区的排版。
        expect(element).toContain("hidden");
        // 一次都不进画面：整份产物里只有这一个 <audio>。
        expect((markup.match(/<audio/g) || []).length).toBe(1);
    });

    it("静音轨 / 被独奏排除的轨没有元素，也没有「听不到」的提示（是设置，不是故障）", () => {
        const markup = render(DEMO, "editor-preview-audio-muted");

        expect(markup).not.toContain('data-edit-preview-audio="t2"');
        expect(markup).not.toContain("data-edit-preview-audio-hint");
    });

    it("独奏生效时只有被独奏的那条进预览（复用导出那一套判定，不另写规则）", () => {
        const soloed: EditProject = {
            ...DEMO,
            audioTracks: [
                { id: "t1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
                { id: "t2", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, solo: true },
            ],
        };
        const markup = render(soloed, "editor-preview-audio-solo");

        expect(markup).toContain('data-edit-preview-audio="t2"');
        expect(markup).not.toContain('data-edit-preview-audio="t1"');
        expect((markup.match(/<audio/g) || []).length).toBe(1);
    });

    it("没有音轨 / 音轨全部静音时不渲染任何元素，界面照旧", () => {
        const none = render({ ...DEMO, audioTracks: [] }, "editor-preview-audio-none");
        const allMuted = render({ ...DEMO, audioTracks: DEMO.audioTracks.map((track) => ({ ...track, muted: true })) }, "editor-preview-audio-all-muted");

        for (const markup of [none, allMuted]) {
            expect(markup).not.toContain("<audio");
            expect(markup).not.toContain("data-edit-preview-audio-hint");
            // 预览区与视频载体照旧在。
            expect(previewArea(markup)).toContain("data-edit-preview-video");
        }
    });

    it("loop 的音轨带 loop 属性（对应导出的 -stream_loop -1），非 loop 的不带", () => {
        const looped = render({ ...DEMO, audioTracks: [{ id: "t1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: true }] }, "editor-preview-audio-loop");
        const plain = render({ ...DEMO, audioTracks: [{ id: "t1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }] }, "editor-preview-audio-no-loop");

        expect(around(looped, 'data-edit-preview-audio="t1"')).toContain("loop");
        expect(around(plain, 'data-edit-preview-audio="t1"').includes(" loop")).toBe(false);
    });

    it("音量与起点都按导出的夹取范围落到元素上（400% 的音轨在预览里也按元素的 100% 上限出声）", () => {
        const loud = render({ ...DEMO, audioTracks: [{ id: "t1", mediaId: "m3", volume: 9, fadeIn: 0, fadeOut: 0, loop: false, start: 99 }] }, "editor-preview-audio-clamped");
        const plan = editAudioPreviewPlan([{ id: "t1", mediaId: "m3", volume: 9, fadeIn: 0, fadeOut: 0, loop: false, start: 99 }], DEMO.media, {}, TOTAL);

        expect(plan.tracks[0]!.volume).toBe(4);
        expect(plan.tracks[0]!.start).toBe(TOTAL);
        const element = around(loud, 'data-edit-preview-audio="t1"');
        expect(element).toContain('data-edit-preview-audio-volume="4"');
        expect(element).toContain(`data-edit-preview-audio-start="${TOTAL}"`);
    });

    it("音频素材被移除 / 素材不是音频时给一句能看懂的提示，画面照旧播", () => {
        const missing = render({ ...DEMO, audioTracks: [{ id: "t1", mediaId: "gone", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }] }, "editor-preview-audio-missing");
        const wrongKind = render({ ...DEMO, audioTracks: [{ id: "t1", mediaId: "m1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }] }, "editor-preview-audio-wrong-kind");

        expect(around(missing, "data-edit-preview-audio-hint", 200)).toContain("音频素材已被移除");
        expect(around(wrongKind, "data-edit-preview-audio-hint", 200)).toContain("开场.mp4");
        for (const markup of [missing, wrongKind]) {
            expect(previewArea(markup)).toContain("data-edit-preview-video");
            expect((markup.match(/<audio/g) || []).length).toBe(0);
        }
    });

    it("原有的预览与时间线结构没被破坏", () => {
        const markup = render(DEMO, "editor-preview-audio-structure");

        for (const area of ["media", "preview", "timeline", "inspector"]) expect(markup).toContain(`data-edit-area="${area}"`);
        expect(previewArea(markup)).toContain("data-edit-preview-video");
        // 音轨行（波形 / 轨道头）与片段条照旧。
        expect(markup).toContain('data-edit-waveform-strip="t1"');
        expect(markup).toContain('data-edit-track-mute="t1"');
        expect(markup).toContain('data-edit-clip="c1"');
    });
});

describe("剪辑台预览：文案与「预览包含什么」一致", () => {
    it("界面上的短提示不再是「预览仅用于对时」，而是说明已经含音轨混音", () => {
        const markup = render(DEMO, "editor-preview-audio-copy");

        expect(markup).toContain(zhCN.editor.previewHint);
        expect(markup).not.toContain("预览仅用于对时");
        expect(zhCN.editor.previewHint).toContain("音轨");
    });

    it("详情文案逐项说清包含与仍不含的东西，并如实写明音量上限这处差异", () => {
        const zh = zhCN.editor.previewHintDetail;
        const en = enUS.editor.previewHintDetail;

        // 包含：音轨混音（起点 / 音量 / 淡入淡出 / 循环 / 静音独奏）与片段原声。
        for (const token of ["音轨", "音量", "淡入淡出", "循环", "原声"]) expect(zh).toContain(token);
        for (const token of ["audio tracks", "volume", "fades", "looping", "mute / solo"]) expect(en).toContain(token);
        // 如实写明的差异：浏览器元素音量上限 100%，超过 100% 的部分只在成片里生效；
        // 多路叠加不做限幅（与导出一致，这一条两边都一样）。
        for (const text of [zh, en]) {
            expect(text).toContain("100%");
            expect(text).toContain("FFmpeg");
        }
        // 仍不含：转场、字幕烧字、成片整体淡入淡出与输出画幅缩放。
        for (const token of ["转场", "字幕", "导出"]) expect(zh).toContain(token);
        for (const token of ["transitions", "subtitles", "export"]) expect(en).toContain(token);
        // 旧文案里「不含多轨混音」这句已经不成立，必须消失。
        expect(zh).not.toContain("多轨混音");
        expect(en).not.toContain("multi-track mixing");
        expect(en).not.toContain("timing only");
    });

    it("中英两份文案成对存在：新增的音轨提示两边都有", () => {
        for (const text of [zhCN.editor.previewAudioMissing, zhCN.editor.previewAudioFailed, zhCN.editor.previewAudioBlocked]) expect(text.length).toBeGreaterThan(0);
        for (const text of [enUS.editor.previewAudioMissing, enUS.editor.previewAudioFailed, enUS.editor.previewAudioBlocked]) expect(text.length).toBeGreaterThan(0);
    });
});
