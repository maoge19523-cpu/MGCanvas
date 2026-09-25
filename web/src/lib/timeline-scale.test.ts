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
