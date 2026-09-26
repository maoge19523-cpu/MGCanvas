import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
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

import { App } from "antd";
import { timeToPercent } from "@/lib/timeline-scale";
import { useAssetStore } from "@/stores/use-asset-store";
import { useEditStore } from "@/stores/use-edit-store";
import { EDIT_DEFAULT_OUTPUT, type EditAudioTrack, type EditProject } from "@/types/edit";
import EditProjectPage from "./project";

/**
 * 音轨**两端裁剪**的产物读回（不是「代码写了就算」）：
 * 两端把手真的在产物里、位置就是波形条的两条边、裁过之后波形条 / 音量线 / 折线都按**留下的那一段**画、
 * 而且裁掉开头**不改 start**（波形条的 left 一个像素都不动）。
 *
 * 拖动过程的行为（只写 ref 与 DOM、松手才提交一次）在 node 环境里发不出指针事件，
 * 所以那一半按源码冻住关键行（与本仓库既有的拖动纪律测试同一写法），真正的拖动手感由实机确认。
 */

const DUMP_DIR = join(tmpdir(), "mgcanvas-editor-audio-trim");

/** 把静态渲染结果落盘再读回：验证的是真实产物，而不是内存里的中间态。 */
function dump(name: string, markup: string) {
    mkdirSync(DUMP_DIR, { recursive: true });
    const file = join(DUMP_DIR, `${name}.html`);
    writeFileSync(file, markup, "utf8");
    return readFileSync(file, "utf8");
}

/**
 * 视频 4 + 5 = 成片 9 秒；音轨素材 m4 = 3 秒（短，便于看出「留下的那一段」变短）。
 * 音轨素材 m3 = 20 秒（比成片长）用于「条宽被成片尽头夹住」的那一类对照。
 */
const DEMO: EditProject = {
    id: "edit-trim",
    name: "两端裁剪",
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
    subtitles: [],
    output: { ...EDIT_DEFAULT_OUTPUT },
};

/**
 * t1 未裁剪（3 秒素材整条）/ t2 裁成素材内 [1, 3)（内容 2 秒）/ t3 裁成 [1, 2.5)（1.5 秒）
 * t4 起点 2 秒 + 未裁剪（与 t5 对照「裁掉开头不改 start」）/ t5 起点 2 秒 + 裁成 [1, 3)
 * t6 锁定 + 裁过 / t7 静音 + 裁过 / t8 淡出 1 秒 + 裁过（用来读折线的收尾）。
 */
const TRACKS: EditAudioTrack[] = [
    { id: "t1", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
    { id: "t2", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, sourceStart: 1, sourceEnd: 3 },
    { id: "t3", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, sourceStart: 1, sourceEnd: 2.5 },
    { id: "t4", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, start: 2 },
    { id: "t5", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, start: 2, sourceStart: 1, sourceEnd: 3 },
    { id: "t6", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, sourceStart: 1, sourceEnd: 3, locked: true },
    { id: "t7", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, sourceStart: 1, sourceEnd: 3, muted: true },
    { id: "t8", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 1, loop: false, sourceStart: 1, sourceEnd: 2.5 },
    { id: "t9", mediaId: "m4", volume: 1, fadeIn: 0, fadeOut: 1, loop: false },
];

function render(tracks: EditAudioTrack[], name: string) {
    useEditStore.setState({ hydrated: true, projects: [{ ...DEMO, audioTracks: tracks }], history: {} });
    useAssetStore.setState({ assets: [], hydrated: true });
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

function leftOf(tag: string) {
    return styleOf(tag).match(/left:([^;"]+)/)?.[1] ?? "0%";
}

function widthOf(tag: string) {
    return Number(styleOf(tag).match(/width:([-\d.eE+]+)%/)?.[1]);
}

function pointsOf(tag: string) {
    const raw = tag.match(/points="([^"]*)"/)?.[1] ?? "";
    return raw ? raw.split(" ").map((pair) => pair.split(",").map(Number) as [number, number]) : [];
}

const TOTAL = 9;

describe("剪辑台时间线：音轨两端裁剪", () => {
    it("两端把手都在产物里，位置就是波形条的两条边（与它共用同一套 timeToPercent 换算）", () => {
        const markup = render(TRACKS, "editor-trim-handles");
        const start = tagOf(markup, 'data-edit-track-trim-start="t1"');
        const end = tagOf(markup, 'data-edit-track-trim-end="t1"');
        const strip = tagOf(markup, 'data-edit-waveform-strip="t1"');

        // 左端贴波形条的左边缘（起点 0 ⇒ 0%），右端贴它的右边缘（整条 3 秒 ⇒ 3/9）。
        expect(leftOf(start)).toBe("calc(0% + 2px)");
        expect(widthOf(strip)).toBeCloseTo(timeToPercent(3, TOTAL), 6);
        expect(leftOf(end)).toBe(`calc(${timeToPercent(3, TOTAL)}% - 8px)`);
        // 命中带是固定的 6px、绝对定位，不从轨道宽度里取像素（否则会推动别人）。
        expect(start).toContain("w-1.5");
        expect(start).toContain("absolute");
        expect(start).toContain("cursor-ew-resize");
        // 把手压在音量线（z-[3]）之上：两端这 6px 里能抓住的是裁剪，不是音量线。
        expect(start).toMatch(/z-\[4\]/);
    });

    it("裁过之后波形条只铺留下的那一段：宽度按「内容长度 ÷ 成片总长」", () => {
        const markup = render(TRACKS, "editor-trim-strip-span");

        // t1 整条 3 秒 → 33.3%；t2 裁成 [1, 3) → 2 秒 → 22.2%；t3 裁成 [1, 2.5) → 1.5 秒 → 16.7%。
        expect(widthOf(tagOf(markup, 'data-edit-waveform-strip="t1"'))).toBeCloseTo(timeToPercent(3, TOTAL), 6);
        expect(widthOf(tagOf(markup, 'data-edit-waveform-strip="t2"'))).toBeCloseTo(timeToPercent(2, TOTAL), 6);
        expect(widthOf(tagOf(markup, 'data-edit-waveform-strip="t3"'))).toBeCloseTo(timeToPercent(1.5, TOTAL), 6);
        // t2 的右端把手也跟着条宽走（拖右端裁的就是它）。
        expect(leftOf(tagOf(markup, 'data-edit-track-trim-end="t2"'))).toBe(`calc(${timeToPercent(2, TOTAL)}% - 8px)`);
    });

    it("裁掉开头**不改 start**：波形条的 left 一个像素都没动，只有右端提前结束", () => {
        const markup = render(TRACKS, "editor-trim-keeps-start");
        const plain = tagOf(markup, 'data-edit-waveform-strip="t4"');
        const trimmed = tagOf(markup, 'data-edit-waveform-strip="t5"');

        // 两条轨起点都是 2 秒：left 逐字相同（裁左端不是把整条轨往右挪）。
        expect(leftOf(plain)).toBe(leftOf(trimmed));
        expect(leftOf(trimmed)).toBe(`${timeToPercent(2, TOTAL)}%`);
        // 右端：未裁剪 3 秒 → 3 秒；裁成 [1, 3) 后只剩 2 秒（起点之后还剩 7 秒，够放）。
        expect(widthOf(plain)).toBeCloseTo(timeToPercent(3, TOTAL), 6);
        expect(widthOf(trimmed)).toBeCloseTo(timeToPercent(2, TOTAL), 6);
        expect(widthOf(trimmed)).toBeLessThan(widthOf(plain));
        // 起点之后放不下的部分由成片尽头夹住：m3（20 秒）起点 5 秒时条宽最多 4 秒。
        const clamped = render([{ id: "z1", mediaId: "m3", volume: 1, fadeIn: 0, fadeOut: 0, loop: false, start: 5, sourceStart: 2 }], "editor-trim-clamped");
        expect(widthOf(tagOf(clamped, 'data-edit-waveform-strip="z1"'))).toBeCloseTo(timeToPercent(4, TOTAL), 6);
    });

    it("音量线与折线跟着留下的那一段走：线的 left / width 与波形条严格相同", () => {
        const markup = render(TRACKS, "editor-trim-alignment");
        for (const id of ["t1", "t2", "t3", "t5"]) {
            const strip = tagOf(markup, `data-edit-waveform-strip="${id}"`);
            const line = tagOf(markup, `data-edit-track-volume="${id}"`);
            expect(widthOf(line), id).toBeCloseTo(widthOf(strip), 6);
            expect(leftOf(line), id).toBe(leftOf(strip));
        }
    });

    it("淡入淡出的收尾按裁剪后的内容末尾算，不再报一句假的「淡出听不到」", () => {
        const markup = render(TRACKS, "editor-trim-fade");
        // t8 裁成 [1, 2.5)（内容 1.5 秒）+ 淡出 1 秒：折线收在留下的那一段末尾 1.5 秒（16.7% 处）。
        const points = pointsOf(tagOf(markup, 'data-edit-track-gain-line="t8"'));
        expect(points[points.length - 1]![0]).toBeCloseTo(timeToPercent(1.5, TOTAL), 6);
        // t9 同参数但没裁过（整条 3 秒）：导出锚点在成片末尾 → 行提示里点明这段淡出在成片里听不到。
        expect(tagOf(markup, 'data-edit-track-row="t9"')).toContain("这段淡出在成片里听不到");
        // t8 的锚点跟着内容末尾走，于是与画出来的坡度一致：不该再出现那句提示。
        expect(tagOf(markup, 'data-edit-track-row="t8"')).not.toContain("这段淡出在成片里听不到");
    });

    it("锁定轨的把手拖不动：不给滑块语义、不进 Tab 序列、光标是 not-allowed，并写出原因", () => {
        const markup = render(TRACKS, "editor-trim-locked");
        const locked = tagOf(markup, 'data-edit-track-trim-start="t6"');

        expect(locked).toContain("cursor-not-allowed");
        expect(locked).not.toContain("cursor-ew-resize");
        expect(locked.match(/role="slider"/)).toBeNull();
        expect(locked).toContain('tabindex="-1"');
        expect(locked).toContain('aria-disabled="true"');
        expect(locked).toContain("锁定这条轨");
        // 对照：没锁定的把手是滑块、可聚焦、带可达性描述（当前入点 / 素材全长）。
        const open = tagOf(markup, 'data-edit-track-trim-start="t2"');
        expect(open).toContain('role="slider"');
        expect(open).toContain('tabindex="0"');
        expect(open).toContain('aria-orientation="horizontal"');
        expect(open).toContain('aria-valuenow="1"');
        expect(open).toContain('aria-valuemax="3"');
        expect(open).toContain("拖动裁剪入点");
        // 拖两端与整行拖动是两件事：把手自己带说明，用户能看懂这一下会改什么。
        expect(open).toContain("拖动两端裁剪音轨");
        expect(tagOf(markup, 'data-edit-track-trim-end="t2"')).toContain("拖动裁剪出点");
        // 裁过的轨在提示里写明「取的是素材的哪一段」。
        expect(open).toContain("已裁剪");
    });

    it("静音轨照旧可以裁剪（静音只是不听它），两端把手与开关互不影响", () => {
        const markup = render(TRACKS, "editor-trim-muted");
        const mutedStrip = tagOf(markup, 'data-edit-waveform-strip="t7"');

        // 静音的轨波形条照旧变淡，但条宽仍是裁剪后的那一段、把手照旧在、照旧可聚焦。
        expect(mutedStrip).toContain("opacity-40");
        expect(widthOf(mutedStrip)).toBeCloseTo(timeToPercent(2, TOTAL), 6);
        expect(tagOf(markup, 'data-edit-track-trim-start="t7"')).toContain('tabindex="0"');
        expect(markup).toContain('data-edit-track-mute="t7"');
        // 静音与裁剪都照旧进导出请求（静音只影响 tracks 里要不要这一条，裁剪只影响那一条的区间）。
        expect(markup).toContain('data-edit-track-audible="false"');
    });

    it("拖动纪律：pointermove 里只写 ref 与 DOM，提交只发生在 pointerup 那一处（静态守护）", () => {
        // node 环境没有 DOM 也没有 jsdom（不引入新依赖），指针事件根本发不出：这一半只能按源码冻结关键行。
        // 这不是行为证据，而是「有人以后改坏这几行」时立刻变红的那道闸。
        const source = readFileSync(new URL("./components/edit-audio-track.tsx", import.meta.url), "utf8");
        const block = (marker: string) => {
            const at = source.indexOf(marker);
            expect(at, `源码里找不到 ${marker}`).toBeGreaterThan(-1);
            const end = source.indexOf("\n    };", at);
            expect(end, `${marker} 的结尾没找到`).toBeGreaterThan(at);
            return source.slice(at, end);
        };

        const move = block("const moveTrimDrag");
        expect(move).toContain("trimDragRef.current");
        expect(move).toContain("drag.placeTrim(");
        expect(move).toContain("paintStrip(");
        expect(move).not.toContain("updateAudioTrack");
        expect(move).not.toContain("setState");
        expect(move).not.toContain("useState");

        // 按下时也不写状态；锁定的轨必须先走拒绝分支（连 trimDragRef 都不建）。
        const start = block("const startTrimDrag");
        expect(start).not.toContain("updateAudioTrack");
        expect(start).toContain("if (!editTrackDraggable(track)) {");
        expect(start.indexOf("editTrackDraggable(track)")).toBeLessThan(start.indexOf("trimDragRef.current ="));

        // 整段裁剪拖动里只有 pointerup 那一处提交，且只提交一次；值没变时连这一次也不写。
        const end = block("const endTrimDrag");
        expect(end.split("drag.commitTrim").length - 1).toBe(1);
        expect(end).toContain("if (state.pending.start !== trim.start || state.pending.end !== trim.end) drag.commitTrim(");

        // 键盘：← → 每次 0.1 秒，必须先 preventDefault + stopPropagation（左右箭头是时间线自己的快捷键）。
        const keys = block("const onTrimKeyDown");
        expect(keys).toContain("ArrowLeft");
        expect(keys).toContain("ArrowRight");
        expect(keys).toContain("preventDefault");
        expect(keys).toContain("stopPropagation");
        expect(keys).toContain("EDIT_MIN_TRIM_SECONDS");
        expect(keys.split("updateAudioTrack").length - 1).toBe(1);

        // 换算纪律：把手 / 条宽只走 timeline-scale 的 timeToPercent，不自己写第二套「秒数 ÷ 时长」。
        const handles = source.slice(source.indexOf("data-edit-track-trim-start"), source.indexOf("data-edit-track-trim-start") + 2000);
        expect(handles).toContain("timeToPercent(");
        expect(handles).not.toMatch(/\s*\/\s*\(?\s*(audioSeconds|totalSeconds|stripSeconds)\b/);
    });
});
