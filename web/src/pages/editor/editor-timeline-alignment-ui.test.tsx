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
