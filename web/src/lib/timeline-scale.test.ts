import { describe, expect, it } from "vitest";

import { timelinePlacements, timeToPercent, timeToPx } from "./timeline-scale";

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
/** 前 k 段时长之和 = 第 k+1 段的起点秒数。 */
const prefixSeconds = (lengths: number[], k: number) => sum(lengths.slice(0, k));
const rightEdge = (placement: { left: number; width: number }) => placement.left + placement.width;

/**
 * **修复前**的实现：片段行是 `flex` + `gap-1`（4px），每条 `flex: max(0.2, 秒数) 1 0%`。
 * 间隙从容器宽度里被吃掉，于是每条宽度 = (轨道宽 − (N−1)×间隙) × 本段秒数 / 总秒数。
 * 这里复刻它，**只**用于证明下面那条回归断言对修复前的实现确实会失败。
 */
function legacyFlexEdges(lengths: number[], trackPx: number, gapPx = 4) {
    const grow = lengths.map((length) => Math.max(0.2, length));
    const growTotal = sum(grow);
    const free = trackPx - (lengths.length - 1) * gapPx;
    const edges: { left: number; right: number }[] = [];
    let x = 0;
    for (const value of grow) {
        const width = (free * value) / growTotal;
        edges.push({ left: x, right: x + width });
        x += width + gapPx;
    }
    return edges;
}

/** 每条片段两条边相对「严格百分比」的像素偏差；单个片段时 gap 不参与，偏差恒为 0。 */
function edgeErrorsPx(lengths: number[], trackPx: number, edges: { left: number; right: number }[]) {
    const total = sum(lengths);
    return edges.flatMap((edge, index) => [
        edge.left - (prefixSeconds(lengths, index) / total) * trackPx,
        edge.right - (prefixSeconds(lengths, index + 1) / total) * trackPx,
    ]);
}

describe("时间轴换算法：秒数 → 百分比 / 像素", () => {
    it("位置就是「秒数 / 总秒数」的百分比，端点是 0% 与 100%", () => {
        expect(timeToPercent(0, 12)).toBe(0);
        expect(timeToPercent(3, 12)).toBe(25);
        expect(timeToPercent(6, 12)).toBe(50);
        expect(timeToPercent(12, 12)).toBe(100);
        // 超过总时长不在这里夹取（播放头等调用方自己夹），换算本身保持线性。
        expect(timeToPercent(18, 12)).toBe(150);
    });

    it("总时长无效或秒数非有限值时返回 0，不产生 NaN 位置", () => {
        expect(timeToPercent(3, 0)).toBe(0);
        expect(timeToPercent(3, -12)).toBe(0);
        expect(timeToPercent(3, Number.NaN)).toBe(0);
        expect(timeToPercent(Number.NaN, 12)).toBe(0);
        expect(timeToPercent(Number.POSITIVE_INFINITY, 12)).toBe(0);
    });

    it("像素换算与百分比换算严格同源（同一秒在两种单位下位置一致）", () => {
        for (const seconds of [0, 1.5, 4, 7.25, 12]) expect(timeToPx(seconds, 12, 1000)).toBeCloseTo((timeToPercent(seconds, 12) / 100) * 1000, 12);
        expect(timeToPx(6, 12, 640)).toBe(320);
        expect(timeToPx(6, 12, 0)).toBe(0);
    });
});

describe("片段条占位：与标尺、播放头、波形共用同一套换算", () => {
    it("单个片段：右边缘精确落在总时长的位置上（严格相等，不是「差不多」）", () => {
        const placements = timelinePlacements([4], 4);

        expect(placements).toEqual([{ left: 0, width: 100 }]);
        expect(rightEdge(placements[0]!)).toBe(100);
        expect(rightEdge(placements[0]!)).toBe(timeToPercent(4, 4));
    });

    it("多个片段：第 k 段的起点与终点都落在「前 k 段时长之和」的位置上", () => {
        const lengths = [4, 5, 3];
        const total = sum(lengths);
        const placements = timelinePlacements(lengths, total);

        lengths.forEach((length, index) => {
            expect(placements[index]!.left).toBeCloseTo(timeToPercent(prefixSeconds(lengths, index), total), 12);
            expect(rightEdge(placements[index]!)).toBeCloseTo(timeToPercent(prefixSeconds(lengths, index + 1), total), 12);
            // 宽度就是本段时长换算出来的宽度，没有被任何间隙偷走像素。
            expect(placements[index]!.width).toBeCloseTo(timeToPercent(length, total), 12);
        });
        // 相邻片段严丝合缝：第 k 段的右边缘 == 第 k+1 段的左边缘（没有缝占几何）。
        for (let index = 1; index < lengths.length; index += 1) expect(rightEdge(placements[index - 1]!)).toBeCloseTo(placements[index]!.left, 12);
        expect(rightEdge(placements[placements.length - 1]!)).toBe(100);
    });

    it("所有片段右边缘的累积误差为 0（本次缺陷的直接回归断言）", () => {
        const total = 60;
        const lengths = [7, 3, 5, 11, 2, 6, 4, 8, 9, 5];
        const placements = timelinePlacements(lengths, total);
        const errors = placements.map((placement, index) => rightEdge(placement) - timeToPercent(prefixSeconds(lengths, index + 1), total));

        expect(errors.every((error) => Math.abs(error) < 1e-9)).toBe(true);
        expect(Math.max(...errors.map(Math.abs))).toBe(0);
        expect(rightEdge(placements[placements.length - 1]!)).toBeCloseTo(100, 12);
    });

    it("同一条断言对修复前的 flex + gap 实现会失败（依据：gap 会吃掉容器像素）", () => {
        const trackPx = 1000;
        const lengths = [7, 3, 5, 11, 2, 6, 4, 8, 9, 5];

        // 修复前：每条边缘相对严格百分比都有偏差（这份长度组合在 1000px 轨道上最大 5.2px）。
        const legacyErrors = edgeErrorsPx(lengths, trackPx, legacyFlexEdges(lengths, trackPx));
        expect(Math.max(...legacyErrors.map(Math.abs))).toBeGreaterThan(5);
        // 「右边缘累积误差为 0」这条断言在修复前不成立（最后一段恰好被补回来，中间各段都错开）。
        const legacyRightErrors = legacyErrors.filter((_, index) => index % 2 === 1);
        expect(legacyRightErrors.some((error) => Math.abs(error) > 1)).toBe(true);
        // 偏差的上限就是间隙预算：(N−1)×4px。前段很长时最明显：首段 91s + 9×1s 偏差 32.76px。
        const skewed = [91, 1, 1, 1, 1, 1, 1, 1, 1, 1];
        const skewedErrors = edgeErrorsPx(skewed, trackPx, legacyFlexEdges(skewed, trackPx));
        expect(Math.max(...skewedErrors.map(Math.abs))).toBeGreaterThan(32);
        expect(Math.max(...skewedErrors.map(Math.abs))).toBeLessThanOrEqual((skewed.length - 1) * 4);

        // 修复后：同样的播位在像素空间里误差恰好是 0。
        const fixedErrors = edgeErrorsPx(
            lengths,
            trackPx,
            timelinePlacements(lengths, sum(lengths)).map((placement) => ({ left: (placement.left / 100) * trackPx, right: (rightEdge(placement) / 100) * trackPx })),
        );
        expect(Math.max(...fixedErrors.map(Math.abs))).toBeLessThan(1e-9);
    });

    it("片段数很多时也不累积偏移（20 段等长：每条恰好占 5%，最后一条右边缘 100%）", () => {
        const lengths = Array.from({ length: 20 }, () => 3);
        const total = sum(lengths);
        const placements = timelinePlacements(lengths, total);

        placements.forEach((placement, index) => {
            expect(placement.left).toBeCloseTo(index * 5, 12);
            expect(rightEdge(placement)).toBeCloseTo((index + 1) * 5, 12);
        });
        // 20 段在修复前有 76px 的间隙预算被吃掉（1200px 轨道上最大偏差 3.8px），修复后为 0。
        expect(Math.max(...edgeErrorsPx(lengths, 1200, legacyFlexEdges(lengths, 1200)).map(Math.abs))).toBeGreaterThan(3);
        expect(rightEdge(placements[19]!)).toBe(100);
    });

    it("时长为 0 的片段宽度为 0，且不推动任何后续片段", () => {
        const total = 10;
        const placements = timelinePlacements([5, 0, 5], total);

        expect(placements.map((placement) => placement.width)).toEqual([50, 0, 50]);
        expect(placements.map((placement) => placement.left)).toEqual([0, 50, 50]);
        // 零时长片段的左边缘 == 右边缘（退化成一个点，不是「有一点点宽」）。
        expect(rightEdge(placements[1]!)).toBe(placements[1]!.left);
        expect(rightEdge(placements[2]!)).toBe(100);
    });

    it("总时长为 0（或时长全是非法值）时全部落在 0%，不产生 NaN / Infinity", () => {
        const zero = timelinePlacements([0, 0], 0);

        expect(zero).toEqual([
            { left: 0, width: 0 },
            { left: 0, width: 0 },
        ]);
        expect(timelinePlacements([], 0)).toEqual([]);
        // 负数与非有限时长按 0 处理：不反过来吃掉别的片段的宽度。
        expect(timelinePlacements([Number.NaN, -5, 4], 4).map((placement) => placement.left)).toEqual([0, 0, 0]);
        expect(timelinePlacements([Number.NaN, -5, 4], 4)[2]!.width).toBe(100);
        expect(timelinePlacements([4], 0).every((placement) => placement.left === 0 && placement.width === 0)).toBe(true);
    });

    it("可视区与占位区的关系：缝画在占位区内部，内缩固定 2px、不随片段序号累积", () => {
        const trackPx = 1000;
        const lengths = [7, 3, 5, 11, 2, 6, 4, 8, 9, 5];
        const placements = timelinePlacements(lengths, sum(lengths));
        // 与组件里内层色块一致：外框严格按时间占位，色块在片段内部左右各内缩 2px。
        const insetPx = 2;

        placements.forEach((placement, index) => {
            const placeholderLeft = (placement.left / 100) * trackPx;
            const placeholderRight = (rightEdge(placement) / 100) * trackPx;
            const visibleLeft = placeholderLeft + insetPx;
            const visibleRight = placeholderRight - insetPx;

            expect(visibleLeft - placeholderLeft).toBe(insetPx);
            expect(placeholderRight - visibleRight).toBe(insetPx);
            // 可视区永远落在占位区**内部**（不会越过时间边界，也不会累积到下一个片段上）。
            expect(visibleLeft).toBeGreaterThanOrEqual(placeholderLeft);
            expect(visibleRight).toBeLessThanOrEqual(placeholderRight);
            expect(index === 0 || visibleLeft - ((rightEdge(placements[index - 1]!) / 100) * trackPx - insetPx) === 2 * insetPx).toBe(true);
        });
        // 相邻两段底色之间的空隙恒为 4px（原 gap-1 的观感），与片段序号无关。
        for (let index = 1; index < placements.length; index += 1) {
            const gap = (placements[index]!.left / 100) * trackPx + insetPx - ((rightEdge(placements[index - 1]!) / 100) * trackPx - insetPx);
            expect(gap).toBeCloseTo(2 * insetPx, 9);
        }
    });
});

/**
 * 「可定位宽度」：百分比换算之外的前提。标尺 / 播放头 / 导引线 / 片段条 / 波形条只有摊在**同一个**
 * 宽度上，同一秒才会落在同一像素；而滚动条会从它所在的那个容器里扣掉像素。
 *
 * 修复前：音轨行自己 `overflow-y-auto` + `max-h-[80px]`，音轨 ≥3 条时出现滚动条，
 * 滚动条只吃音轨行自己的宽度 → 波形条比标尺 / 片段条窄 6~15px，音画对齐的尺子失效。
 * 修复后：纵向滚动只放在包住全部时间定位元素的 `[data-edit-timeline-scroll]` 上，并固定预留
 * 滚动条槽（scrollbar-gutter: stable）→ 四类元素拿到同一个宽度，且与音轨数量无关。
 *
 * 这里的断言必须是**像素**：百分比断言抓不到这个缺陷——修复前波形条的 `width:100%` 与标尺末尾的
 * 100% 同样「相等」，错的是同一秒换算出来的像素位置（与上一次「只断言末尾对齐」漏掉中间段同理，
 * 所以下面按多个时刻逐一比对，而不是只看两端）。
 */
const AUDIO_STRIP_PX = 36; // 组件里波形条的 h-9
const AUDIO_GAP_PX = 4; // 组件里音轨行的 gap-1
const LEGACY_AUDIO_ROW_MAX_PX = 80; // 修复前音轨行的 max-h-[80px]
const SCROLLBAR_PX = 11; // thin 滚动条的名义宽度（Windows/WebView2；默认滚动条约 15px）

const safePx = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);

/** 音轨行的内容高度：0 条时是那行 h-9 的虚线占位。 */
function audioRowContentPx(trackCount: number) {
    return trackCount > 0 ? trackCount * AUDIO_STRIP_PX + (trackCount - 1) * AUDIO_GAP_PX : AUDIO_STRIP_PX;
}

/** 修复前：音轨行自带纵向滚动 → 只有波形条那一行被扣掉一个滚动条宽度。 */
function legacyRowWidths(containerPx: number, trackCount: number) {
    const width = safePx(containerPx);
    const scrolls = audioRowContentPx(trackCount) > LEGACY_AUDIO_ROW_MAX_PX;
    return { ruler: width, clip: width, waveform: scrolls ? Math.max(0, width - SCROLLBAR_PX) : width, scrolls };
}

/** 修复后：纵向滚动在共享容器上（槽位固定预留）→ 四类元素同一个宽度，与音轨数量无关。 */
function sharedRowWidths(containerPx: number) {
    const width = Math.max(0, safePx(containerPx) - SCROLLBAR_PX);
    return { ruler: width, clip: width, waveform: width, playhead: width, guide: width };
}

describe("时间轴同源宽度：音轨行不得自己滚动，否则波形条会窄于标尺", () => {
    const TRACK_COUNTS = [0, 1, 3, 5, 10];
    const CONTAINER_PX = 720;

    it("音轨 0 / 1 / 3 / 5 / 10 条：波形条与标尺、片段条、播放头、导引线拿到同一个可定位宽度", () => {
        for (const trackCount of TRACK_COUNTS) {
            const width = sharedRowWidths(CONTAINER_PX);
            expect(width.waveform).toBe(width.ruler);
            expect(width.waveform).toBe(width.clip);
            expect(width.waveform).toBe(width.playhead);
            expect(width.waveform).toBe(width.guide);
            expect(audioRowContentPx(trackCount)).toBeGreaterThan(0); // 音轨行始终占住这一行
        }
        // 音轨数量变化时宽度一个像素都不变（滚动条槽固定预留，不随音轨数量出现 / 消失）。
        expect(new Set(TRACK_COUNTS.map(() => sharedRowWidths(CONTAINER_PX).waveform)).size).toBe(1);
        expect(sharedRowWidths(CONTAINER_PX).waveform).toBe(CONTAINER_PX - SCROLLBAR_PX);
    });

    it("同一秒在四类元素上落在同一像素：不只两端对齐，中间时刻也必须一致", () => {
        for (const trackCount of TRACK_COUNTS) {
            const width = sharedRowWidths(CONTAINER_PX);
            for (const seconds of [0, 1.25, 3, 6, 7.5, 11.75, 12]) {
                const onWaveform = (timeToPercent(seconds, 12) / 100) * width.waveform;
                expect((timeToPercent(seconds, 12) / 100) * width.ruler).toBeCloseTo(onWaveform, 12);
                expect((timeToPercent(seconds, 12) / 100) * width.clip).toBeCloseTo(onWaveform, 12);
                expect((timeToPercent(seconds, 12) / 100) * width.playhead).toBeCloseTo(onWaveform, 12);
                expect((timeToPercent(seconds, 12) / 100) * width.guide).toBeCloseTo(onWaveform, 12);
                expect(audioRowContentPx(trackCount)).toBeGreaterThan(0);
            }
        }
    });

    it("同一条断言对修复前的实现会失败：音轨 ≥3 条时波形条恰好窄一个滚动条宽度", () => {
        // 0 条与 1 条时音轨行不滚动，修复前后一样——只看这两个数字会误判「没问题」。
        for (const trackCount of [0, 1]) {
            const legacy = legacyRowWidths(CONTAINER_PX, trackCount);
            expect(legacy.scrolls).toBe(false);
            expect(legacy.ruler - legacy.waveform).toBe(0);
        }
        for (const trackCount of [3, 5, 10]) {
            const legacy = legacyRowWidths(CONTAINER_PX, trackCount);
            expect(legacy.scrolls).toBe(true);
            expect(legacy.ruler - legacy.waveform).toBe(SCROLLBAR_PX);
            expect(legacy.ruler - legacy.waveform).toBeGreaterThan(0); // 这条在修复前必然不成立
        }
        // 错位从中间时刻就开始了：偏差 = 该时刻的位置占比 × 滚动条宽度，不只是末尾少一点。
        const legacy = legacyRowWidths(CONTAINER_PX, 5);
        const midpoint = timeToPercent(6, 12) / 100;
        expect(midpoint * legacy.ruler - midpoint * legacy.waveform).toBeCloseTo(midpoint * SCROLLBAR_PX, 12);
        expect(midpoint * legacy.ruler - midpoint * legacy.waveform).toBeGreaterThan(5);
        // 而百分比断言抓不到它：修复前两边的宽度都是 100%（这正是必须断言像素的原因）。
        expect(timeToPercent(12, 12)).toBe(100);
    });

    it("边界：容器极窄、比滚动条还窄、音轨为 0 或很多时都不出现负宽度 / NaN", () => {
        for (const trackCount of [0, 1, 3, 5, 50]) {
            for (const containerPx of [0, 4, SCROLLBAR_PX - 1, SCROLLBAR_PX, 320, 1920]) {
                const width = sharedRowWidths(containerPx);
                for (const value of Object.values(width)) {
                    expect(Number.isFinite(value)).toBe(true);
                    expect(value).toBeGreaterThanOrEqual(0);
                }
                expect(audioRowContentPx(trackCount)).toBeGreaterThan(0);
            }
        }
        expect(sharedRowWidths(0).waveform).toBe(0);
        expect(sharedRowWidths(-50).waveform).toBe(0);
        expect(sharedRowWidths(SCROLLBAR_PX).waveform).toBe(0);
        expect(sharedRowWidths(Number.NaN).waveform).toBe(0);
        expect(sharedRowWidths(1920).waveform).toBe(1920 - SCROLLBAR_PX);
    });
});
