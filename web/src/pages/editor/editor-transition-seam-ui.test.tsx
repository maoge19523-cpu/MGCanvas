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

import { timelinePlacements, timeToPercent } from "@/lib/timeline-scale";
import { useAssetStore } from "@/stores/use-asset-store";
import { useEditStore } from "@/stores/use-edit-store";
import { EDIT_DEFAULT_OUTPUT, type EditClip, type EditProject } from "@/types/edit";
// i18n 必须显式初始化：接缝面板的断言核对的是真实文案（键位对齐由 locale-parity.test 另外守住）。
import "@/i18n";
import { EditTransitionSeamPanel } from "./components/edit-transition-seam";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-transition-seam");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

// 不等长（合计 15s）：等长会让「百分比」看起来都对，不等长才验得出一套换算。
const LENGTHS = [4, 6, 5];
const TOTAL = LENGTHS.reduce((sum, length) => sum + length, 0);

/**
 * 改动前（接缝标记还不存在时）真实渲染出来的片段条内联样式，逐字冻结在这里。
 * 这三行是「chip 没有从轨道宽度里偷像素」的证据：只要片段行的容器、换算或片段样式被动了手脚，
 * 渲染出来的百分比字符串就会变，这里立刻失败。
 */
const FROZEN_CLIP_STYLES = [
    "left:0%;width:26.666666666666668%",
    "left:26.666666666666668%;width:39.999999999999986%",
    "left:66.66666666666666%;width:33.33333333333334%",
];

function demo(id: string, lengths: number[], transitions: Record<number, Partial<EditClip>> = {}): EditProject {
    return {
        id,
        name: "接缝",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T03:04:00.000Z",
        media: [{ id: "m1", name: "长视频.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 20000, createdAt: "2024-01-01T00:00:00.000Z" }],
        audioTracks: [],
        output: { ...EDIT_DEFAULT_OUTPUT },
        clips: lengths.map((length, index) => ({ id: `c${index + 1}`, mediaId: "m1", start: 0, end: length, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5, ...transitions[index] })),
    };
}

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

/** 从产物里读出每个片段条的完整内联样式（逐字，用来与改动前的冻结值对比）。 */
function readClipStyles(markup: string) {
    return [...markup.matchAll(/data-edit-clip="([^"]+)"[^>]*style="([^"]*)"/g)].map((match) => ({ id: match[1]!, style: match[2]! }));
}

/** 片段条右边缘：直接由产物里的 left / width 相加，与 DOM 的右边缘是同一个算式。 */
function boundaryOf(style: string) {
    return Number(style.match(/left:([-\d.eE+]+)%/)![1]) + Number(style.match(/width:([-\d.eE+]+)%/)![1]);
}

/** 从产物里读出每条接缝标记：标签、属性、内联样式与内容（判断「可点」与「看得出种类」）。 */
function readSeams(markup: string) {
    return [...markup.matchAll(/<(\w+) data-edit-transition-seam="([^"]+)"([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => {
        const attrs = match[3]!;
        const style = attrs.match(/style="([^"]*)"/)?.[1] ?? "";
        return {
            tag: match[1]!,
            id: match[2]!,
            attrs,
            style,
            content: match[4]!,
            transition: attrs.match(/data-edit-seam-transition="([^"]+)"/)?.[1],
            className: attrs.match(/class="([^"]*)"/)?.[1] ?? "",
            aria: attrs.match(/aria-label="([^"]*)"/)?.[1] ?? "",
            left: Number(style.match(/left:([-\d.eE+]+)%/)![1]),
        };
    });
}

/** 从产物里读出每个标尺刻度的内联 left（刻度按步长依次生成）。 */
function readTicks(markup: string) {
    return [...markup.matchAll(/style="left:([-\d.eE+]+)%;transform:(?:none|translateX\(-50%\))"[\s\S]{0,200}?tabular-nums/g)].map((match) => Number(match[1]));
}

/** 片段行的真实产物片段（行容器到音轨行之前）：行容器的类名与「谁带宽度」都在这里核对。 */
function videoTrackRow(markup: string) {
    return markup.slice(markup.indexOf("data-edit-video-track"), markup.indexOf("data-edit-audio-track"));
}

/** 面板里「删除转场」那个按钮的真实产物（用来核对禁用状态）。 */
function removeButton(markup: string) {
    return markup.match(/<button[^>]*>[\s\S]*?删除转场[\s\S]*?<\/button>/)?.[0] ?? "";
}

describe("剪辑台接缝标记：接缝上看得见、点得到（真实产物读回）", () => {
    it("有转场的接缝渲染出 chip，位置与片段条的边界逐字同值；硬切的接缝也有一个可点元素", () => {
        const markup = render(demo("edit-seam-mixed", LENGTHS, { 0: { transition: "fade", transitionDuration: 0.8 } }), "editor-transition-seam-mixed");
        const clips = readClipStyles(markup);
        const seams = readSeams(markup);
        const placements = timelinePlacements(LENGTHS, TOTAL);

        // 3 段 → 2 条接缝（首段之前、末段之后都没有）。
        expect(seams.map((seam) => seam.id)).toEqual(["c1", "c2"]);

        // 有转场的那条：属性里能读出种类，内容里有图标 + 短名字（看得出是哪一种，不是只有一个点）。
        expect(seams[0]!.transition).toBe("fade");
        expect(seams[0]!.content).toContain("<svg");
        expect(seams[0]!.content).toMatch(/<span class="truncate">[^<]+<\/span>/);

        // 硬切的那条：没有转场属性、是虚线小槽，但**仍然是一个真的按钮**（可点、可键盘触发），
        // 悬停 / 聚焦才展开的「＋」就在它里面——这正是「没加转场也要找得到入口」。
        expect(seams[1]!.transition).toBeUndefined();
        expect(seams[1]!.className).toContain("border-dashed");
        expect(seams[1]!.content).toContain("lucide-plus");
        for (const seam of seams) {
            expect(seam.tag).toBe("button");
            expect(seam.attrs).toContain('type="button"');
            expect(seam.className).toContain("absolute");
            expect(seam.aria.length).toBeGreaterThan(0);
        }

        // 定位值 = 左段的右边缘（产物里的 left + width）＝按秒数换算的位置，三者同值。
        expect(seams[0]!.left).toBe(boundaryOf(clips[0]!.style));
        expect(seams[1]!.left).toBe(boundaryOf(clips[1]!.style));
        expect(seams[0]!.left).toBe(placements[0]!.left + placements[0]!.width);
        expect(seams[1]!.left).toBe(placements[1]!.left + placements[1]!.width);
        expect(seams[0]!.left).toBe(timeToPercent(4, TOTAL));
        expect(seams[1]!.left).toBe(timeToPercent(10, TOTAL));
        // 与标尺刻度也重合：第 2 条接缝在 10 秒上，就是「10」这条刻度（总时长 15s → 步长 2s）。
        expect(seams[1]!.left).toBe(readTicks(markup)[5]!);
    });

    it("不同转场各有自己的图标：两条转场不同的接缝，图标不是同一个，且短名字都在", () => {
        const markup = render(demo("edit-seam-kinds", LENGTHS, { 0: { transition: "fade" }, 1: { transition: "wipeleft" } }), "editor-transition-seam-kinds");
        const seams = readSeams(markup);
        const icon = (content: string) => content.match(/<svg[^>]*>[\s\S]*?<\/svg>/)?.[0] ?? "";

        expect(seams.map((seam) => seam.transition)).toEqual(["fade", "wipeleft"]);
        expect(icon(seams[0]!.content)).not.toBe("");
        expect(icon(seams[1]!.content)).not.toBe(icon(seams[0]!.content));
        for (const seam of seams) expect(seam.content).toMatch(/<span class="truncate">[^<]+<\/span>/);
    });

    it("只有 1 个片段时不渲染任何 chip（末段的转场字段也没有接缝可落）", () => {
        const markup = render(demo("edit-seam-single", [7], { 0: { transition: "fade" } }), "editor-transition-seam-single");

        expect(readClipStyles(markup)).toHaveLength(1);
        expect(markup.match(/data-edit-transition-seam=/g)).toBeNull();
    });

    it("点开接缝后面板里有：类型下拉（当前种类）、转场时长、删除转场", () => {
        const seam = { index: 0, leftClipId: "c1", rightClipId: "c2", seconds: 4, percent: 26.666666666666668, transition: "fade", transitionDuration: 0.8, locked: false };
        const withTransition = dump("editor-transition-seam-panel.html", renderToStaticMarkup(<App><EditTransitionSeamPanel seam={seam} onChange={() => undefined} /></App>));

        // 类型下拉显示的就是这条接缝当前的种类（选项是 7 种 + 硬切，由 EDIT_TRANSITIONS 生成）。
        expect(withTransition).toContain("ant-select");
        expect(withTransition).toContain('title="交叉溶解"');
        expect(withTransition).toContain("转场时长");
        expect(withTransition).toContain('aria-valuenow="0.8"');
        // 有转场时三样都能用：下拉、时长、删除都不是禁用态。
        expect(withTransition).not.toContain("ant-select-disabled");
        expect(withTransition).not.toContain("ant-input-number-disabled");
        expect(removeButton(withTransition)).toContain("删除转场");
        expect(removeButton(withTransition)).not.toContain("disabled");

        // 硬切（没有转场）时：下拉显示「硬切」，时长与删除都禁用——先选一种类型才有得改。
        const hardCut = renderToStaticMarkup(<App><EditTransitionSeamPanel seam={{ ...seam, transition: undefined }} onChange={() => undefined} /></App>);
        expect(hardCut).toContain('title="硬切"');
        expect(hardCut).toContain("ant-input-number-disabled");
        expect(removeButton(hardCut)).toContain("disabled");
    });

    it("锁定的片段：面板照旧打得开，但控件全部禁用并给出锁定提示（与属性区同一套拒绝规则）", () => {
        const markup = renderToStaticMarkup(
            <App>
                <EditTransitionSeamPanel seam={{ index: 0, leftClipId: "c1", rightClipId: "c2", seconds: 4, percent: 26.666666666666668, transition: "fade", transitionDuration: 0.8, locked: true }} onChange={() => undefined} />
            </App>,
        );

        expect(markup).toContain("这条轨已锁定，先在轨道头解锁再编辑");
        expect(markup).toContain("ant-select-disabled");
        expect(markup).toContain("ant-input-number-disabled");
        expect(removeButton(markup)).toContain("disabled");
    });
});

describe("剪辑台接缝标记：不占布局宽度（回归断言）", () => {
    it("片段条的 left / width 与改动前逐字相同（冻结值来自加接缝标记之前的渲染）", () => {
        const markup = render(demo("edit-seam-again", LENGTHS, { 0: { transition: "fade" } }), "editor-transition-seam-frozen");
        const clips = readClipStyles(markup);
        const placements = timelinePlacements(LENGTHS, TOTAL);

        expect(clips.map((clip) => clip.style)).toEqual(FROZEN_CLIP_STYLES);
        // 逐字对比之外，再按同一套换算复核一遍：两段证据都指向「百分比没被动过」。
        clips.forEach((clip, index) => expect(clip.style).toBe(`left:${placements[index]!.left}%;width:${placements[index]!.width}%`));
    });

    it("视频轨行容器本身没有被加内边距 / gap / flex：类名与改动前逐字相同", () => {
        const markup = render(demo("edit-seam-row", LENGTHS, { 0: { transition: "fade" } }), "editor-transition-seam-row");
        const row = videoTrackRow(markup);

        expect(row.match(/data-edit-video-track="true" class="([^"]*)"/)![1]).toBe("relative h-12");
        // 行里只有片段条带宽度：chip 一个 width 都不写（绝对定位 + 内容宽度，不参与轨道宽度分配）。
        expect([...row.matchAll(/style="[^"]*width:[^"]*"/g)]).toHaveLength(LENGTHS.length);
        for (const seam of readSeams(markup)) expect(seam.style).not.toContain("width");
    });

    it("标尺刻度与播放头仍然共用同一条换算（不变式守护：改动前后都通过）", () => {
        const markup = render(demo("edit-seam-scale", LENGTHS, {}), "editor-transition-seam-scale");
        const ticks = readTicks(markup);

        // 总时长 15s → 刻度步长 2s：0、2、4 … 14。
        expect(ticks).toEqual([0, 2, 4, 6, 8, 10, 12, 14].map((seconds) => timeToPercent(seconds, TOTAL)));
        expect(markup).toContain('data-edit-playhead="true" class="pointer-events-none absolute inset-y-0 z-10 w-px bg-[#756bff]" style="left:0%"');
    });
});
