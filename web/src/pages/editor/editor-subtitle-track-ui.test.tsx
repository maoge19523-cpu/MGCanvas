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

import { EDIT_SUBTITLE_MIN_PX, editSubtitlePlacement } from "@/lib/edit/subtitle-blocks";
import { timelinePlacements, timeToPercent } from "@/lib/timeline-scale";
import { useAssetStore } from "@/stores/use-asset-store";
import { useEditStore } from "@/stores/use-edit-store";
import { EDIT_DEFAULT_OUTPUT, type EditProject, type EditSubtitle } from "@/types/edit";
import { EditInspector } from "./components/edit-inspector";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-subtitle-track");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

/**
 * 视频 4s + 5s = 成片 9 秒，外加一条 20 秒、从第 2 秒起的音轨（波形条会被裁到成片末尾）。
 * 字幕刻意覆盖四种情况：成片之内 / 首尾相接（不算重叠）/ 真的重叠 / 结尾超出 / 整条在成片之外 / 极短。
 */
const DEMO: EditProject = {
    id: "edit-subtitle-track",
    name: "字幕块",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "m1", name: "开场.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m2", name: "画布成片.mp4", kind: "video", source: "canvas", url: "asset://localhost/x.mp4", durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m3", name: "背景乐.mp3", kind: "audio", source: "local", url: "blob:m3", durationMs: 20000, createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "m1", start: 0, end: 4, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
    ],
    audioTracks: [{ id: "t1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, start: 2 }],
    output: { ...EDIT_DEFAULT_OUTPUT },
};

const TOTAL = 9;
const LENGTHS = [4, 5];

const SUBTITLES: EditSubtitle[] = [
    { id: "s1", start: 1, end: 3, text: "第一句" },
    { id: "s2", start: 3, end: 5, text: "紧接上一句，首尾相接不算重叠" },
    { id: "s3", start: 4.5, end: 6, text: "和上一句时间重叠" },
    { id: "s4", start: 8, end: 10, text: "结尾超出成片" },
    { id: "s5", start: 12, end: 14, text: "整条都在成片之外" },
    { id: "s6", start: 6.5, end: 6.52, text: "极短的一句" },
];

/**
 * 改动前（时间线上还没有字幕块时）渲染出来的片段条内联样式，**逐字**冻结在这里。
 * 加了字幕行之后这两行必须一个字符都不差：字幕块是从共享的可定位宽度里算自己的百分比，
 * 不允许从容器宽度里偷像素（一旦偷了，片段条 / 波形条 / 标尺就会错开）。
 */
const FROZEN_CLIP_STYLES = ["left:0%;width:44.44444444444444%", "left:44.44444444444444%;width:55.55555555555556%"];

/** 改动前共享滚动容器的类名（逐字冻结）：这一段决定了「所有按时间定位的元素摊在同一个宽度上」。 */
const FROZEN_SCROLLER_CLASS = "thin-scrollbar mt-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-4";

function withSubtitles(subtitles: EditSubtitle[] = SUBTITLES): EditProject {
    return { ...DEMO, subtitles };
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

/** 从产物里读出每个字幕块：原始起止、状态位、内联样式与可见文案。 */
function readBlocks(markup: string) {
    return [...markup.matchAll(/<div ([^>]*data-edit-subtitle-block="[^"]+"[^>]*)>/g)].map((match) => {
        const attrs = match[1]!;
        const style = attrs.match(/style="([^"]*)"/)?.[1] ?? "";
        return {
            id: attrs.match(/data-edit-subtitle-block="([^"]+)"/)![1]!,
            start: Number(attrs.match(/data-edit-subtitle-block-start="([^"]*)"/)![1]),
            end: Number(attrs.match(/data-edit-subtitle-block-end="([^"]*)"/)![1]),
            out: attrs.match(/data-edit-subtitle-block-out="([^"]+)"/)?.[1],
            overlap: attrs.includes('data-edit-subtitle-block-overlap="true"'),
            selected: attrs.includes('data-edit-subtitle-block-selected="true"'),
            style,
            left: Number(style.match(/left:([-\d.eE+]+)%/)![1]),
            width: Number(style.match(/width:([-\d.eE+]+)%/)![1]),
            title: attrs.match(/title="([^"]*)"/)?.[1] ?? "",
            label: match[0],
        };
    });
}

/** 块里显示的截断摘要（块内第一个 span 的文字）。 */
function readBlockLabels(markup: string) {
    return [...markup.matchAll(/data-edit-subtitle-block="[^"]+"[^>]*>\s*<span class="pointer-events-none block truncate[^"]*">([^<]*)<\/span>/g)].map((match) => match[1]!);
}

/** 从产物里读出每个片段条的完整内联样式（逐字，用来与改动前的冻结值对比）。 */
function readClipStyles(markup: string) {
    return [...markup.matchAll(/data-edit-clip="([^"]+)"[^>]*style="([^"]*)"/g)].map((match) => match[2]!);
}

/** 从产物里读出每条波形条的内联样式（逐字）。 */
function readWaveformStyles(markup: string) {
    return [...markup.matchAll(/data-edit-waveform-strip="[^"]+"[^>]*style="([^"]*)"/g)].map((match) => match[1]!);
}

/** 从产物里读出每个标尺刻度的内联 left。 */
function readTicks(markup: string) {
    return [...markup.matchAll(/style="left:([-\d.eE+]+)%;transform:(?:none|translateX\(-50%\))"[\s\S]{0,200}?tabular-nums/g)].map((match) => Number(match[1]));
}

/** 取出带某个 data 属性的那个 `<div>` 的完整内容（按 `<div>` / `</div>` 逐层配对）。 */
function divSlice(markup: string, marker: string) {
    const at = markup.indexOf(marker);
    expect(at, `产物里找不到 ${marker}`).toBeGreaterThan(-1);
    const start = markup.lastIndexOf("<div", at);
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = tags.exec(markup)) !== null) {
        if (match[0] === "</div>") {
            depth -= 1;
            if (depth === 0) return markup.slice(start, match.index + "</div>".length);
        } else depth += 1;
    }
    throw new Error(`${marker} 所在的 <div> 没有配对的 </div>`);
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("剪辑台字幕块：块的位置与字幕起止严格对应（真实产物读回）", () => {
    it("每条字幕一个块，left / width 就是 timeToPercent 这一套换算：右边缘 == end 的换算值", () => {
        const markup = render(withSubtitles(), "editor-subtitle-blocks");
        const blocks = readBlocks(markup);

        expect(blocks.map((block) => block.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
        for (const block of blocks) {
            // 产物里的原始起止与数据逐字一致。
            const cue = SUBTITLES.find((item) => item.id === block.id)!;
            expect(block.start).toBe(cue.start);
            expect(block.end).toBe(cue.end);
        }

        // 成片之内的每一条：两条边都等于 timeToPercent 的换算值（与标尺刻度同一套）。
        for (const id of ["s1", "s2", "s3", "s6"]) {
            const block = blocks.find((item) => item.id === id)!;
            const cue = SUBTITLES.find((item) => item.id === id)!;
            expect(block.left).toBe(timeToPercent(cue.start, TOTAL));
            expect(block.left + block.width).toBe(timeToPercent(cue.end, TOTAL));
            expect(block.out).toBeUndefined();
        }
        // 标尺上第 8 秒那条刻度的位置就是 s4（start = 8）的左边缘：两者共用同一条换算。
        expect(blocks.find((block) => block.id === "s4")!.left).toBe(readTicks(markup)[4]!);
        expect(blocks.find((block) => block.id === "s4")!.left).toBe(timeToPercent(8, TOTAL));
    });

    it("字幕块是**内容**而不是覆盖层：left 与 width 都写，且没有第二个换算源", () => {
        const markup = render(withSubtitles(), "editor-subtitle-content");

        for (const block of readBlocks(markup)) {
            expect(block.style).toMatch(/^left:[-\d.eE+]+%;width:[-\d.eE+]+%/);
            expect(block.style).not.toContain("calc(");
        }
        // 整条字幕行里，占位只出现在块上；重叠斜纹带与末尾提示是覆盖层（只写 left / 不写 left）。
        const row = divSlice(markup, "data-edit-subtitle-track");
        expect(occurrences(row, 'data-edit-subtitle-block="')).toBe(SUBTITLES.length);
    });

    it("块里是字幕的截断摘要，全文与起止在 title 里（悬停 / 聚焦看得到）", () => {
        const markup = render(withSubtitles(), "editor-subtitle-label");
        const blocks = readBlocks(markup);
        const labels = readBlockLabels(markup);

        expect(labels).toEqual(SUBTITLES.map((cue) => cue.text));
        expect(blocks[0]!.title).toContain("第一句");
        expect(blocks[0]!.title).toContain("0:01.0 → 0:03.0");
        // 每块都是可聚焦、可读出名字的按钮语义（键盘可达）。
        for (const block of readBlocks(markup)) {
            expect(block.label).toContain('role="button"');
            expect(block.label).toContain("tabindex=\"0\"");
            expect(block.label).toContain("aria-label=");
        }
    });

    it("每块两端各有一个裁剪把手，块身可拖：三种拖动入口都在产物里", () => {
        const markup = render(withSubtitles(), "editor-subtitle-handles");

        expect(occurrences(markup, 'data-edit-subtitle-handle="start"')).toBe(SUBTITLES.length);
        expect(occurrences(markup, 'data-edit-subtitle-handle="end"')).toBe(SUBTITLES.length);
        const row = divSlice(markup, "data-edit-subtitle-track");
        expect(row).toContain("cursor-ew-resize");
    });
});

describe("剪辑台字幕块：重叠、极短、超出成片、极多（真实产物读回）", () => {
    it("重叠的两条：两条都标出来，重叠那一段有斜纹带与「叠 N」标记，块的定位值与没重叠时一模一样", () => {
        const markup = render(withSubtitles(), "editor-subtitle-overlap");
        const blocks = readBlocks(markup);

        // s2(3–5) 与 s3(4.5–6) 真的同时出现；s1 与 s2 只是首尾相接，不算叠。
        expect(blocks.filter((block) => block.overlap).map((block) => block.id)).toEqual(["s2", "s3"]);
        expect(markup).toContain('data-edit-subtitle-overlap-band="2"');
        expect(markup).toContain('data-edit-subtitle-overlap-badge="2"');
        expect(markup).toContain("叠 2");
        // 重叠区的带子覆盖 [4.5, 5]：同样是 timeToPercent 的换算，不另写一套。
        const band = markup.match(/data-edit-subtitle-overlap-band="[^"]*"[^>]*style="([^"]*)"/)?.[1] ?? "";
        expect(band).toContain(`left:${timeToPercent(4.5, TOTAL)}%`);
        expect(band).toContain(`width:${timeToPercent(5, TOTAL) - timeToPercent(4.5, TOTAL)}%`);
        // 标记重叠**不改变**块的定位：判定重叠只是加了一个状态位。
        const s3 = blocks.find((block) => block.id === "s3")!;
        expect(s3.left).toBe(timeToPercent(4.5, TOTAL));
        expect(s3.left + s3.width).toBe(timeToPercent(6, TOTAL));
    });

    it("没有重叠时不给任何重叠标记（不能到处都画斜纹）", () => {
        const markup = render(withSubtitles([{ id: "n1", start: 1, end: 3, text: "独苗" }, { id: "n2", start: 3, end: 4, text: "首尾相接" }]), "editor-subtitle-no-overlap");

        expect(markup).not.toContain("data-edit-subtitle-overlap-band");
        expect(markup).not.toContain("data-edit-subtitle-overlap-badge");
        expect(readBlocks(markup).every((block) => !block.overlap)).toBe(true);
    });

    it("极短字幕：宽度仍是真值的百分比，另有可点下限保证抓得住", () => {
        const markup = render(withSubtitles(), "editor-subtitle-short");
        const short = readBlocks(markup).find((block) => block.id === "s6")!;

        // 宽度是「两条边的换算值之差」（与 timelinePlacements 同一算法），所以与「时长直接换算」
        // 只在小数末位有浮点差异——这里按 12 位比较，够证明是同一条换算。
        expect(short.width).toBeCloseTo(timeToPercent(0.02, TOTAL), 12);
        expect(short.width).toBeLessThan(1);
        expect(short.style).toContain(`min-width:${EDIT_SUBTITLE_MIN_PX}px`);
        // 下限只是渲染下限：它不参与百分比换算，别的块的百分比因此一点没动。
        expect(short.left).toBe(timeToPercent(6.5, TOTAL));
    });

    it("结尾超出成片的条：右边缘裁到 100%，并且明说它只显示前半段", () => {
        const markup = render(withSubtitles(), "editor-subtitle-clipped");
        const clipped = readBlocks(markup).find((block) => block.id === "s4")!;

        expect(clipped.out).toBe("clipped");
        expect(clipped.left).toBe(timeToPercent(8, TOTAL));
        expect(clipped.left + clipped.width).toBe(100);
        expect(clipped.title).toContain("结尾超出成片末尾");
    });

    it("整条在成片之外的条：left 钉在 100%、宽度 0（还有下限托着，右端是个能抓的小块），行里给出条数", () => {
        const markup = render(withSubtitles(), "editor-subtitle-beyond");
        const beyond = readBlocks(markup).find((block) => block.id === "s5")!;

        expect(beyond.out).toBe("beyond");
        expect(beyond.left).toBe(100);
        expect(beyond.width).toBe(0);
        expect(beyond.style).toContain(`min-width:${EDIT_SUBTITLE_MIN_PX}px`);
        expect(beyond.title).toContain("起点在成片末尾之后");
        expect(markup).toContain('data-edit-subtitle-track-beyond="1"');
        expect(markup).toContain("末尾之外 1 条");
    });

    it("500 条字幕：时间线上一条不落（只有普通 div，代价可接受），属性区照旧只列前 50 条并说明截断", () => {
        const many: EditSubtitle[] = Array.from({ length: 500 }, (_, index) => ({ id: `s${index}`, start: index * 0.017, end: index * 0.017 + 0.01, text: `第 ${index} 条` }));
        const markup = render(withSubtitles(many), "editor-subtitle-many");
        const blocks = readBlocks(markup);

        expect(blocks).toHaveLength(500);
        expect(blocks[499]!.id).toBe("s499");
        expect(blocks[499]!.left).toBe(timeToPercent(499 * 0.017, TOTAL));
        // 仍然只有一行（不是 500 行），也没有自己的滚动容器。
        expect(occurrences(markup, "data-edit-subtitle-track=")).toBe(1);
        // 对照组：属性区在同一份产物里只列前 50 条（每条都带输入框，代价高得多）。
        expect(occurrences(markup, 'data-edit-subtitle="')).toBe(50);
        expect(markup).toContain("data-edit-subtitle-capped");
        expect(markup).toContain("属性区只列出前 50 条（共 500 条）");
    });
});

describe("剪辑台字幕块：边界情况（真实产物读回）", () => {
    it("没有字幕时**整行不渲染**：时间线的产物与改动前完全一致", () => {
        const markup = render({ ...DEMO }, "editor-subtitle-absent");

        expect(markup).not.toContain("data-edit-subtitle-track");
        expect(markup).not.toContain("data-edit-subtitle-block");
        expect(occurrences(markup, 'data-edit-subtitle="')).toBe(0);
        // 其它行照旧都在。
        expect(markup).toContain("data-edit-video-track");
        expect(markup).toContain("data-edit-audio-track");
        expect(markup).toContain("data-edit-playhead");
    });

    it("只有 1 条字幕时也照常渲染这一行（不因为条数少就走另一条路）", () => {
        const markup = render(withSubtitles([{ id: "only", start: 0, end: 2, text: "唯一一句" }]), "editor-subtitle-single");

        expect(readBlocks(markup)).toHaveLength(1);
        expect(occurrences(markup, "data-edit-subtitle-track=")).toBe(1);
        expect(markup).not.toContain("data-edit-subtitle-overlap-band");
        expect(markup).not.toContain("data-edit-subtitle-track-beyond");
    });

    it("start = 0、end 超出成片、时长为零三种极端值都不会把这一行搞坏", () => {
        const markup = render(withSubtitles([{ id: "z1", start: 0, end: 9, text: "铺满全片" }, { id: "z2", start: 0, end: 20, text: "整条比成片还长" }, { id: "z3", start: 4, end: 4, text: "零长度" }]), "editor-subtitle-extremes");
        const blocks = readBlocks(markup);

        expect(blocks[0]!.left).toBe(0);
        expect(blocks[0]!.left + blocks[0]!.width).toBe(100);
        expect(blocks[1]!.left).toBe(0);
        expect(blocks[1]!.left + blocks[1]!.width).toBe(100);
        expect(blocks[2]!.width).toBe(0);
        for (const block of blocks) expect(Number.isFinite(block.left) && Number.isFinite(block.width)).toBe(true);
    });
});

describe("剪辑台字幕块：选中 → 属性区对应到那一条（真实产物读回）", () => {
    it("选中的那条在属性区高亮，并带出选中态属性；只有一条是选中态", () => {
        useEditStore.setState({ hydrated: true, projects: [withSubtitles()], history: {} });
        const markup = dump("editor-subtitle-selected", renderToStaticMarkup(<App><EditInspector projectId={DEMO.id} clipId={null} subtitleId="s3" /></App>));

        expect(occurrences(markup, 'data-edit-subtitle-selected="true"')).toBe(1);
        expect(markup).toContain('data-edit-subtitle="s3" data-edit-subtitle-selected="true"');
        expect(markup).toContain("已选中");
        // 三条都在列表里，另外两条没有被高亮。
        expect(occurrences(markup, 'data-edit-subtitle="')).toBe(SUBTITLES.length);
    });

    it("选中的那条排在前 50 条之外时，属性区把它单独列出来——不让「选中」在属性区落空", () => {
        const many: EditSubtitle[] = Array.from({ length: 60 }, (_, index) => ({ id: `s${index}`, start: index * 0.1, end: index * 0.1 + 0.05, text: `第 ${index} 条` }));
        useEditStore.setState({ hydrated: true, projects: [withSubtitles(many)], history: {} });
        const markup = dump("editor-subtitle-selected-outside", renderToStaticMarkup(<App><EditInspector projectId={DEMO.id} clipId={null} subtitleId="s59" /></App>));

        expect(markup).toContain('data-edit-subtitle="s59" data-edit-subtitle-selected="true"');
        expect(occurrences(markup, 'data-edit-subtitle-selected="true"')).toBe(1);
        // 50 条上限照旧，只多补了选中的那一条。
        expect(occurrences(markup, 'data-edit-subtitle="')).toBe(51);
        expect(markup).toContain("属性区只列出前 50 条（共 60 条）");
        expect(markup).toContain("第 59 条");
    });
});

describe("剪辑台字幕块：不占布局宽度（回归断言）", () => {
    it("片段条的内联样式与改动前逐字相同（冻结值来自加字幕块之前的渲染）", () => {
        const withSubs = render(withSubtitles(), "editor-subtitle-frozen-with");
        const withoutSubs = render({ ...DEMO }, "editor-subtitle-frozen-without");

        expect(readClipStyles(withSubs)).toEqual(FROZEN_CLIP_STYLES);
        expect(readClipStyles(withoutSubs)).toEqual(FROZEN_CLIP_STYLES);
        // 逐字对比之外，再按同一套换算复核一遍。
        readClipStyles(withSubs).forEach((style, index) => {
            const placement = timelinePlacements(LENGTHS, TOTAL)[index]!;
            expect(style).toBe(`left:${placement.left}%;width:${placement.width}%`);
        });
    });

    it("加了字幕行之后，整段视频轨行的产物与没有字幕时**逐字相同**", () => {
        const withSubs = render(withSubtitles(), "editor-subtitle-row-with");
        const withoutSubs = render({ ...DEMO }, "editor-subtitle-row-without");

        // 视频轨行（含轨道头、全部片段条、全部接缝标记）一个字符都没变。
        expect(divSlice(withSubs, "data-edit-video-track")).toBe(divSlice(withoutSubs, "data-edit-video-track"));
        // 波形条、标尺刻度、播放头同样逐字相同。
        expect(readWaveformStyles(withSubs)).toEqual(readWaveformStyles(withoutSubs));
        expect(readTicks(withSubs)).toEqual(readTicks(withoutSubs));
        expect(withSubs.match(/<div data-edit-playhead[^>]*>/)?.[0]).toBe(withoutSubs.match(/<div data-edit-playhead[^>]*>/)?.[0]);
    });

    it("字幕行自己不带任何会吃掉宽度的东西：没有内边距 / 横向外边距 / 自己的滚动容器", () => {
        const markup = render(withSubtitles(), "editor-subtitle-row-width");
        const row = divSlice(markup, "data-edit-subtitle-track");
        const open = row.slice(0, row.indexOf(">") + 1);

        // 横向内边距 / 外边距会挪动百分比定位的原点；overflow 会多出一条从自己宽度里扣像素的滚动条。
        expect(open).not.toMatch(/(?:^|[\s"])(?:p[lr]-|px-|m[lr]-|mx-|border-l|overflow|max-h-)/);
        // 唯一的纵向滚动仍然只在包住全部时间定位元素的那一个容器上。
        expect(occurrences(markup, "data-edit-timeline-scroll")).toBe(1);
        const scroller = markup.match(/<div data-edit-timeline-scroll[^>]*>/)?.[0] ?? "";
        expect(scroller).toContain(FROZEN_SCROLLER_CLASS);
        expect(scroller).toContain("scrollbar-gutter:stable");
        // 标尺 / 片段条 / 波形条 / 播放头 / 字幕块全都在共享容器里（切片到播放头为止）。
        const from = markup.indexOf("data-edit-timeline-scroll");
        const end = markup.indexOf(">", markup.indexOf("data-edit-playhead")) + 1;
        const inner = markup.slice(from, end);
        expect(occurrences(inner, 'data-edit-clip="')).toBe(occurrences(markup, 'data-edit-clip="'));
        expect(occurrences(inner, 'data-edit-subtitle-block="')).toBe(occurrences(markup, 'data-edit-subtitle-block="'));
        expect(occurrences(inner, 'data-edit-waveform-strip="')).toBe(occurrences(markup, 'data-edit-waveform-strip="'));
    });

    it("时间线高度没有为了字幕行加高：预览区照旧 flex-1 吃剩余空间（字幕行在滚动区里占位）", () => {
        const markup = render(withSubtitles(), "editor-subtitle-height");
        const area = markup.match(/<div data-edit-area="timeline"[^>]*>/)?.[0] ?? "";

        expect(area).toContain("h-[214px]");
        expect(area).toContain("shrink-0");
        expect(markup.match(/<div data-edit-area="preview"[^>]*>/)?.[0] ?? "").toContain("flex-1");
        // 字幕行确实是在那个滚动区**里面**（多出来的一行只花滚动区的高度，不动时间线的固定高度）。
        expect(markup.indexOf("data-edit-subtitle-track")).toBeGreaterThan(markup.indexOf("data-edit-timeline-scroll"));
    });
});
