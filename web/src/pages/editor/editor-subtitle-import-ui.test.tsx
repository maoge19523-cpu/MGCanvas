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

import i18n from "@/i18n";
import { parseSubtitleFile } from "@/lib/edit/subtitles";
import { useEditStore } from "@/stores/use-edit-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { EDIT_DEFAULT_OUTPUT, type EditProject } from "@/types/edit";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-subtitle-markup");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

/** 视频 4s + 5s = 成片 9 秒，接缝正好在 4.0s。 */
const DEMO: EditProject = {
    id: "edit-subtitle",
    name: "字幕导入",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "m1", name: "开场.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m2", name: "画布成片.mp4", kind: "video", source: "canvas", url: "asset://localhost/x.mp4", durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "m1", start: 0, end: 4, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
    ],
    audioTracks: [],
    output: { ...EDIT_DEFAULT_OUTPUT },
};

/** 一份真实形状的 SRT：一条干净、一条跨片段接缝（3–5s 跨 4.0s）、一条倒序（必须被跳过）。 */
const SRT = ["1", "00:00:01,000 --> 00:00:03,000", "第一句", "", "2", "00:00:03,000 --> 00:00:05,000", "跨接缝的第二句", "", "3", "00:00:08,000 --> 00:00:06,000", "倒序的坏条目", ""].join("\n");

function seed(project: EditProject) {
    useEditStore.setState({ hydrated: true, projects: [project], history: {} });
    useAssetStore.setState({ assets: [], hydrated: true });
}

function render(name: string) {
    return dump(
        name,
        renderToStaticMarkup(
            <MemoryRouter initialEntries={[`/editor/${DEMO.id}`]}>
                <App>
                    <Routes>
                        <Route path="/editor/:id" element={<EditProjectPage />} />
                    </Routes>
                </App>
            </MemoryRouter>,
        ),
    );
}

describe("剪辑台字幕导入：入口与导入后的读回", () => {
    it("素材区有「导入字幕」入口，文件选择框只收 .srt / .vtt", () => {
        seed(DEMO);
        const markup = render("editor-subtitle-entry");

        expect(markup).toContain("data-edit-import-subtitle");
        expect(markup).toContain('accept=".srt,.vtt,text/vtt,application/x-subrip"');
        expect(markup).toContain("导入字幕");
        // 入口在素材区里（左侧面板），不是别处。
        expect(markup.indexOf("data-edit-import-subtitle")).toBeGreaterThan(markup.indexOf('data-edit-area="media"'));
        expect(markup.indexOf("data-edit-import-subtitle")).toBeLessThan(markup.indexOf('data-edit-area="inspector"'));
    });

    it("解析一份真 SRT 并导入后，字幕出现在属性区（右侧）的编辑位置：逐条列出、可改文本", () => {
        seed(DEMO);
        const parsed = parseSubtitleFile(SRT);
        // 倒序那条必须在导入前就被跳过，不能混进项目。
        expect(parsed.issues).toEqual([{ line: 10, reason: "reversedTiming" }]);
        expect(parsed.cues.map((cue) => cue.text)).toEqual(["第一句", "跨接缝的第二句"]);
        useEditStore.getState().importSubtitles(DEMO.id, parsed.cues);

        const markup = render("editor-subtitle-imported");

        // 两条字幕都在属性区里渲染出来了（每条一个独立行，带 id 与时间范围）。
        expect((markup.match(/data-edit-subtitle="/g) || []).length).toBe(2);
        expect((markup.match(/data-edit-subtitle-time="/g) || []).length).toBe(2);
        expect(markup).toContain("第一句");
        expect(markup).toContain("跨接缝的第二句");
        expect(markup).toContain("0:01.0 → 0:03.0");
        expect(markup).toContain("0:03.0 → 0:05.0");
        expect(markup).not.toContain("倒序的坏条目");
        expect(markup).toContain('data-edit-subtitle-count="2"');
        // 导入的字幕确实渲染在属性区（右侧）里：条目、时间与文本都在属性区起始位置之后。
        const inspector = markup.indexOf('data-edit-area="inspector"');
        expect(markup.indexOf("data-edit-subtitle-count")).toBeGreaterThan(inspector);
        expect(markup.indexOf("跨接缝的第二句")).toBeGreaterThan(inspector);
    });

    it("落在成片末尾之后的字幕给常驻提示，不静默当成生效", () => {
        seed({ ...DEMO, subtitles: [{ id: "s1", start: 1, end: 3, text: "成片内" }, { id: "s2", start: 12, end: 14, text: "成片之外" }] });
        const markup = render("editor-subtitle-beyond-end");

        expect(markup).toContain("data-edit-subtitle-beyond");
        expect(markup).toContain("有 1 条落在成片末尾之后，导出里不会出现");
        expect((markup.match(/data-edit-subtitle="/g) || []).length).toBe(2);
    });

    it("没导入过字幕时给出空状态与入口指引，而不是一片空白", () => {
        seed(DEMO);
        const markup = render("editor-subtitle-empty");

        expect(markup).toContain('data-edit-subtitle-count="0"');
        expect(markup).toContain("还没有导入字幕");
        expect(markup).not.toContain("data-edit-subtitle-beyond");
        expect((markup.match(/data-edit-subtitle="/g) || []).length).toBe(0);
    });

    it("字幕条数过多时只列前 50 条，并把「被截断」明说出来（不是静默少显示）", () => {
        const many = Array.from({ length: 60 }, (_, index) => ({ id: `s${index}`, start: index, end: index + 0.5, text: `第 ${index} 条` }));
        seed({ ...DEMO, clips: [{ id: "c1", mediaId: "m1", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 }], subtitles: many });
        const markup = render("editor-subtitle-capped");

        expect(markup).toContain('data-edit-subtitle-count="60"');
        expect((markup.match(/data-edit-subtitle="/g) || []).length).toBe(50);
        expect(markup).toContain("data-edit-subtitle-capped");
        expect(markup).toContain("属性区只列出前 50 条（共 60 条）");
        expect(markup).toContain("第 49 条");
        expect(markup).not.toContain("第 50 条");
    });
});

describe("剪辑台字幕导入：导入结果文案（中英都在，键不会漏成原文）", () => {
    it("读入 / 跳过 / 映射说明的文案两种语言都能取到真实句子", async () => {
        await i18n.changeLanguage("zh-CN");
        expect(i18n.t("editor.subtitleImportDone", { count: 2, format: "SRT", total: 2 })).toBe("读入 2 条字幕（SRT），按成片时间轴原样定位，项目里共 2 条");
        expect(i18n.t("editor.subtitleImportSkipped", { count: 1, reasons: "1 条时间码倒序" })).toBe("跳过 1 条：1 条时间码倒序");
        expect(i18n.t("editor.subtitleImportBeyondEnd", { count: 3 })).toContain("3 条落在成片末尾之后");
        expect(i18n.t("editor.subtitleImportSeams", { count: 1 })).toContain("跨越片段接缝");

        await i18n.changeLanguage("en-US");
        expect(i18n.t("editor.subtitleImportDone", { count: 2, format: "WebVTT", total: 2 })).toContain("Read 2 subtitle cue(s) (WebVTT)");
        expect(i18n.t("editor.subtitleImportSkipped", { count: 1, reasons: "1 × reversed timecode" })).toContain("Skipped 1");
        await i18n.changeLanguage("zh-CN");
    });
});
