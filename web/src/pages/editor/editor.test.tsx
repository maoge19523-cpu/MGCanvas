import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
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

import { AppSideNav } from "@/components/layout/app-side-nav";
import { navigationTools } from "@/constant/navigation-tools";
import { EDIT_DEFAULT_OUTPUT, type EditProject } from "@/types/edit";
import { useEditStore } from "@/stores/use-edit-store";
import { useAssetStore } from "@/stores/use-asset-store";
import EditProjectsPage from "./index";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-markup");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

function render(node: React.ReactNode, path = "/") {
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <App>
                <Routes>
                    <Route path="/editor" element={node} />
                    <Route path="/editor/:id" element={node} />
                    <Route path="*" element={node} />
                </Routes>
            </App>
        </MemoryRouter>,
    );
}

const DEMO: EditProject = {
    id: "edit-1",
    name: "预告片剪辑",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "m1", name: "开场.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, width: 1920, height: 1080, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m2", name: "画布成片.mp4", kind: "video", source: "canvas", url: "asset://localhost/x.mp4", durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m3", name: "背景音乐.mp3", kind: "audio", source: "asset", url: "blob:m3", durationMs: 30000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m4", name: "坏文件.mp4", kind: "video", source: "local", url: "blob:m4", createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "m1", start: 1, end: 5, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5, subtitle: "第二段字幕" },
    ],
    audioTracks: [{ id: "t1", mediaId: "m3", volume: 0.6, fadeIn: 1, fadeOut: 2, loop: true }],
    output: { ...EDIT_DEFAULT_OUTPUT },
};

function seed(projects: EditProject[]) {
    useEditStore.setState({ hydrated: true, projects });
    useAssetStore.setState({ assets: [], hydrated: true });
}

describe("侧边栏入口：剪辑台", () => {
    it("导航项里「剪辑台」紧跟在「提示词库」之后，用的是 Clapperboard 图标", () => {
        const slugs = navigationTools.map((tool) => tool.slug);
        expect(slugs.indexOf("editor")).toBe(slugs.indexOf("prompts") + 1);

        const markup = dump("side-nav", render(<AppSideNav />, "/prompts"));
        const promptsIndex = markup.indexOf("提示词库");
        const editorIndex = markup.indexOf("剪辑台");
        expect(promptsIndex).toBeGreaterThan(-1);
        expect(editorIndex).toBeGreaterThan(promptsIndex);
        expect(markup).toContain('href="/editor"');
        expect(markup).toContain("lucide-clapperboard");
    });
});

describe("剪辑台首页：项目列表", () => {
    it("没有项目时给出中文空状态与新建引导按钮", () => {
        seed([]);
        const markup = dump("projects-empty", render(<EditProjectsPage />, "/editor"));

        expect(markup).toContain("还没有剪辑项目");
        expect(markup).toContain("新建剪辑");
        expect(markup).toContain("左侧导入素材");
    });

    it("有项目时列出项目名、更新时间、素材与片段数量", () => {
        seed([DEMO]);
        const markup = dump("projects-list", render(<EditProjectsPage />, "/editor"));

        expect(markup).toContain("预告片剪辑");
        expect(markup).toContain("素材 4 · 片段 2");
        // 更新时间按本地时区格式化，这里只校验前缀与日期部分，避免测试机时区影响结论。
        expect(markup).toContain("更新于 2024-01-02");
        expect(markup).not.toContain("还没有剪辑项目");
    });
});

describe("剪辑台编辑器：四区结构", () => {
    it("素材区 / 预览区 / 时间线 / 属性区四块都在，且预览提示与素材来源都在真实输出里", () => {
        seed([DEMO]);
        const markup = dump("editor-four-areas", render(<EditProjectPage />, "/editor/edit-1"));

        for (const area of ["media", "preview", "timeline", "inspector"]) expect(markup).toContain(`data-edit-area="${area}"`);
        // 预览提示必须写在界面上，而不是只躺在注释里。
        // 文案已随「预览接入音轨混音」改写：原来写的是「预览仅用于对时」，
        // 音轨进预览之后这句话不再准确（见 editor-preview-audio-ui.test.tsx 的文案断言）。
        expect(markup).toContain("预览含原声与音轨混音，转场和字幕以导出为准");
        // 时间线的片段条按真实时长排布（入点 1s、出点 5s → 4s 净时长）。
        expect(markup).toContain('data-edit-clip="c1"');
        expect(markup).toContain("片段 1 · 4.0s · 开场.mp4");
        expect(markup).toContain('data-edit-clip="c2"');
        expect(markup).toContain("片段 2 · 5.0s · 画布成片.mp4");
        // 播放头、标尺与三条素材来源。
        expect(markup).toContain("data-edit-playhead");
        expect(markup).toContain("导入本地文件");
        expect(markup).toContain("从我的资产选择");
        expect(markup).toContain("发送到剪辑台");
        expect(markup).toContain("画布发送");
        // 属性区：选中片段前给出引导文案，同时输出参数与导出按钮已就位。
        expect(markup).toContain("属性");
        expect(markup).toContain("导出成片");
        expect(markup).toContain("成片时长约");
        expect(markup).toContain("音轨");
        expect(markup).toContain("背景音乐.mp3");
    });

    it("项目有素材但时间线为空时给出中文空状态与引导文案", () => {
        seed([{ ...DEMO, clips: [] }]);
        const markup = dump("editor-empty-timeline", render(<EditProjectPage />, "/editor/edit-1"));

        expect(markup).toContain("时间线还是空的");
        expect(markup).toContain("在左侧素材上点「加入时间线」");
        expect(markup).toContain("把素材全部加入时间线");
        expect(markup).not.toContain("data-edit-clip=");
    });

    it("项目没有素材时素材区与时间线都给出中文空状态", () => {
        seed([{ ...DEMO, media: [], clips: [], audioTracks: [] }]);
        const markup = dump("editor-empty-media", render(<EditProjectPage />, "/editor/edit-1"));

        expect(markup).toContain("这个项目还没有素材");
        expect(markup).toContain("导入本地文件");
    });

    it("素材缺少时长信息时给出中文提示与重新探测按钮，而不是静默不可用", () => {
        seed([DEMO]);
        const markup = dump("editor-media-no-duration", render(<EditProjectPage />, "/editor/edit-1"));

        expect(markup).toContain("时长未探测到，暂不能进入时间线");
        expect(markup).toContain("重新探测");
        // 有真实时长的素材仍然可以入轨。
        expect(markup).toContain('aria-label="加入时间线"');
    });

    it("项目不存在时给出中文提示与返回入口", () => {
        seed([]);
        const markup = dump("editor-project-missing", render(<EditProjectPage />, "/editor/nope"));

        expect(markup).toContain("这个剪辑项目不存在或已被删除");
        expect(markup).toContain("返回剪辑台");
    });
});
