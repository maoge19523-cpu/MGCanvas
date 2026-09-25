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

import { EDIT_DEFAULT_OUTPUT, type EditClip, type EditProject } from "@/types/edit";
import { timelinePlacements, timeToPercent } from "@/lib/timeline-scale";
import { useEditStore } from "@/stores/use-edit-store";
import { useAssetStore } from "@/stores/use-asset-store";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-timeline-alignment");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

// 10 段不等长（合计 60s）：等长会让「百分比」看起来都对，不等长才验得出一套换算。
const LENGTHS = [7, 3, 5, 11, 2, 6, 4, 8, 9, 5];
const TOTAL = LENGTHS.reduce((sum, length) => sum + length, 0);

function demo(clips: EditClip[]): EditProject {
    return {
        id: "edit-align",
        name: "对齐核查",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T03:04:00.000Z",
        media: [
            { id: "m1", name: "长视频.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 100000, createdAt: "2024-01-01T00:00:00.000Z" },
            { id: "m3", name: "背景乐.mp3", kind: "audio", source: "local", url: "blob:m3", durationMs: 20000, createdAt: "2024-01-01T00:00:00.000Z" },
        ],
        audioTracks: [{ id: "t1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false }],
        output: { ...EDIT_DEFAULT_OUTPUT },
        clips,
    };
}

const CLIPS: EditClip[] = LENGTHS.map((length, index) => ({ id: `c${index + 1}`, mediaId: "m1", start: 0, end: length, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 }));

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

/** 从产物里读出每个片段条的内联 left/width（真实渲染出来的百分比，不经过任何中间态）。 */
function readClips(markup: string) {
    return [...markup.matchAll(/data-edit-clip="([^"]+)"[^>]*style="left:([-\d.eE+]+)%;width:([-\d.eE+]+)%/g)].map((match) => ({ id: match[1]!, left: Number(match[2]), width: Number(match[3]) }));
}

/** 从产物里读出每个标尺刻度的内联 left（刻度按 0、10、20… 依次生成）。 */
function readTicks(markup: string) {
    return [...markup.matchAll(/style="left:([-\d.eE+]+)%;transform:(?:none|translateX\(-50%\))"[\s\S]{0,200}?tabular-nums/g)].map((match) => Number(match[1]));
}

function readWaveformWidths(markup: string) {
    return [...markup.matchAll(/data-edit-waveform-strip="[^"]+"[^>]*style="width:([-\d.eE+]+)%/g)].map((match) => Number(match[1]));
}

/** 读出每条波形条的内联 left / width（都是「秒数 / 总秒数」的百分比）；left 缺省时按 0 处理。 */
function readWaveformStrips(markup: string) {
    return [...markup.matchAll(/data-edit-waveform-strip="([^"]+)"[^>]*style="width:([-\d.eE+]+)%(?:;left:([-\d.eE+]+)%)?"/g)].map((match) => ({ id: match[1]!, width: Number(match[2]), left: match[3] === undefined ? 0 : Number(match[3]) }));
}

/** 波形条那一段真实的内联样式字符串（用来逐字核对「起点为 0 时连 left 都不写」）。 */
function waveformStyle(markup: string, id: string) {
    return markup.match(new RegExp(`data-edit-waveform-strip="${id}"[^>]*style="([^"]*)"`))?.[1] ?? "";
}

describe("剪辑台时间线：片段条与标尺 / 播放头 / 波形共用同一套换算（真实产物读回）", () => {
    it("每条片段条的 left / width 就是「秒数 / 总秒数」的百分比，第 k 段右边缘 == 前 k 段时长之和", () => {
        const markup = render(demo(CLIPS), "editor-timeline-alignment");
        const clips = readClips(markup);
        const expected = timelinePlacements(LENGTHS, TOTAL);

        expect(clips.map((clip) => clip.id)).toEqual(CLIPS.map((clip) => clip.id));
        clips.forEach((clip, index) => {
            expect(clip.left).toBeCloseTo(expected[index]!.left, 12);
            expect(clip.width).toBeCloseTo(expected[index]!.width, 12);
            // 累积误差为 0：右边缘严格等于「前 k 段时长之和」换算出来的位置。
            expect(clip.left + clip.width - timeToPercent(LENGTHS.slice(0, index + 1).reduce((sum, length) => sum + length, 0), TOTAL)).toBeLessThan(1e-9);
        });
        // 最后一段的右边缘落在 100%（成片末尾），不多不少。
        expect(clips[clips.length - 1]!.left + clips[clips.length - 1]!.width).toBeCloseTo(100, 12);
        // 相邻片段严丝合缝：中间没有任何被间隙吃掉的像素。
        for (let index = 1; index < clips.length; index += 1) expect(clips[index - 1]!.left + clips[index - 1]!.width).toBeCloseTo(clips[index]!.left, 12);
    });

    it("标尺刻度与波形条用的是同一条换算：第 10 秒的刻度与第 2 段的右边缘重合，第 20 秒的刻度等于 20s 波形的条宽", () => {
        const markup = render(demo(CLIPS), "editor-timeline-alignment-cross");
        const clips = readClips(markup);
        const ticks = readTicks(markup);
        const waveforms = readWaveformWidths(markup);

        // 总时长 60s → 刻度步长 10s，刻度依次是 0、10、20、30、40、50。
        expect(ticks.length).toBe(6);
        ticks.forEach((left, index) => expect(left).toBeCloseTo(timeToPercent(index * 10, TOTAL), 12));
        // 前两段 7s + 3s = 10s：第 2 段的右边缘必须与「10」这条刻度重合（前者由片段条换算，后者由标尺换算）。
        expect(ticks[1]).toBeCloseTo(clips[1]!.left + clips[1]!.width, 12);
        // 音轨 20s（不循环）在 60s 成片里占 1/3：条宽等于「20」刻度所在的位置。
        expect(waveforms).toEqual([Number(timeToPercent(20, TOTAL).toFixed(14))]);
        expect(waveforms[0]).toBeCloseTo(ticks[2]!, 12);
    });

    it("视觉分隔仍然存在：外框按时间占位，缝由片段内部内缩 2px 的内层色块留出", () => {
        const markup = render(demo(CLIPS), "editor-timeline-alignment-seam");

        // 每条片段一个内层色块：外框（含边框）严格落在时间位置上，色块在片段内部左右各内缩 2px。
        const seams = markup.match(/pointer-events-none absolute inset-y-0 left-\[2px\] right-\[2px\] rounded-\[6px\]/g) ?? [];
        expect(seams.length).toBe(LENGTHS.length);
        // 片段条本身不再用 flex 分配宽度（那正是把 gap 像素算进宽度的写法）。
        expect(markup).not.toContain("flex: ");
    });

    it("素材没探测到时长的片段仍有可抓取的最小宽度，但它不推动别的片段（左边缘仍是 0%、宽度仍是 0%）", () => {
        const markup = render(
            demo([
                { id: "c1", mediaId: "m1", start: 0, end: 4, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
                { id: "gone", mediaId: "missing", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
                { id: "c2", mediaId: "m1", start: 0, end: 5, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
            ]),
            "editor-timeline-alignment-degraded",
        );
        const clips = readClips(markup);

        expect(clips.map((clip) => [clip.left, clip.width])).toEqual([
            [0, timeToPercent(4, 9)],
            [timeToPercent(4, 9), 0],
            [timeToPercent(4, 9), timeToPercent(5, 9)],
        ]);
        // 零宽度的那一条带 min-width，仍然能点中 / 拖住；左右邻居的位置不受它影响。
        const zero = markup.match(/<div data-edit-clip="gone"[^>]*>/)?.[0] ?? "";
        expect(zero).toContain("min-width:14px");
        expect(zero).toContain(`width:0%`);
        // 正常片段没有最小宽度（否则会破坏「右边缘严格落在时间位置上」）。
        expect(markup.match(/<div data-edit-clip="c1"[^>]*>/)?.[0] ?? "").not.toContain("min-width");
    });
});

/** 音轨数量是这条缺陷的唯一开关：0 / 1 条时音轨行不滚动（看起来完全正常），≥3 条才出现那条吃宽度的滚动条。 */
const TRACK_COUNTS = [0, 1, 3, 5, 10];

function withTracks(count: number): EditProject {
    return { ...demo(CLIPS), audioTracks: Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}`, mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false })) };
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("剪辑台时间线：音轨数量变化时，波形条与标尺 / 片段条 / 播放头仍摊在同一个可定位宽度上（真实产物读回）", () => {
    it("音轨 0 / 1 / 3 / 5 / 10 条：音轨行不再自带滚动条，纵向滚动只在包住全部时间定位元素的容器上", () => {
        for (const count of TRACK_COUNTS) {
            const markup = render(withTracks(count), `editor-timeline-width-${count}`);

            // 1) 音轨行自己不再是滚动容器：滚动条只会从**它自己**的宽度里扣像素，而标尺 / 片段条不会——
            //    这正是「波形条比标尺窄 6~15px」的根因，所以这一行不允许出现 overflow 与 max-h。
            const row = markup.match(/<div data-edit-audio-track[^>]*>/)?.[0] ?? "";
            expect(row).toContain("data-edit-audio-track");
            expect(row).not.toMatch(/overflow/);
            expect(row).not.toMatch(/max-h-/);
            expect(row).not.toContain("width:");

            // 2) 唯一的纵向滚动在共享容器上：固定预留滚动条槽（宽度不随音轨数量跳），并挡住横向溢出
            //    （标尺末端刻度是 left:100% + translateX(-50%)，标签会向右悬挑，否则会凭空多一条横向滚动条）。
            const scroller = markup.match(/<div data-edit-timeline-scroll[^>]*>/)?.[0] ?? "";
            expect(scroller).toContain("overflow-y-auto");
            expect(scroller).toContain("overflow-x-hidden");
            expect(scroller).toContain("scrollbar-gutter:stable");
            expect(occurrences(markup, "data-edit-timeline-scroll")).toBe(1);
            // 时间线所在的区域本身也不再套一层滚动（否则标题栏与快捷键行会跟着滚走）。
            expect(markup.match(/<div data-edit-area="timeline"[^>]*>/)?.[0] ?? "").not.toMatch(/overflow-y/);

            // 3) 标尺刻度、片段条、波形条、播放头一个都不落在共享容器之外（切片到播放头为止）。
            const from = markup.indexOf("data-edit-timeline-scroll");
            const end = markup.indexOf(">", markup.indexOf("data-edit-playhead")) + 1;
            const inner = markup.slice(from, end);
            const outer = markup.slice(end);
            expect(occurrences(inner, 'data-edit-clip="')).toBe(occurrences(markup, 'data-edit-clip="'));
            expect(occurrences(inner, 'data-edit-waveform-strip="')).toBe(count);
            expect(occurrences(markup, 'data-edit-waveform-strip="')).toBe(count);
            expect(occurrences(inner, "translateX(-50%)")).toBe(occurrences(markup, "translateX(-50%)"));
            expect(occurrences(outer, 'data-edit-clip="')).toBe(0);
            expect(occurrences(outer, 'data-edit-waveform-strip="')).toBe(0);
            expect(occurrences(outer, "translateX(-50%)")).toBe(0);
        }
    });

    it("音轨 5 条时的真实产物：音轨行只剩间隙，波形条宽度只有百分比、没有像素宽度（同一份产物落盘读回）", () => {
        const markup = render(withTracks(5), "editor-timeline-width-5-evidence");
        const row = markup.match(/<div data-edit-audio-track[^>]*>/)?.[0] ?? "";

        // 纯函数测试里的 36px 条高 / 4px 间隙就是这两处类名：改这里必须同步改那条模型。
        expect(row).toContain("gap-1");
        expect(row).toContain("flex-col");
        expect(occurrences(markup, 'class="relative h-9 shrink-0 overflow-hidden rounded-[8px]')).toBe(5);

        // 每条波形条只有「秒数 / 总秒数」的百分比宽度（相对共享容器），没有任何像素宽度与自己的滚动容器。
        const strips = [...markup.matchAll(/data-edit-waveform-strip="([^"]+)"[^>]*style="width:([-\d.eE+]+)%/g)];
        expect(strips.map((match) => match[1])).toEqual(["t1", "t2", "t3", "t4", "t5"]);
        for (const strip of strips) expect(Number(strip[2])).toBeCloseTo(Number(timeToPercent(20, TOTAL).toFixed(14)), 12);
        expect(occurrences(markup, 'data-edit-waveform-strip="t1"')).toBe(1);
        // 波形条外框（h-9 那一层）只有裁圆角的 overflow-hidden：没有 overflow-y-auto，也就没有会吃掉宽度的滚动条。
        const boxes = [...markup.matchAll(/<div class="relative h-9[^"]*"[^>]*>/g)].map((match) => match[0]);
        expect(boxes.length).toBe(5);
        for (const box of boxes) {
            expect(box).toContain("overflow-hidden");
            expect(box).not.toMatch(/overflow-y|overflow-auto|max-h-/);
        }
    });
});

/**
 * 取出带某个 data 属性的那个 `<div>` 的完整内容：从它的开标签起，按 `<div>` / `</div>` 逐层配对到深度归零。
 * 用它判断两个元素是不是**真的在同一个行容器里**——直接切片到下一个标记只能证明先后顺序，证明不了父子关系；
 * 改动前视频轨头独占一个 `h-5` 的空行（片段行是它的下一个兄弟），这里取出来的内容里一条片段都找不到。
 */
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
        } else {
            depth += 1;
        }
    }
    throw new Error(`${marker} 所在的 <div> 没有配对的 </div>`);
}

/** 取出带某个属性的那一个真实标签（属性只可能出现在标签内部）。 */
function headTag(text: string, marker: string) {
    const at = text.indexOf(marker);
    expect(at, `产物里找不到 ${marker}`).toBeGreaterThan(-1);
    return text.slice(text.lastIndexOf("<", at), text.indexOf(">", at));
}

/** 两类轨道头共用的定位类名：都从行容器左边缘的 left-1 起算、垂直居中——这是「竖直对齐成一列」的实现。 */
const TRACK_HEAD_POSITION = "absolute left-1 top-1/2 z-10 flex -translate-y-1/2 items-center";

describe("剪辑台时间线：视频轨轨道头挪进片段行，与音轨头左缘对齐成一列（真实产物读回）", () => {
    it("视频轨头与片段条在同一个行容器里：片段行就是视频轨行，不再为轨道头单独占一行", () => {
        const markup = render(demo(CLIPS), "editor-timeline-video-head-row");
        const row = divSlice(markup, "data-edit-video-track");

        // 行容器 = 片段行：轨道头与**全部**片段条都在它里面（改动前轨道头在独立的 h-5 行里，这两条都会失败）。
        expect(row).toContain("data-edit-video-track-head");
        expect(occurrences(row, 'data-edit-clip="')).toBe(LENGTHS.length);
        expect(occurrences(row, 'data-edit-clip="')).toBe(occurrences(markup, 'data-edit-clip="'));
        // 容器自己就是定位上下文（relative），高度就是片段行那 48px；轨道头独占的 mt-0.5 h-5 那一行已经不存在。
        const open = row.slice(0, row.indexOf(">") + 1);
        expect(open).toContain("relative");
        expect(open).toContain("h-12");
        expect(open).not.toContain("h-5");
        expect(markup).not.toContain("relative mt-0.5 h-5");
        // 轨道头写在片段之前，并且是行内的浮层（absolute），不是撑开宽度的一列。
        expect(row.indexOf("data-edit-video-track-head")).toBeLessThan(row.indexOf('data-edit-clip="'));
        const head = headTag(row, "data-edit-video-track-head");
        expect(head).toContain("absolute");
        expect(head).not.toMatch(/flex-1|w-full|w-\[|basis-/);

        // 少了一整行，时间线容器高度同比减 22px（mt-0.5 + h-5）：236 → 214，滚动区可用高度与改动前逐像素相同。
        const area = markup.match(/<div data-edit-area="timeline"[^>]*>/)?.[0] ?? "";
        expect(area).toContain("h-[214px]");
        expect(area).not.toContain("h-[236px]");
        // 预览区是 flex-1 吃剩余空间、时间线是 shrink-0 的固定高度：减掉的 22px 全部归预览区，不可能被挤没。
        expect(markup.match(/<div data-edit-area="preview"[^>]*>/)?.[0] ?? "").toContain("flex-1");
        expect(area).toContain("shrink-0");
    });

    it("片段条没有被轨道头挤窄：仍是「秒数 / 总秒数」的百分比定位，行容器也没有会挪动定位原点的内边距", () => {
        const markup = render(demo(CLIPS), "editor-timeline-video-head-width");
        const row = divSlice(markup, "data-edit-video-track");
        const open = row.slice(0, row.indexOf(">") + 1);
        const clips = readClips(markup);
        const expected = timelinePlacements(LENGTHS, TOTAL);

        // 行容器不带横向内边距 / 外边距 / 左边框：轨道头是行内唯一的左端元素，且它 absolute 不占宽度，
        // 所以片段条的百分比原点仍是容器左边缘（这一条与音轨行的约束完全一致）。
        expect(open).not.toMatch(/(?:^|[\s"])(?:p[lrx]?-|m[lrx]?-|border-l)/);
        // 第一段仍从 0% 起、宽度就是它自己的时长占比：轨道头没有把它顶开、也没有从它身上扣宽度。
        expect(clips[0]!.left).toBe(0);
        clips.forEach((clip, index) => {
            expect(clip.left).toBeCloseTo(expected[index]!.left, 12);
            expect(clip.width).toBeCloseTo(expected[index]!.width, 12);
        });
        expect(clips[clips.length - 1]!.left + clips[clips.length - 1]!.width).toBeCloseTo(100, 12);
        // 片段条的内联尺寸只有纯百分比：没有因为轨道头而长出像素宽度 / calc 偏移。
        const tags = markup.match(/<div data-edit-clip="[^"]*"[^>]*>/g) ?? [];
        expect(tags.length).toBe(LENGTHS.length);
        for (const tag of tags) {
            expect(tag).toMatch(/style="left:[-\d.eE+]+%;width:[-\d.eE+]+%/);
            expect(tag).not.toContain("calc(");
        }
        // 遮挡取舍落在「第一段片段的文字起点」上：只有它内缩让开轨道头，片段条本身一个像素没动。
        expect(row).toContain("pl-[76px]");
    });

    it("视频轨头与每条音轨头共用同一套定位类名，左缘因此落在同一条竖线上", () => {
        const markup = render(withTracks(2), "editor-timeline-track-head-column");
        const videoRow = divSlice(markup, "data-edit-video-track");
        const audioRow = divSlice(markup, "data-edit-audio-track");

        expect(headTag(videoRow, "data-edit-video-track-head")).toContain(TRACK_HEAD_POSITION);
        for (const id of ["t1", "t2"]) {
            expect(headTag(audioRow, `data-edit-track-head="${id}"`)).toContain(TRACK_HEAD_POSITION);
        }
        // 两个行容器都在同一个共享可定位容器里，且都没有横向内边距：left-1 落到的就是同一个 x。
        expect(markup.indexOf("data-edit-video-track")).toBeGreaterThan(markup.indexOf("data-edit-timeline-scroll"));
        expect(audioRow.slice(0, audioRow.indexOf(">") + 1)).not.toMatch(/(?:^|[\s"])(?:p[lrx]?-|m[lrx]?-|border-l)/);
        expect(divSlice(markup, "data-edit-timeline-scroll")).toContain("data-edit-video-track");
    });
});

/**
 * 音轨左右拖动改起点：波形条的左边缘必须按「起点 / 成片总长」推到时间位置上，
 * 而且仍与标尺刻度、片段条、播放头摊在**同一个可定位宽度**里（这条前提上已经出过两次偏移事故）。
 */
describe("剪辑台时间线：音轨起点推动波形条，换算仍与标尺同源（真实产物读回）", () => {
    const withStarts = (starts: Array<number | undefined>): EditProject => ({
        ...demo(CLIPS),
        audioTracks: starts.map((start, index) => ({ id: `t${index + 1}`, mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, start })),
    });

    it("start > 0 时 left 就是「起点 / 成片总长」，宽度是起点之后还能进成片的那一段", () => {
        const markup = render(withStarts([3, undefined]), "editor-track-start-offset");
        const strips = readWaveformStrips(markup);

        expect(strips.map((strip) => strip.id)).toEqual(["t1", "t2"]);
        // 60s 成片 + 20s 音轨：起点 3s ⇒ left 5%、宽仍是 20s 那一份（起点之后还剩 57s，音频只有 20s）。
        expect(strips[0]!.left).toBeCloseTo(timeToPercent(3, TOTAL), 12);
        expect(strips[0]!.width).toBeCloseTo(timeToPercent(20, TOTAL), 12);
        // 缺省起点（t2）连 left 都不写：产物与改动前逐字一致。
        expect(waveformStyle(markup, "t2")).toBe(`width:${timeToPercent(20, TOTAL)}%`);
        expect(strips[1]!.left).toBe(0);
    });

    it("起点为 0 与缺省同口径：产物里同样不出现 left（老项目读进来逐字不变）", () => {
        const markup = render(withStarts([0]), "editor-track-start-zero");

        expect(waveformStyle(markup, "t1")).toBe(`width:${timeToPercent(20, TOTAL)}%`);
        expect(readWaveformStrips(markup)[0]!.left).toBe(0);
    });

    it("波形条的 left 与标尺同一条换算：起点 30s 的条左缘正好落在「30」这条刻度上", () => {
        const markup = render(withStarts([30]), "editor-track-start-tick");
        const ticks = readTicks(markup);
        const strip = readWaveformStrips(markup)[0]!;

        // 总时长 60s → 刻度步长 10s：刻度依次是 0、10、20、30、40、50。
        expect(ticks.map((left) => Number(left.toFixed(6)))).toEqual([0, 10, 20, 30, 40, 50].map((seconds) => Number(timeToPercent(seconds, TOTAL).toFixed(6))));
        expect(strip.left).toBeCloseTo(ticks[3]!, 9);
        expect(strip.left).not.toBeCloseTo(timeToPercent(0, TOTAL), 9);
    });

    it("音频比视频长也只画到成片末尾：left + width 恰好落在 100%，不会超出共用的定位宽度", () => {
        // 20s 音频放进 60s 成片：起点 50s ⇒ 只剩 10s 能进成片（amix 是 duration=first，超出部分本来就被截断）。
        const markup = render(withStarts([50]), "editor-track-start-tail");
        const strip = readWaveformStrips(markup)[0]!;

        expect(strip.left).toBeCloseTo(timeToPercent(50, TOTAL), 12);
        expect(strip.width).toBeCloseTo(timeToPercent(10, TOTAL), 12);
        expect(strip.left + strip.width).toBeCloseTo(100, 9);
    });

    it("起点落在上界（成片末尾）时条宽为 0，但整行仍是拖动入口：不会出现「拖过去就拿不回来」", () => {
        const markup = render(withStarts([TOTAL]), "editor-track-start-limit");
        const strip = readWaveformStrips(markup)[0]!;
        const row = divSlice(markup, 'data-edit-track-row="t1"');

        expect(strip.left).toBeCloseTo(100, 12);
        expect(strip.width).toBe(0);
        // 拖到最右端后波形条缩成 0 宽，所以拖动面是**整行**（轨道头是浮层、不占宽度），行上带抓取光标。
        expect(row).toContain("cursor-grab");
        expect(row).toContain('data-edit-waveform-strip="t1"');
    });

    it("波形条仍在与标尺 / 片段条 / 播放头同一个可定位宽度里：行容器没有会把 left 原点推开的横向内边距", () => {
        const markup = render(withStarts([3]), "editor-track-start-shared-width");
        const row = divSlice(markup, 'data-edit-track-row="t1"');
        const scroller = divSlice(markup, "data-edit-timeline-scroll");

        // 行容器不带横向内边距 / 外边距 / 左边框：left% 的原点就是共享容器的左边缘（与片段行同一约束）。
        expect(row.slice(0, row.indexOf(">") + 1)).not.toMatch(/(?:^|[\s"])(?:p[lrx]?-|m[lrx]?-|border-l)/);
        // 行与波形条都在唯一那个（带 scrollbar-gutter: stable 的）滚动容器里，和播放头同一个定位宽度。
        expect(scroller).toContain('data-edit-track-row="t1"');
        expect(scroller).toContain("data-edit-playhead");
        expect(scroller).toContain('data-edit-clip="');
    });

    it("锁定的音轨渲染成「拖不动」：not-allowed 光标 + 锁定提示，且没有抓取光标", () => {
        const markup = render({ ...demo(CLIPS), audioTracks: [{ id: "t1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, locked: true, start: 3 }] }, "editor-track-start-locked");
        const locked = divSlice(markup, 'data-edit-track-row="t1"');

        expect(locked).toContain("cursor-not-allowed");
        expect(locked).not.toContain("cursor-grab");
        // 提示里说清楚为什么拖不动（与其它编辑入口同一句文案），不是静默失效。
        expect(locked).toContain("锁定这条轨");

        // 对照：没锁定的那条轨是可拖的，提示改成「左右拖动这一行…」。
        const unlocked = render(withStarts([3]), "editor-track-start-unlocked");
        const draggable = divSlice(unlocked, 'data-edit-track-row="t1"');
        expect(draggable).toContain("cursor-grab");
        expect(draggable).not.toContain("cursor-not-allowed");
        expect(draggable).toContain("左右拖动这一行改变这条音轨的起点");
        // 起点非 0 时行提示里带上读数，松开鼠标前也能知道落在了第几秒。
        expect(draggable).toContain("起点 0:03.0");
    });
});
