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
import { EditInspector } from "./components/edit-inspector";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-track-controls-markup");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

/** t1 正常；t2 静音；t3 独奏；t4 被 t3 的独奏排除并锁定。 */
const DEMO: EditProject = {
    id: "edit-controls",
    name: "轨道控制",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "v1", name: "开场.mp4", kind: "video", source: "local", url: "blob:v1", durationMs: 8000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "a1", name: "背景乐.mp3", kind: "audio", source: "local", url: "blob:a1", durationMs: 8000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "a2", name: "对白.wav", kind: "audio", source: "local", url: "blob:a2", durationMs: 8000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "a3", name: "音效.wav", kind: "audio", source: "local", url: "blob:a3", durationMs: 8000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "a4", name: "环境音.wav", kind: "audio", source: "local", url: "blob:a4", durationMs: 8000, createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "v1", start: 0, end: 8, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "v1", start: 0, end: 4, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5, locked: true },
    ],
    audioTracks: [
        { id: "t1", mediaId: "a1", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
        { id: "t2", mediaId: "a2", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, muted: true },
        { id: "t3", mediaId: "a3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, solo: true },
        { id: "t4", mediaId: "a4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, locked: true },
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

/** 取出带某个属性的那一个真实标签（`<button ...>`），属性只可能出现在标签内部。 */
function tagOf(markup: string, marker: string) {
    const at = markup.indexOf(marker);
    expect(at, `产物里找不到 ${marker}`).toBeGreaterThan(-1);
    return markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at));
}

/** 激活态与未激活态各用一套类名，这里断言的是产物里真正出现的那个。 */
const TOGGLE_ON = "bg-black/[0.09]";
const TOGGLE_OFF = "bg-transparent";

describe("剪辑台轨道头：静音 / 独奏 / 锁定三个开关的产物读回", () => {
    it("每条音轨都渲染出三个开关，加上底部的「添加音轨」一共 13 个按钮", () => {
        const markup = render(DEMO, "editor-track-controls-buttons");

        for (const id of ["t1", "t2", "t3", "t4"]) {
            expect(markup).toContain(`data-edit-track-head="${id}"`);
            expect(markup).toContain(`data-edit-track-mute="${id}"`);
            expect(markup).toContain(`data-edit-track-solo="${id}"`);
            expect(markup).toContain(`data-edit-track-lock="${id}"`);
        }
        // 四条轨 × 3 个开关 + 1 个「添加音轨」。
        expect((markup.match(/data-edit-track-mute=/g) || []).length).toBe(4);
        expect((markup.match(/data-edit-track-solo=/g) || []).length).toBe(4);
        expect((markup.match(/data-edit-track-lock=/g) || []).length).toBe(4);
        expect(markup).toContain("data-edit-track-add");
        expect(markup).toContain("添加音轨");
    });

    it("每个开关都有 Tooltip 文案（title）与 aria-label，且都是可聚焦的真按钮", () => {
        const markup = render(DEMO, "editor-track-controls-a11y");
        // 未静音的轨显示「静音」动作，已静音的轨显示「取消静音」。
        const cases: Array<[string, string, string]> = [
            ["data-edit-track-mute=\"t1\"", "静音", "静音这条音轨"],
            ["data-edit-track-mute=\"t2\"", "取消静音", "静音这条音轨"],
            ["data-edit-track-solo=\"t1\"", "独奏", "独奏这条音轨"],
            ["data-edit-track-solo=\"t3\"", "取消独奏", "独奏这条音轨"],
            ["data-edit-track-lock=\"t1\"", "锁定", "锁定这条轨"],
            ["data-edit-track-lock=\"t4\"", "解锁", "锁定这条轨"],
        ];
        for (const [marker, label, hint] of cases) {
            const tag = tagOf(markup, marker);
            expect(tag.startsWith("<button"), `${marker} 不是真按钮：${tag}`).toBe(true);
            expect(tag).toContain(`aria-label="${label}"`);
            // antd Tooltip 只在悬停时才有可见内容，产物里能核对的 Tooltip 属性就是同一个 title 文案。
            expect(tag).toContain(`title="${hint}`);
            expect(tag).toContain("aria-pressed=");
        }
        // 「添加音轨」入口同样带 Tooltip 文案与 aria-label。
        const add = tagOf(markup, "data-edit-track-add");
        expect(add).toContain('aria-label="添加音轨"');
        expect(add).toContain('title="从已导入的音频素材里选一条加入音轨"');
    });

    it("激活态类名只在开关打开时出现：静音 / 独奏 / 锁定的三种打开状态各自独立", () => {
        const markup = render(DEMO, "editor-track-controls-active");

        // t2 静音打开，t1 没开。
        expect(tagOf(markup, 'data-edit-track-mute="t2"')).toContain(TOGGLE_ON);
        expect(tagOf(markup, 'data-edit-track-mute="t1"')).toContain(TOGGLE_OFF);
        // t3 独奏打开，t2 没开。
        expect(tagOf(markup, 'data-edit-track-solo="t3"')).toContain(TOGGLE_ON);
        expect(tagOf(markup, 'data-edit-track-solo="t2"')).toContain(TOGGLE_OFF);
        // t4 锁定打开，t1 没开。
        expect(tagOf(markup, 'data-edit-track-lock="t4"')).toContain(TOGGLE_ON);
        expect(tagOf(markup, 'data-edit-track-lock="t1"')).toContain(TOGGLE_OFF);

        // aria-pressed 与视觉激活态一致，读屏与键盘用户拿到的是同一个状态。
        expect(tagOf(markup, 'data-edit-track-mute="t2"')).toContain('aria-pressed="true"');
        expect(tagOf(markup, 'data-edit-track-mute="t1"')).toContain('aria-pressed="false"');
    });

    it("被排除的音轨在波形行上明确标出来：静音写静音，被别的轨独奏排除写排除", () => {
        const markup = render(DEMO, "editor-track-controls-excluded");

        expect(markup).toContain('data-edit-track-audible="true"');
        expect((markup.match(/data-edit-track-audible="false"/g) || []).length).toBe(3);
        // t2 自己静音。
        expect(markup).toContain('data-edit-track-excluded="t2"');
        // t1 与 t4 是被 t3 的独奏排除的。
        expect(markup).toContain('data-edit-track-excluded="t1"');
        expect(markup).toContain('data-edit-track-excluded="t4"');
        expect(markup).toContain("被其它轨独奏排除");
        // 真正出声的 t3（独奏的那条）不该有排除标记。
        expect(markup).not.toContain('data-edit-track-excluded="t3"');
        expect(markup).toContain('data-edit-track-audible="true"');
    });

    it("锁定不参与导出：锁定只影响编辑入口，导出按钮与音轨数量都不变", () => {
        const markup = render(DEMO, "editor-track-controls-locked");

        // 锁定的音轨在属性区带锁标记，参数控件被禁用（disabled），但删除与解锁入口仍在。
        expect(markup).toContain('data-edit-track-locked="t4"');
        expect(markup).not.toContain('data-edit-track-locked="t1"');
        expect(markup).toContain("导出成片");
        expect((markup.match(/data-edit-track-mute=/g) || []).length).toBe(4);
        // 锁定的视频片段在时间线上有独立标记，并换成 not-allowed 光标。
        expect(markup).toContain('data-edit-clip-locked="true"');
        expect(markup).toContain("cursor-not-allowed");
    });

    it("锁定轨的参数控件真的被禁用（不是只画了个锁图标）：未锁定轨仍然是可编辑的", () => {
        const markup = render(DEMO, "editor-track-controls-readonly");

        // 属性区里 t4 那一项的产物：音量 / 淡入 / 淡出 / 循环四个控件都在，且都带禁用态。
        const from = markup.indexOf('data-edit-track-locked="t4"');
        const lockedRow = markup.slice(from, markup.indexOf("</li>", from));
        expect(lockedRow).toContain("ant-input-number-disabled");
        expect(lockedRow).toContain("ant-switch-disabled");
        // 未锁定的 t1 那一项不该有禁用态。
        const firstRow = markup.slice(markup.indexOf("背景乐.mp3"), markup.indexOf("对白.wav"));
        expect(firstRow).not.toContain("ant-input-number-disabled");
    });

    it("锁定片段的属性区是只读的，且锁定按钮本身就是解锁入口（不会把自己锁死）", () => {
        useEditStore.setState({ hydrated: true, projects: [DEMO], history: {} });
        useAssetStore.setState({ assets: [], hydrated: true });
        const markup = dump(
            "editor-track-controls-clip-lock",
            renderToStaticMarkup(
                <App>
                    <EditInspector projectId={DEMO.id} clipId="c2" />
                </App>,
            ),
        );

        const lockButton = tagOf(markup, 'data-edit-clip-lock="c2"');
        expect(lockButton.startsWith("<button")).toBe(true);
        expect(lockButton).toContain('aria-pressed="true"');
        expect(lockButton).toContain('aria-label="解锁"');
        expect(lockButton).toContain('title="锁定这条轨');
        // 锁定片段的参数是只读的（入点 / 出点 / 音量 / 淡入淡出 / 转场 / 字幕全部禁用）。
        expect((markup.match(/disabled=""/g) || []).length).toBeGreaterThanOrEqual(6);
        expect(markup).toContain("ant-input-number-disabled");
        expect(markup).toContain("ant-select-disabled");
    });
});

/**
 * 视频轨的轨道头：视频片段的**自带原声**以前在时间线上没有任何开关（属性区也只有音量），
 * 用户报「加载的视频应该也带静音」，所以这条轨的轨道头只放一个真正生效的开关。
 * 同时守住另一半：**不渲染点了没反应的按钮**——独奏（单条视频轨没有语义）、可见性、锁定
 * 都不在这条轨道头上出现，宁可少一个也不要留一个假的。
 */
describe("剪辑台视频轨轨道头：只有一个真的能用的开关（关 / 开原声）", () => {
    const withMutedClips = (muted: boolean): EditProject => ({
        ...DEMO,
        clips: DEMO.clips.map((clip) => ({ ...clip, muted: muted ? true : undefined })),
    });

    it("视频轨渲染出轨道头与「关闭原声」开关，产物里带 data / aria 状态", () => {
        const markup = render(withMutedClips(false), "editor-track-controls-video-head");

        expect(markup).toContain("data-edit-video-track");
        expect(markup).toContain("data-edit-video-track-head");
        expect(markup).toContain("视频轨");
        const button = tagOf(markup, "data-edit-video-track-mute");
        expect(button.startsWith("<button")).toBe(true);
        expect(button).toContain('aria-label="关闭原声"');
        expect(button).toContain('aria-pressed="false"');
        expect(button).toContain('title="关闭整条视频轨的原声');
        expect(button).toContain(TOGGLE_OFF);
    });

    it("本轨片段全部关闭原声后开关是激活态，且时间线上的片段条被标出来", () => {
        const markup = render(withMutedClips(true), "editor-track-controls-video-muted");

        const button = tagOf(markup, "data-edit-video-track-mute");
        expect(button).toContain('aria-pressed="true"');
        expect(button).toContain('aria-label="开启原声"');
        expect(button).toContain(TOGGLE_ON);
        // 每个关闭原声的片段条都带标记，成片里听不到原声时能看出是设置。
        expect((markup.match(/data-edit-clip-muted="true"/g) || []).length).toBe(DEMO.clips.length);
    });

    it("只关闭其中一段时轨道头不算全关，被关的那一段单独带标记", () => {
        const half: EditProject = { ...DEMO, clips: [{ ...DEMO.clips[0]!, muted: true }, DEMO.clips[1]!] };
        const markup = render(half, "editor-track-controls-video-half");

        expect(tagOf(markup, "data-edit-video-track-mute")).toContain('aria-pressed="false"');
        expect((markup.match(/data-edit-clip-muted="true"/g) || []).length).toBe(1);
    });

    it("视频轨轨道头上没有点了没反应的按钮：不渲染独奏 / 可见性 / 锁定", () => {
        const markup = render(withMutedClips(false), "editor-track-controls-video-no-fakes");

        // 独奏在只有一条视频轨时没有任何语义，可见性（眼睛）与整轨锁定也都不是这条轨的能力，
        // 所以一个都不渲染——四类控件在产物里都查不到，杜绝「点了没反应」。
        expect(markup).not.toContain("data-edit-video-track-solo");
        expect(markup).not.toContain("data-edit-video-track-visible");
        expect(markup).not.toContain("data-edit-video-track-lock");
        // 视频轨轨道头只有这一个开关：从轨道头开始到片段行之前，整段里只有一个 <button>。
        const from = markup.indexOf("data-edit-video-track-head");
        const head = markup.slice(from, markup.indexOf('data-edit-clip="', from));
        expect((head.match(/<button/g) || []).length).toBe(1);
        // 音轨轨道头上的三个开关没有跟着变成四个（它们的语义仍然只属于音轨）。
        expect((markup.match(/data-edit-track-mute=/g) || []).length).toBe(DEMO.audioTracks.length);
        expect((markup.match(/data-edit-track-solo=/g) || []).length).toBe(DEMO.audioTracks.length);
        expect((markup.match(/data-edit-track-lock=/g) || []).length).toBe(DEMO.audioTracks.length);
    });

    it("属性区的片段开关与实际状态一致：已关闭的片段给「开启原声」，未关闭的给「关闭原声」", () => {
        useEditStore.setState({ hydrated: true, projects: [withMutedClips(false)], history: {} });
        useAssetStore.setState({ assets: [], hydrated: true });
        const open = dump(
            "editor-track-controls-clip-mute-off",
            renderToStaticMarkup(
                <App>
                    <EditInspector projectId={DEMO.id} clipId="c1" />
                </App>,
            ),
        );
        const openButton = tagOf(open, 'data-edit-clip-mute="c1"');
        expect(openButton.startsWith("<button")).toBe(true);
        expect(openButton).toContain('aria-label="关闭原声"');
        expect(openButton).toContain('aria-pressed="false"');
        expect(openButton).toContain("关闭原声");

        useEditStore.setState({ hydrated: true, projects: [withMutedClips(true)], history: {} });
        const muted = dump(
            "editor-track-controls-clip-mute-on",
            renderToStaticMarkup(
                <App>
                    <EditInspector projectId={DEMO.id} clipId="c1" />
                </App>,
            ),
        );
        const mutedButton = tagOf(muted, 'data-edit-clip-mute="c1"');
        expect(mutedButton).toContain('aria-label="开启原声"');
        expect(mutedButton).toContain('aria-pressed="true"');
    });
});
