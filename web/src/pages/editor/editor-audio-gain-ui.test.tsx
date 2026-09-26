import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { App, ConfigProvider, theme as antdTheme } from "antd";
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

import { getAntThemeConfig } from "@/lib/app-theme";
import { EDIT_GAIN_AREA_FILL_OPACITY } from "@/lib/edit/audio-gain";
import { useAssetStore } from "@/stores/use-asset-store";
import { useEditStore } from "@/stores/use-edit-store";
import { EDIT_DEFAULT_OUTPUT, type EditAudioTrack, type EditProject } from "@/types/edit";
import { PRE_GAIN_BASE_ROW, PRE_GAIN_MUTED_ROW, PRE_GAIN_OFFSET_ROW, PRE_GAIN_VIDEO_ROW } from "./__fixtures__/timeline-pre-gain-overlay";
import EditProjectPage from "./project";

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-audio-gain");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

/**
 * 视频 4s + 5s = 成片 9 秒（标尺刻度 0/2/4/6/8）。音轨素材刻意两种：
 * m3 = 20 秒（比成片长，铺满起点之后的剩余时长）、m4 = 3 秒（比成片短，够验「淡入比音轨长」）。
 * 这份 DEMO 与 __fixtures__/timeline-pre-gain-overlay.ts 冻结改动前产物时用的完全同一份，
 * 否则「逐字未变」的比对就没有意义。
 */
const DEMO: EditProject = {
    id: "edit-gain",
    name: "音量与淡入淡出",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T03:04:00.000Z",
    media: [
        { id: "m1", name: "开场.mp4", kind: "video", source: "local", url: "blob:m1", durationMs: 6000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m2", name: "画布成片.mp4", kind: "video", source: "canvas", url: "asset://localhost/x.mp4", durationMs: 5000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m3", name: "背景乐.mp3", kind: "audio", source: "local", url: "blob:m3", durationMs: 20000, createdAt: "2024-01-01T00:00:00.000Z" },
        { id: "m4", name: "音效.wav", kind: "audio", source: "local", url: "blob:m4", durationMs: 3000, createdAt: "2024-01-01T00:00:00.000Z" },
    ],
    clips: [
        { id: "c1", mediaId: "m1", start: 0, end: 4, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
        { id: "c2", mediaId: "m2", start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, transitionDuration: 0.5 },
    ],
    audioTracks: [],
    subtitles: [{ id: "s1", start: 1, end: 3, text: "第一句" }],
    output: { ...EDIT_DEFAULT_OUTPUT },
};

/** 冻结改动前产物时用的那两条轨（t1 正常、t2 静音 + 音量 50% + 淡入淡出）。 */
const TRACKS_BASE: EditAudioTrack[] = [
    { id: "t1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
    { id: "t2", mediaId: "m3", volume: 0.5, fadeIn: 1, fadeOut: 2, loop: false, muted: true },
];

/** 冻结改动前产物时用的那条轨：起点偏移 2 秒 + 锁定。 */
const TRACKS_OFFSET: EditAudioTrack[] = [{ id: "t3", mediaId: "m3", volume: 0.75, fadeIn: 1.5, fadeOut: 3, loop: false, start: 2, locked: true }];

function demo(tracks: EditAudioTrack[]): EditProject {
    return { ...DEMO, audioTracks: tracks };
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

/**
 * 带**应用真实主题**（lib/app-theme 的 getAntThemeConfig）的渲染：浅色 / 深色各来一份。
 * 默认那份 render 走的是 antd 的缺省主题（colorPrimary 是蓝色 #1677ff），而应用把主色改成了中性色
 * （浅色 #171717 / 深色 #d8d8d8）——「颜色太重盖住波形」那次事故**只在真实主题下才看得出来**：
 * colorPrimaryBg 在中性主色下派生出来的是 #575757 / #595959 这种实心中灰，而不是缺省主题下的浅蓝 #e6f4ff。
 * 所以凡是与「叠加层的颜色 / 不透明度」有关的断言，都必须在这两套真实主题下各跑一遍。
 */
function renderThemed(project: EditProject, name: string, dark: boolean) {
    useEditStore.setState({ hydrated: true, projects: [project], history: {} });
    useAssetStore.setState({ assets: [], hydrated: true });
    return dump(
        name,
        renderToStaticMarkup(
            <ConfigProvider theme={getAntThemeConfig(dark)}>
                <App>
                    <MemoryRouter initialEntries={[`/editor/${project.id}`]}>
                        <Routes>
                            <Route path="/editor/:id" element={<EditProjectPage />} />
                        </Routes>
                    </MemoryRouter>
                </App>
            </ConfigProvider>,
        ),
    );
}

/** 截出某个标记所在的那个 <div> 子树（含它自己的闭合标签）：产物读回都用它，不靠正则碰运气。 */
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
    throw new Error(`${marker} 所在的 div 没有闭合`);
}

/** 某个标记所在元素的**开始标签**（属性都在里面）。 */
function tagOf(markup: string, marker: string) {
    const at = markup.indexOf(marker);
    expect(at, `产物里找不到 ${marker}`).toBeGreaterThan(-1);
    const start = markup.lastIndexOf("<", at);
    const end = markup.indexOf(">", at);
    return markup.slice(start, end + 1);
}

function styleOf(tag: string) {
    return tag.match(/style="([^"]*)"/)?.[1] ?? "";
}

function attrOf(tag: string, name: string): string | null {
    return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
}

/** 折线 / 面积的 points 属性 → 坐标数组（x 是轨道宽度的百分比，y 是行高的百分比）。 */
function pointsOf(tag: string) {
    const raw = attrOf(tag, "points") ?? "";
    return raw ? raw.split(" ").map((pair) => pair.split(",").map(Number) as [number, number]) : [];
}

function readClips(markup: string) {
    return [...markup.matchAll(/data-edit-clip="[^"]+"[^>]*style="([^"]*)"/g)].map((match) => match[1]);
}

function readTicks(markup: string) {
    return [...markup.matchAll(/style="left:([-\d.eE+]+)%;transform:(?:none|translateX\(-50%\))"[\s\S]{0,200}?tabular-nums/g)].map((match) => Number(match[1]));
}

function readSubtitles(markup: string) {
    return [...markup.matchAll(/data-edit-subtitle-block="[^"]+"[^>]*style="([^"]*)"/g)].map((match) => match[1]);
}

/** 元素类名里的 z-index（`z-[2]` 与 `z-10` 两种写法都认）；没写 z-index 记 0（auto，等于「按 DOM 顺序画」）。 */
function zIndexOf(tag: string) {
    const match = tag.match(/z-(?:\[(\d+)\]|(\d+))(?![\w-])/);
    return match ? Number(match[1] ?? match[2]) : 0;
}

/** #rrggbb → 三个 0..255 的通道。 */
function channels(hex: string) {
    const value = hex.replace("#", "");
    const full = value.length === 3 ? [...value].map((item) => item + item).join("") : value;
    return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
}

/** 分层合成：上层色按其不透明度叠在底层色上（sRGB 直算，够用于「谁盖住谁」的量化）。 */
function over(top: string, alpha: number, bottom: string) {
    const front = channels(top);
    const back = channels(bottom);
    const mixed = front.map((value, index) => Math.round(value * alpha + back[index]! * (1 - alpha)));
    return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 2.x 相对亮度（0 = 黑、1 = 白）。 */
function luminance(hex: string) {
    const [red, green, blue] = channels(hex).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

/** WCAG 对比度（1 ~ 21）；1.4.11 要求「非文本的图形」对底色至少 3:1。 */
function contrast(left: string, right: string) {
    const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a);
    return (high! + 0.05) / (low! + 0.05);
}

describe("剪辑台时间线：音轨的音量线与淡入淡出坡度画出来了", () => {
    /** k1 100% / k2 50% / k3 静音 0% / k4 400% / k5 淡入淡出重叠 / k6 淡入比音轨长。 */
    const VARIANTS: EditAudioTrack[] = [
        { id: "k1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
        { id: "k2", mediaId: "m3", volume: 0.5, fadeIn: 0, fadeOut: 0, loop: false },
        { id: "k3", mediaId: "m3", volume: 0, fadeIn: 0, fadeOut: 0, loop: false },
        { id: "k4", mediaId: "m3", volume: 4, fadeIn: 0, fadeOut: 0, loop: false },
        { id: "k5", mediaId: "m3", volume: 1, fadeIn: 5, fadeOut: 8, loop: false },
        { id: "k6", mediaId: "m4", volume: 1, fadeIn: 5, fadeOut: 0, loop: false },
        // 3 秒素材 + 淡出 1 秒：坡度在音轨自己的末尾收住（导出却锚在成片末尾 → 成片里听不到）。
        { id: "k7", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 1, loop: false },
        // 3 秒素材 + 淡出 8 秒：整条轨都在淡出，导出的锚点比这里画出的起点晚 → 与画面不一致。
        { id: "k8", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 8, loop: false },
    ];

    it("音量 → 基准线高度：分贝映射（0 dB 在 75% 高度、400% 贴顶、0% 贴底）", () => {
        const markup = render(demo(VARIANTS), "editor-gain-height");
        const top = (id: string) => styleOf(tagOf(markup, `data-edit-track-volume="${id}"`)).match(/top:([-\d.eE+]+)%/)?.[1];

        // 26.5% = 3 + (1 − 0.75) × 94：0 dB 落在 75% 高度（行内上下各留 3% 余量）。
        expect(top("k1")).toBe("26.5");
        // 50% 是 −6.02 dB → (36 − 6.02) / 48 = 0.6246 → 38.29%。
        expect(top("k2")).toBe("38.29034149683927");
        // 0% 与 400% 分别贴底 / 贴顶（分贝映射的两端）。
        expect(top("k3")).toBe("97");
        expect(top("k4")).toBe("3");
        // 单调：更响的音量画得更高（50% < 100% < 400%）。
        expect(Number(top("k2"))).toBeGreaterThan(Number(top("k1")));
        expect(Number(top("k1"))).toBeGreaterThan(Number(top("k4")));
        // 读数就写在行右上角的徽标里，一眼能看出当前音量与分贝。
        expect(tagOf(markup, 'data-edit-track-volume-readout="k1"')).toContain(">");
        expect(markup).toContain("100% · 0.0 dB");
        expect(markup).toContain("400% · 12.0 dB");
        expect(markup).toContain("0% · -∞ dB");
    });

    it("基准线横跨的就是同一行波形条的那段秒数：left / width 逐个与波形条相同", () => {
        const markup = render(demo([...VARIANTS, ...TRACKS_OFFSET]), "editor-gain-span");

        for (const id of ["k1", "k2", "k5", "k6", "t3"]) {
            const strip = tagOf(markup, `data-edit-waveform-strip="${id}"`);
            const line = tagOf(markup, `data-edit-track-volume="${id}"`);
            // 波形条起点为 0 时不写 left（回落到 left-0 类名），音量线始终两条边都写：缺省按 0% 对齐。
            expect(styleOf(line).match(/left:([-\d.eE+]+)%/)?.[1] ?? "0").toBe(styleOf(strip).match(/left:([-\d.eE+]+)%/)?.[1] ?? "0");
            expect(styleOf(line).match(/width:([-\d.eE+]+)%/)?.[1]).toBe(styleOf(strip).match(/width:([-\d.eE+]+)%/)?.[1]);
        }
        // 3 秒素材那条轨：条与线都只占 3/9。
        expect(styleOf(tagOf(markup, 'data-edit-track-volume="k6"'))).toContain("width:33.33333333333333%");
        expect(styleOf(tagOf(markup, 'data-edit-track-volume="k6"'))).toContain("left:0%");
    });

    it("淡入淡出为 0 时不画坡度：折线只有两个点、两点都落在音量线的高度上", () => {
        const markup = render(demo(VARIANTS), "editor-gain-flat");

        for (const [id, height] of [["k1", "26.5"], ["k2", "38.29034149683927"], ["k3", "97"], ["k4", "3"]] as const) {
            const line = tagOf(markup, `data-edit-track-gain-line="${id}"`);
            const points = pointsOf(line);
            // 只有起点与终点两个点：既没有零宽坡度，也没有多余的折点。
            expect(points).toHaveLength(2);
            expect(points[0]).toEqual([0, Number(height)]);
            expect(points[1]).toEqual([100, Number(height)]);
            // 两点高度完全相同 = 整条折线没有斜率 = 与音量基准线重合（没有画任何淡变）。
            expect(points[0]![1]).toBe(points[1]![1]);
            expect(points[0]![1]).toBe(Number(styleOf(tagOf(markup, `data-edit-track-volume="${id}"`)).match(/top:([-\d.eE+]+)%/)?.[1]));
        }
        // 面积也退化成一个贴着折线的零高度矩形（没有多余的可见形状）。
        expect(attrOf(tagOf(markup, 'data-edit-track-gain-area="k1"'), "points")).toBe("0,26.5 100,26.5 100,97 0,97");
    });

    it("淡入淡出的坡度：起点 + 淡入秒数、终点 − 淡出秒数，且与标尺刻度同一把尺子", () => {
        const markup = render(demo(TRACKS_BASE), "editor-gain-ramp");
        const line = tagOf(markup, 'data-edit-track-gain-line="t2"');
        const points = pointsOf(line);

        // 9 秒成片：淡入 1 秒 = 11.11%，淡出 2 秒 → 从 7 秒（77.78%）起降到终点。
        expect(points).toEqual([
            [0, 97],
            [11.11111111111111, 38.29034149683927],
            [77.77777777777779, 38.29034149683927],
            [100, 97],
        ]);
        // 同一把尺子：折点的 x 必须能用标尺刻度（0/2/4/6/8 秒）量出来——1 秒是 2 秒刻度的一半，
        // 7 秒是 8 秒刻度往前半格。刻度一旦与折线用了两套换算，这两条立刻对不上。
        const ticks = readTicks(markup);
        expect(ticks).toEqual([0, 22.22222222222222, 44.44444444444444, 66.66666666666666, 88.88888888888889]);
        expect(points[1]![0] * 2).toBeCloseTo(ticks[1]!, 9);
        expect(points[2]![0]).toBeCloseTo(ticks[3]! + (ticks[4]! - ticks[3]!) / 2, 9);
        // 坡度两端的增益就是 0（导出里 afade 从 0 起）。
        expect(points[0]![1]).toBe(97);
        expect(points[3]![1]).toBe(97);
    });

    it("起点偏移：整条坡度用成片时间轴上的绝对秒数（淡入从起点起算、淡出到「起点 + 还能占的秒数」）", () => {
        const markup = render(demo(TRACKS_OFFSET), "editor-gain-offset");
        const points = pointsOf(tagOf(markup, 'data-edit-track-gain-line="t3"'));

        // 起点 2 秒（22.22%）+ 能占 7 秒（到 100%）：淡入 1.5 秒 → 3.5 秒（38.89%），
        // 淡出 3 秒 → 从 6 秒（66.67%）起降到 9 秒。
        expect(points).toEqual([
            [22.22222222222222, 97],
            [38.88888888888889, 31.393433850491746],
            [66.66666666666666, 31.393433850491746],
            [100, 97],
        ]);
        // 折线的左端与波形条的左边缘严格重合，右端同样落在 100%。
        expect(points[0]![0]).toBe(Number(styleOf(tagOf(markup, 'data-edit-waveform-strip="t3"')).match(/left:([-\d.eE+]+)%/)?.[1]));
        expect(points[3]![0]).toBe(100);
        // 75% 音量的高度（−2.5 dB → 31.39%）与基准线相同。
        expect(points[1]![1]).toBe(Number(styleOf(tagOf(markup, 'data-edit-track-volume="t3"')).match(/top:([-\d.eE+]+)%/)?.[1]));
    });

    it("淡入 + 淡出 超过音轨时长：标出重叠，曲线全段都到不了满音量", () => {
        const markup = render(demo(VARIANTS), "editor-gain-overlap");
        const svg = tagOf(markup, 'data-edit-track-gain="k5"');
        const points = pointsOf(tagOf(markup, 'data-edit-track-gain-line="k5"'));

        // 9 秒音轨区间 + 淡入 5 秒 + 淡出 8 秒 = 13 秒：两条坡度重叠。
        expect(attrOf(svg, "data-edit-track-gain-overlap")).toBe("true");
        expect(attrOf(svg, "data-edit-track-gain-fade-in")).toBe("5");
        expect(attrOf(svg, "data-edit-track-gain-fade-out")).toBe("8");
        // 折点 0/1/5/9 秒 + 重叠区 [1,5] 里的 5 个相乘采样点（秒数按 1e-6 取整后再换算成百分比）。
        expect(points).toHaveLength(9);
        expect(points.map((point) => point[0])).toEqual([0, 11.11111111111111, 18.518522222222224, 25.925922222222226, 33.33333333333333, 40.740744444444445, 48.14814444444444, 55.55555555555556, 100]);
        // 相乘之后全段都低于音量线的高度（26.5%）→ 这条轨在重叠区永远到不了满音量；
        // 最接近满音量的那一点（4.33 秒，乘积 0.506）比基准线矮了 11.6% 行高，曲线是真的被压下去了。
        for (const point of points) expect(point[1]).toBeGreaterThan(26.5);
        expect(Math.min(...points.map((point) => point[1]))).toBe(38.10238534409756);
        expect(Math.max(...points.map((point) => point[1]))).toBe(97);
        // 行提示里说清楚原因（不是默默画一条到不了顶的曲线）。
        expect(divSlice(markup, 'data-edit-track-row="k5"')).toContain("淡入 + 淡出 超过音轨时长");
    });

    it("淡入比音轨还长：坡度画到音轨边界为止，并在行提示里说明被截短", () => {        const markup = render(demo(VARIANTS), "editor-gain-clamped");
        const svg = tagOf(markup, 'data-edit-track-gain="k6"');
        const points = pointsOf(tagOf(markup, 'data-edit-track-gain-line="k6"'));

        // 3 秒素材 + 淡入 5 秒：画到 3 秒（33.33%）为止，不是一条画到轨外的线。
        expect(points).toEqual([
            [0, 97],
            [33.33333333333333, 26.5],
        ]);
        expect(attrOf(svg, "data-edit-track-gain-fade-in")).toBe("3");
        expect(divSlice(markup, 'data-edit-track-row="k6"')).toContain("淡入 / 淡出比这条音轨还长");
    });

    it("音轨比成片短时淡出仍收在音轨自己的末尾，并说明导出锚点与画面不一致（不静默画错）", () => {
        const markup = render(demo(VARIANTS), "editor-gain-anchor");

        // k7：3 秒音轨 + 淡出 1 秒 → 坡度从 2 秒（22.22%）降到 3 秒（33.33%），终点是音轨的末尾而不是成片末尾。
        const short = tagOf(markup, 'data-edit-track-gain="k7"');
        expect(pointsOf(tagOf(markup, 'data-edit-track-gain-line="k7"'))).toEqual([
            [0, 26.5],
            [22.22222222222222, 26.5],
            [33.33333333333333, 97],
        ]);
        // 导出的淡出锚点（成片末尾 − 1 秒 = 8 秒）在音频内容（3 秒）之后 → 成片里这段淡出根本不会发生。
        expect(attrOf(short, "data-edit-track-fade-out-anchor")).toBe("unheard");
        expect(divSlice(markup, 'data-edit-track-row="k7"')).toContain("这段淡出在成片里听不到");
        // 但画面仍然按「音轨能听见的那一段」画完整的淡出，而不是画一条落在轨外的线。
        expect(short).not.toContain("data-edit-track-gain-overlap");

        // k8：3 秒音轨 + 淡出 8 秒（超过音轨）→ 整条轨都在淡出；导出的锚点（1 秒）比画出的起点（0 秒）晚。
        expect(pointsOf(tagOf(markup, 'data-edit-track-gain-line="k8"'))).toEqual([
            [0, 26.5],
            [33.33333333333333, 97],
        ]);
        expect(attrOf(tagOf(markup, 'data-edit-track-gain="k8"'), "data-edit-track-fade-out-anchor")).toBe("shifted");
        expect(divSlice(markup, 'data-edit-track-row="k8"')).toContain("与这里画出的坡度起点");
        // 两条都没被误判成「一致」。
        expect(tagOf(markup, 'data-edit-track-gain="k1"')).not.toContain("data-edit-track-fade-out-anchor");
    });

    it("起点落在成片末尾之后：整块可视化不渲染（没有任何能进成片的秒数）", () => {
        const markup = render(demo([{ id: "b1", mediaId: "m3", volume: 1, fadeIn: 1, fadeOut: 1, loop: false, start: 9 }]), "editor-gain-beyond");
        const row = divSlice(markup, 'data-edit-track-row="b1"');

        expect(row).not.toContain("data-edit-track-gain");
        expect(row).not.toContain("data-edit-track-volume");
        // 但这一行仍在，波形条仍在（宽度 0、钉在 100%，可以左右拖回来），起点也仍在提示里。
        expect(row).toContain('data-edit-waveform-strip="b1"');
        expect(styleOf(tagOf(row, 'data-edit-waveform-strip="b1"'))).toBe("width:0%;left:100%");
        expect(row).toContain("起点 0:09.0");
    });

    it("静音 / 被独奏排除：折线与基准线都变虚线并变淡，读数一并变淡（不与正常轨看起来一样）", () => {
        // 分两次渲染：只要有任一轨独奏，其余未独奏的轨都会被排除，所以「正常出声」的对照不能和独奏同项目。
        const markup = render(demo([
            { id: "a1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
            { id: "a2", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, muted: true },
        ]), "editor-gain-muted");
        const soloed = render(demo([
            { id: "a3", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, solo: true },
            { id: "a4", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
        ]), "editor-gain-solo");

        for (const [source, id, note] of [[markup, "a2", "静音"], [soloed, "a4", "被其它轨独奏排除"]] as const) {
            const svg = tagOf(source, `data-edit-track-gain="${id}"`);
            expect(attrOf(svg, "data-edit-track-gain-audible")).toBe("false");
            expect(svg).toContain("opacity-50");
            expect(attrOf(tagOf(source, `data-edit-track-gain-line="${id}"`), "stroke-dasharray")).toBe("4 3");
            // 基准线也画成虚线，不是一条实心线。
            expect(divSlice(source, `data-edit-track-volume="${id}"`)).toContain("repeating-linear-gradient");
            // 读数也变淡（colorTextQuaternary 而不是 colorTextSecondary）。
            expect(styleOf(tagOf(source, `data-edit-track-volume-badge="${id}"`))).toContain("0.25");
            // 行尾仍写着它为什么不出声。
            expect(divSlice(source, `data-edit-track-row="${id}"`)).toContain(note);
            // 但音量线仍然可以拖：静音是监听状态，音量是混音参数（见组件里那段说明）。
            expect(tagOf(source, `data-edit-track-volume="${id}"`)).toContain("cursor-ns-resize");
        }
        // 对照：正常出声的那条轨既不是虚线、也不变淡、读数用正文色。
        expect(attrOf(tagOf(markup, 'data-edit-track-gain="a1"'), "data-edit-track-gain-audible")).toBe("true");
        expect(tagOf(markup, 'data-edit-track-gain="a1"')).not.toContain("opacity-50");
        expect(attrOf(tagOf(markup, 'data-edit-track-gain-line="a1"'), "stroke-dasharray")).toBeNull();
        expect(divSlice(markup, 'data-edit-track-volume="a1"')).not.toContain("repeating-linear-gradient");
        expect(styleOf(tagOf(markup, 'data-edit-track-volume-badge="a1"'))).toContain("0.65");
    });

    it("锁定：音量线不可拖（not-allowed / 不是滑块 / 不进 Tab 序列 / aria-disabled）", () => {
        const AUTDIBILITY: EditAudioTrack[] = [
            { id: "a1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
            { id: "a5", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, locked: true },
        ];
        const markup = render(demo(AUTDIBILITY), "editor-gain-locked");
        const locked = tagOf(markup, 'data-edit-track-volume="a5"');

        expect(attrOf(locked, "data-edit-track-volume-locked")).toBe("true");
        expect(locked).toContain("cursor-not-allowed");
        expect(locked).not.toContain("cursor-ns-resize");
        // 不给滑块语义、不进 Tab 序列：锁定的轨连键盘也调不动（与属性区输入框禁用同一口径）。
        expect(attrOf(locked, "role")).toBeNull();
        expect(attrOf(locked, "tabindex")).toBe("-1");
        expect(attrOf(locked, "aria-disabled")).toBe("true");
        // 锁定的原因写在提示里（不是静默失效），与轨道头、属性区同一句文案。
        expect(locked).toContain("锁定这条轨");

        // 对照：没锁定的那条是滑块、可聚焦、光标是上下箭头。
        const open = tagOf(markup, 'data-edit-track-volume="a1"');
        expect(attrOf(open, "role")).toBe("slider");
        expect(attrOf(open, "tabindex")).toBe("0");
        expect(open).toContain("cursor-ns-resize");
        expect(attrOf(open, "aria-disabled")).toBeNull();
        // 竖直滑块的可达性描述：上下限就是属性区的 0 ~ 400%，当前值与该轨音量一致。
        expect(attrOf(open, "aria-orientation")).toBe("vertical");
        expect(attrOf(open, "aria-valuemin")).toBe("0");
        expect(attrOf(open, "aria-valuemax")).toBe("400");
        expect(attrOf(open, "aria-valuenow")).toBe("100");
        expect(attrOf(open, "aria-valuetext")).toBe("100% · 0.0 dB");
    });

    it("拖动纪律：pointermove 里只写 ref 与 DOM，提交只发生在 pointerup 那一处（静态守护）", () => {
        // node 环境没有 DOM 也没有 jsdom（不引入新依赖），事件处理器根本发不出指针事件：
        // 所以「拖动期间不写状态」「锁定的轨走拒绝分支」「↑ 是变响」这些只能按源码冻结住关键那一行。
        // 这不是行为证据，而是「有人以后改坏这几行」时立刻变红的那道闸；真正的拖动手感由用户实机确认。
        const source = readFileSync(new URL("./components/edit-audio-track.tsx", import.meta.url), "utf8");
        const block = (marker: string) => {
            const at = source.indexOf(marker);
            expect(at, `源码里找不到 ${marker}`).toBeGreaterThan(-1);
            const end = source.indexOf("\n    };", at);
            expect(end, `${marker} 的结尾没找到`).toBeGreaterThan(at);
            return source.slice(at, end);
        };

        const move = block("const moveVolumeDrag");
        expect(move).toContain("volumeDragRef.current");
        expect(move).toContain("paintGain(");
        expect(move).not.toContain("updateAudioTrack");
        expect(move).not.toContain("setState");
        expect(move).not.toContain("useState");

        // 按下时也不写状态；锁定的轨必须先走拒绝分支（连 volumeDragRef 都不建）。
        const start = block("const startVolumeDrag");
        expect(start).not.toContain("updateAudioTrack");
        expect(start).toContain("if (!editTrackDraggable(track)) {");
        expect(start.indexOf("editTrackDraggable(track)")).toBeLessThan(start.indexOf("volumeDragRef.current ="));
        // 整段音量拖动里只有 pointerup 那一处提交，且只提交一次；值没变时连这一次也不写。
        const end = block("const endVolumeDrag");
        expect(end.split("updateAudioTrack").length - 1).toBe(1);
        expect(end).toContain("if (state.pending !== state.volume) updateAudioTrack(projectId, track.id, { volume: state.pending });");
        // 拖动期间真正改画面的那个函数只碰 DOM，并且三个可见结果都写到 DOM 上：
        // 线的高度、折线坐标、以及跟着指针走的百分比读数（不写状态也有数值反馈）。
        const paint = block("const paintGain");
        expect(paint).toContain("style.");
        expect(paint).toContain("setAttribute");
        expect(paint).toContain("readoutRef.current");
        expect(paint).toContain("textContent");
        // 读数必须写的是**拖动中的那个音量**（写回旧值 / 不写都算没反馈）。
        expect(paint).toContain("readoutRef.current.textContent = editVolumeReadout(next.volume);");
        expect(paint).not.toContain("updateAudioTrack");
        expect(paint).not.toContain("setState");
        // 键盘每次一步、也只调一次 store（与属性区的 step 一致），且方向是「↑ 变响」。
        const keys = block("const onVolumeKeyDown");
        expect(keys).toContain("editVolumeStep");
        expect(keys).toContain('editVolumeStep(track.volume, event.key === "ArrowUp" ? 1 : -1)');
        expect(keys.split("updateAudioTrack").length - 1).toBe(1);
        // 松手后 DOM 被钉在要提交的值上：paintGain 在 endVolumeDrag 里比 updateAudioTrack 先出现。
        expect(end.indexOf("paintGain(")).toBeLessThan(end.indexOf("updateAudioTrack"));

        // 左右拖动时写波形条位置的也是同一段代码：它必须继续走 timeline-scale 的 timeToPercent，
        // 不许自己写第二套「秒数 ÷ 时长」的百分比（这是时间线对齐那条纪律的源码级闸门），
        // 并且顺带把折线与音量线一起改到新起点上（否则拖动整行后两块画面会与波形条错位）。
        const strip = block("const paintStrip");
        expect(strip).toContain("timeToPercent(");
        expect(strip).not.toMatch(/\s*\/\s*\(?\s*(audioSeconds|totalSeconds)\b/);
        // 第三个参数是「此刻要按哪一段秒数画」（拖动中取未提交的裁剪区间）：拖两端裁剪时音量线
        // 与折线必须跟着留下那一段走，所以这个实参不能被省略。
        expect(strip).toContain("paintGain(start, track.volume, window)");
    });
});

describe("剪辑台时间线：音量线与淡入淡出没有动过别的元素的定位", () => {
    it("音轨行：原有子元素逐字未变，新元素一律追加在它们之后", () => {
        const base = render(demo(TRACKS_BASE), "editor-gain-regression-base");
        const offset = render(demo(TRACKS_OFFSET), "editor-gain-regression-offset");

        for (const [marker, frozen] of [
            ['data-edit-track-row="t1"', PRE_GAIN_BASE_ROW],
            ['data-edit-track-row="t2"', PRE_GAIN_MUTED_ROW],
        ] as const) {
            const row = divSlice(base, marker);
            const prefix = frozen.slice(0, frozen.lastIndexOf("</div>"));
            // 防「空串前缀」把断言变成永真：冻结的那一段必须是实打实的一整行内容。
            expect(prefix.length).toBeGreaterThan(2000);
            // 行的开始标签、波形条、轨道头三个开关、行尾提示 / 静音标记全部逐字相同，
            // 新元素只允许出现在它们**之后**（去掉行自己的闭合标签再比前缀）。
            expect(row.startsWith(prefix)).toBe(true);
            // 追加在后面的必须就是音量与淡入淡出那一层，而不是别的改动顺手挤进来的元素；
            // 而且覆盖层必须是**行的直接子元素**——再套一层带内边距的浮层会把绝对定位的原点挪开，
            // 折线与标尺就不再共用一个宽度了。
            const id = marker.slice(marker.indexOf('"') + 1, -1);
            expect(row.slice(prefix.length).startsWith("<svg ")).toBe(true);
            expect(row.slice(prefix.length)).toContain(`data-edit-track-gain="${id}"`);
            expect(row.endsWith("</div>")).toBe(true);
        }

        // 起点偏移的那条轨（起点 2 秒 + 锁定）同样逐字未变。
        const offsetRow = divSlice(offset, 'data-edit-track-row="t3"');
        const offsetPrefix = PRE_GAIN_OFFSET_ROW.slice(0, PRE_GAIN_OFFSET_ROW.lastIndexOf("</div>"));
        expect(offsetPrefix.length).toBeGreaterThan(2000);
        expect(offsetRow.startsWith(offsetPrefix)).toBe(true);
        expect(offsetRow.slice(offsetPrefix.length).startsWith("<svg ")).toBe(true);
        expect(offsetRow.slice(offsetPrefix.length)).toContain('data-edit-track-gain="t3"');
    });

    it("视频轨行：整段产物逐字未变（本次一行都没碰它）", () => {
        const markup = render(demo(TRACKS_BASE), "editor-gain-regression-video");

        expect(divSlice(markup, "data-edit-video-track")).toBe(PRE_GAIN_VIDEO_ROW);
        // 接缝上的转场标记也还在（音轨侧的新元素不许压掉它）。
        expect(markup).toContain("data-edit-transition-seam");
    });

    it("波形条 / 标尺刻度 / 播放头 / 片段条 / 字幕块的内联定位逐字未变", () => {
        const markup = render(demo(TRACKS_BASE), "editor-gain-regression-styles");

        // 波形条：改动前冻结下来的开始标签（含 class 与内联 left / width）。
        expect(tagOf(markup, 'data-edit-waveform-strip="t1"')).toBe('<div data-edit-waveform-strip="t1" data-edit-track-audible="true" class="absolute inset-y-0 left-0 overflow-hidden rounded-[8px] border border-black/[0.09] dark:border-white/[0.09] " style="width:100%">');
        expect(tagOf(markup, 'data-edit-waveform-strip="t2"')).toBe('<div data-edit-waveform-strip="t2" data-edit-track-audible="false" class="absolute inset-y-0 left-0 overflow-hidden rounded-[8px] border border-black/[0.09] dark:border-white/[0.09] opacity-40" style="width:100%">');

        // 片段条与字幕块：逐字冻结的内联定位（这两类元素最容易被「新元素偷像素」带偏）。
        expect(readClips(markup)).toEqual(["left:0%;width:44.44444444444444%", "left:44.44444444444444%;width:55.55555555555556%"]);
        expect(readSubtitles(markup)).toEqual(["left:11.11111111111111%;width:22.222222222222218%;min-width:6px;background:#e6f4ff;color:rgba(0,0,0,0.88);border-color:#f0f0f0;border-style:solid"]);

        // 标尺刻度与播放头。
        expect(readTicks(markup)).toEqual([0, 22.22222222222222, 44.44444444444444, 66.66666666666666, 88.88888888888889]);
        expect(tagOf(markup, "data-edit-playhead")).toBe('<div data-edit-playhead="true" class="pointer-events-none absolute inset-y-0 z-10 w-px bg-[#756bff]" style="left:0%">');

        // 起点偏移的那条轨也一样（波形条的 left 是唯一带偏移的定位）。
        const offset = render(demo(TRACKS_OFFSET), "editor-gain-regression-offset-strip");
        expect(tagOf(offset, 'data-edit-waveform-strip="t3"')).toBe('<div data-edit-waveform-strip="t3" data-edit-track-audible="true" class="absolute inset-y-0 left-0 overflow-hidden rounded-[8px] border border-black/[0.09] dark:border-white/[0.09] " style="width:77.77777777777779%;left:22.22222222222222%">');
    });

    it("新元素都是绝对定位的浮层：不套自己的滚动容器、不写横向内边距（不从轨道宽度里取像素）", () => {
        const markup = render(demo(TRACKS_BASE), "editor-gain-regression-overlay");
        const svg = tagOf(markup, 'data-edit-track-gain="t1"');
        const line = tagOf(markup, 'data-edit-track-volume="t1"');
        const badge = tagOf(markup, 'data-edit-track-volume-badge="t1"');

        // 三个新元素都是绝对定位（脱离文档流），所以它们的存在不会改变任何兄弟元素的宽度。
        for (const tag of [svg, line, badge]) {
            expect(tag).toContain("absolute");
            // 一个都不许碰会改变可定位宽度的属性：滚动条、flex 分配、撑满宽度、边框。
            for (const forbidden of ["overflow-y-auto", "overflow-auto", "flex-1", "w-full", "border"]) expect(tag).not.toContain(forbidden);
        }
        // 两条时间定位的元素更是连横向内边距都没有（内边距会挪动百分比定位的原点）。
        for (const tag of [svg, line]) {
            for (const forbidden of ["px-", "mx-", "pl-", "pr-", "ml-", "mr-"]) expect(tag).not.toContain(forbidden);
        }
        // 覆盖层本身不占任何宽度：整行铺满、不吃指针事件。
        expect(svg).toContain("inset-0");
        expect(svg).toContain("pointer-events-none");
        // 时间轴的纵向滚动仍然只有共享的那一个容器（音轨行没有自己再套一个）。
        expect(markup.match(/data-edit-timeline-scroll/g)).toHaveLength(1);
    });
});

/**
 * 用户报告：「音轨的调整声音的颜色太重了 把波形都遮盖完了」——截图里音轨行是一整块不通透的灰矩形，
 * 波形完全看不见，行右端还写着「🔊 100% · 0.0 dB」。
 *
 * 根因（实测的产物，不是推测）：折线下方那块**面积填充**用的是 antd 的 `colorPrimaryBg`，而本应用把
 * `colorPrimary` 设成了中性色（浅色 #171717 / 深色 #d8d8d8），由它派生出来的 `colorPrimaryBg` 是
 * **#575757 / #595959 的中灰、而且不带任何透明度**；这块面积在 100% 音量下占 **70.5% 行高 × 整行宽**
 * （折线 26.5% → 面积底 97%），正好压在波形上——波形是「1px 一列铺满整段」的实心色块，
 * 被一块不透明的灰板盖住就等于消失。用户在界面上看到的「曲线」其实是行里那条音量基准线。
 *
 * 修法：填充改成**与波形条同一个 token（colorPrimary）** + 低不透明度（EDIT_GAIN_AREA_FILL_OPACITY）。
 * 同色叠加是恒等运算（0.92 × 波形色 + 0.08 × 同一个波形色 = 波形色），所以这层填充**在算术上
 * 不可能削弱波形的对比度**；折线的坡度与音量基准线一点没减弱，静音态的虚线 / 变淡也原样保留。
 * 下面把「让路之后仍然看得见」做成可读回 / 可计算的断言，两套**真实主题**各跑一遍。
 *
 * 无法验证的部分：node 环境没有 DOM（本仓库不引入 jsdom），这里量不出真实像素，
 * 「波形在界面上是不是真的清楚」只能由用户在实机上看——本文件给的是产物 + 算术证据，不能替代人眼验收。
 */
describe("剪辑台音轨：波形是主信息，音量与淡入淡出的叠加层必须让路（浅色 / 深色各核一遍）", () => {
    /** 面积填充能盖住多少行高：折线在 100% 音量时的高度是 26.5%，面积一直铺到 97%。 */
    const COVERED_ROW_PERCENT = 97 - 26.5;

    it("面积填充是低透明度的同色底纹：波形条的可见度 = 1 − 填充不透明度，两套主题都不低于 0.9", () => {
        for (const dark of [false, true]) {
            const markup = renderThemed(demo(TRACKS_BASE), `editor-gain-fill-${dark ? "dark" : "light"}`, dark);
            const area = tagOf(markup, 'data-edit-track-gain-area="t1"');
            const line = tagOf(markup, 'data-edit-track-gain-line="t1"');

            // ① 产物读回：填充的不透明度必须真的写在产物里。缺这个属性就等于 1 = 完全不透明，
            //    也就是用户报的那个状态（修复前 fill-opacity 属性根本不存在，这里读到的是 1）。
            const raw = attrOf(area, "fill-opacity");
            const alpha = raw === null ? 1 : Number(raw);
            expect(alpha, "面积填充必须带一个明确的不透明度").toBe(EDIT_GAIN_AREA_FILL_OPACITY);
            expect(alpha).toBeLessThanOrEqual(0.1);
            // 波形条的视觉可见度 = 1 − 填充不透明度（填充就盖在波形上）。
            expect(1 - alpha).toBeGreaterThanOrEqual(0.9);

            // ② 填充用的是**与折线（也就是波形条）同一个 token**：产物里两者的颜色必须逐字相同。
            //    canvas 画波形条的 fillStyle 就是 token.colorPrimary，折线的 stroke 也是它，
            //    所以「填充色 === 折线色」就是「填充色 === 波形色」在产物里的可读证据。
            const bar = styleOf(line).match(/stroke:(#\w+)/)?.[1];
            expect(bar, "折线上的 stroke 必须是具体色值").toBeTruthy();
            expect(styleOf(area)).toContain(`fill:${bar}`);
            //    同色叠加是恒等运算：叠在波形条上的合成色就是波形色本身 ⇒ 填充削弱不了波形。
            expect(over(bar!, alpha, bar!)).toBe(bar);

            // ③ 上一轮那块把波形盖死的填充色是两个具体的中灰（两套主题的 colorPrimaryBg 实测值），
            //    这里逐字钉住「不许再回去」。修复前这两条都会失败。
            expect(styleOf(area)).not.toContain(dark ? "#595959" : "#575757");
            expect(styleOf(area)).not.toContain("colorPrimaryBg");

            // ④ 可计算对比：填充盖住 70.5% 的行高，所以「填充之后波形条 vs 它周围的底色」的对比度
            //    就是波形清不清楚的全部依据（WCAG 1.4.11 对非文本图形要求 ≥ 3:1）。
            const tokens = antdTheme.getDesignToken(getAntThemeConfig(dark));
            // 行底 = 行自己的 bg-black/[0.03]（深色主题是 dark:bg-white/[0.05]，见行容器的类名）压在页面底色上。
            const rowBackground = over(dark ? "#ffffff" : "#000000", dark ? 0.05 : 0.03, tokens.colorBgContainer);
            const tinted = over(bar!, alpha, rowBackground);
            expect(contrast(bar!, tinted)).toBeGreaterThanOrEqual(3);
            // 顺序也核一遍：填充确实盖住了这一行的大部分——不是「因为只盖了一小块」才没挡住波形。
            const areaPoints = pointsOf(area);
            expect(Math.max(...areaPoints.map((point) => point[1])) - Math.min(...areaPoints.map((point) => point[1]))).toBe(COVERED_ROW_PERCENT);
            expect(COVERED_ROW_PERCENT).toBeGreaterThan(60);
        }
    });

    it("层级：覆盖层在波形条之上、音量线在覆盖层之上，覆盖层里唯一实心的画笔只有一条 2px 描边", () => {
        const markup = render(demo(TRACKS_BASE), "editor-gain-layer");
        const row = divSlice(markup, 'data-edit-track-row="t1"');
        const svg = tagOf(markup, 'data-edit-track-gain="t1"');
        const strip = tagOf(markup, 'data-edit-waveform-strip="t1"');
        const line = tagOf(markup, 'data-edit-track-volume="t1"');
        const head = tagOf(markup, 'data-edit-track-head="t1"');

        // 波形条不写 z-index（auto = 0，按 DOM 顺序先画、在下面）。这是**刻意**的顺序：
        // 波形条是「1px 一列铺满整段」的实心块，把折线 / 面积画在它**下面**等于没画（上一轮那次就是这样
        // 被裁掉的），所以让路的办法只能是「叠加层自己不遮挡」，见上面那条用例。
        expect(zIndexOf(strip)).toBe(0);
        expect(zIndexOf(svg)).toBe(2);
        expect(zIndexOf(line)).toBe(3);
        expect(zIndexOf(head)).toBe(10);
        expect(zIndexOf(svg)).toBeGreaterThan(zIndexOf(strip));
        // 音量线压在覆盖层之上 ⇒ 它拖得到（覆盖层本身 pointer-events-none）。
        expect(zIndexOf(line)).toBeGreaterThan(zIndexOf(svg));
        // 轨道头仍压在音量线之上 ⇒ 静音 / 独奏 / 锁定三个开关仍点得到
        // （覆盖层不吃指针事件、内部没有可交互元素，另有 editor-audio-mute-regression-ui.test.tsx 专门冻结）。
        expect(zIndexOf(head)).toBeGreaterThan(zIndexOf(line));

        // 覆盖层里只有两支画笔：一块 0.08 的填充（上一条用例）与一条 2px 描边。
        // 行高 36px（h-9；Tailwind 的 --spacing 没有被改过，h-9 = 9 × 4px），所以那条线最多占住
        // 2/36 = 5.6% 的行高——它是一条线，不是一块面，这是「音量线必须看得见」与「不挡波形」的取舍点。
        const overlayAt = row.indexOf("<svg data-edit-track-gain");
        const overlay = row.slice(overlayAt, row.indexOf("</svg>", overlayAt));
        expect(overlay.match(/<polygon/g)).toHaveLength(1);
        expect(overlay.match(/<polyline/g)).toHaveLength(1);
        expect(attrOf(tagOf(markup, 'data-edit-track-gain-line="t1"'), "stroke-width")).toBe("2");
        expect(2 / 36).toBeLessThan(0.1);

        // 覆盖层的盒子仍然**就是本行**（上一轮的 width/height:100% 不许改回去）：它不越出本行，
        // 就不可能盖到视频轨行 / 字幕行 / 接缝标记上。
        expect(styleOf(svg)).toContain("width:100%");
        expect(styleOf(svg)).toContain("height:100%");
        expect(svg).toContain("inset-0");
        expect(tagOf(markup, 'data-edit-track-row="t1"')).toContain("overflow-hidden");
        // 整行只有这一个覆盖层：没有第二块面被画到波形上面。
        expect(row.match(/data-edit-track-gain="/g)).toHaveLength(1);
    });

    it("音量线仍在、仍拖得动：12px 的命中带、在覆盖层之上、仍是带 ns-resize 的竖直滑块", () => {
        const markup = render(demo(TRACKS_BASE), "editor-gain-hit");
        const line = tagOf(markup, 'data-edit-track-volume="t1"');

        // 视觉上只有 2px 的线，命中带是 h-3 = 12px（6 倍行内），远宽于线本身。
        expect(divSlice(markup, 'data-edit-track-volume="t1"')).toContain("h-[2px]");
        expect(line).toContain("h-3");
        expect(12 / 36).toBeGreaterThan(0.25);
        // 手感与语义：上下拖才有效（光标先说清楚）、键盘可达的竖直滑块。
        expect(line).toContain("cursor-ns-resize");
        expect(attrOf(line, "role")).toBe("slider");
        expect(attrOf(line, "aria-orientation")).toBe("vertical");
        expect(attrOf(line, "aria-valuetext")).toBe("100% · 0.0 dB");
        // 它在覆盖层之上（z-3 > z-2），而覆盖层 pointer-events-none ⇒ 指针一定落在线上而不是被覆盖层吃掉。
        expect(zIndexOf(line)).toBe(3);
        expect(zIndexOf(line)).toBeGreaterThan(zIndexOf(tagOf(markup, 'data-edit-track-gain="t1"')));
    });

    it("减弱填充没有把静音态与淡入淡出一起减弱：坡度仍是实心 2px、静音仍变虚线并更淡", () => {
        const markup = renderThemed(demo(TRACKS_BASE), "editor-gain-keep-light", false);
        // t2 = 静音 + 50% + 淡入 1 秒 / 淡出 2 秒。
        const svg = tagOf(markup, 'data-edit-track-gain="t2"');
        const line = tagOf(markup, 'data-edit-track-gain-line="t2"');
        const area = tagOf(markup, 'data-edit-track-gain-area="t2"');

        // 坡度**一点没减弱**：描边没有任何额外透明度、宽度仍是 2px、折点仍画在正确位置
        // （1 秒 → 11.11%、7 秒 → 77.78%，与标尺刻度同一把尺子；位置另有专门用例逐个核对）。
        expect(attrOf(line, "stroke-opacity")).toBeNull();
        expect(attrOf(line, "stroke-width")).toBe("2");
        expect(pointsOf(line)).toEqual([
            [0, 97],
            [11.11111111111111, 38.29034149683927],
            [77.77777777777779, 38.29034149683927],
            [100, 97],
        ]);

        // 静音态仍与正常态看得出区别：整层 opacity-50 + 折线虚线 + 填充的有效不透明度减半（0.08 × 0.5）。
        expect(svg).toContain("opacity-50");
        expect(attrOf(line, "stroke-dasharray")).toBe("4 3");
        const mutedAlpha = Number(attrOf(area, "fill-opacity") ?? 1) * 0.5;
        expect(mutedAlpha).toBeCloseTo(0.04, 6);
        expect(mutedAlpha).toBeLessThan(EDIT_GAIN_AREA_FILL_OPACITY);
        // 波形条自己也变淡（opacity-40）：静音轨的波形比正常轨更弱，这是既有设定，本次没动它。
        expect(tagOf(markup, 'data-edit-waveform-strip="t2"')).toContain("opacity-40");
        // 读数一字不变（用户在截图里能看到它，说明它是有效的）。
        expect(markup).toContain("50% · -6.0 dB");
    });

    it("源码级闸门：组件里不再出现 colorPrimaryBg，填充只能走 colorPrimary + EDIT_GAIN_AREA_FILL_OPACITY", () => {
        // 这条能防住的失败模式：有人为了「再明显一点」把填充换回 colorPrimaryBg（或别的实心底色 token）。
        // 那种改动在产物断言里也会红，但这里给出的是**原因**：本应用的主色是中性色，
        // 从它派生出来的 colorPrimaryBg 是中灰实心块，正是用户报的那个「灰色矩形」。
        const source = readFileSync(new URL("./components/edit-audio-track.tsx", import.meta.url), "utf8");
        // 查的是**用法**（token.colorPrimaryBg）而不是裸词：那段说明里要写明「曾经用的是它」，会提到这个名字。
        expect(source).not.toContain("token.colorPrimaryBg");
        expect(source).toContain("fillOpacity={EDIT_GAIN_AREA_FILL_OPACITY}");
        expect(source).toContain("style={{ fill: token.colorPrimary }}");
    });
});
