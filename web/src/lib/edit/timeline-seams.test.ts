import { describe, expect, it } from "vitest";

import { timelinePlacements, timeToPercent } from "@/lib/timeline-scale";
import { editTimelineSeams, type EditSeamInput } from "./timeline-seams";

/** 接缝 = 相邻两段的交界：n 段有 n−1 条，位置与片段条同源（左段的右边缘）。 */
function clips(lengths: number[], patch: Partial<EditSeamInput> = {}): EditSeamInput[] {
    return lengths.map((length, index) => ({ id: `c${index + 1}`, length, ...patch }));
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("剪辑台接缝：位置计算（相邻片段边界的秒数与百分比）", () => {
    it("接缝秒数就是前 index+1 段时长之和，百分比与左段右边缘逐位同值", () => {
        const lengths = [4, 6, 5];
        const total = sum(lengths);
        const seams = editTimelineSeams(clips(lengths), total);
        const placements = timelinePlacements(lengths, total);

        expect(seams.map((seam) => seam.seconds)).toEqual([4, 10]);
        expect(seams.map((seam) => seam.leftClipId)).toEqual(["c1", "c2"]);
        expect(seams.map((seam) => seam.rightClipId)).toEqual(["c2", "c3"]);
        seams.forEach((seam, index) => {
            // 与片段条**同一个表达式**：左段的 left + width（不是另算一遍 timeToPercent）。
            expect(seam.percent).toBe(placements[index]!.left + placements[index]!.width);
            expect(seam.percent).toBeCloseTo(timeToPercent(seam.seconds, total), 12);
            // 也是右段的左边缘（差值只在浮点末位，1e-9 以内）。
            expect(Math.abs(seam.percent - placements[index + 1]!.left)).toBeLessThan(1e-9);
        });
    });

    it("不等长、含小数与三段的浮点边界：接缝落在 1/3、2/3 上且不自己算第二套换算", () => {
        const lengths = [1, 1, 1];
        const total = 3;
        const seams = editTimelineSeams(clips(lengths), total);
        const placements = timelinePlacements(lengths, total);

        expect(seams.map((seam) => seam.percent)).toEqual([placements[0]!.left + placements[0]!.width, placements[1]!.left + placements[1]!.width]);
        // 33.333…% / 66.666…%：断言严格相等，证明接缝与片段条共用同一串浮点运算结果。
        expect(seams[0]!.percent).toBe(timeToPercent(1, 3));
        expect(seams[1]!.percent).toBe(timeToPercent(2, 3));
        expect(seams.map((seam) => seam.seconds)).toEqual([1, 2]);
    });

    it("边界：边界恰好落在 0% 与 100%（两端是零长度片段）", () => {
        // [0, 5]：第 0 段没有长度，接缝落在轨道最左端 0%。
        const left = editTimelineSeams(clips([0, 5]), 5);
        expect(left).toHaveLength(1);
        expect(left[0]!.seconds).toBe(0);
        expect(left[0]!.percent).toBe(0);

        // [5, 0]：末段没有长度，接缝落在轨道最右端 100%。
        const right = editTimelineSeams(clips([5, 0]), 5);
        expect(right).toHaveLength(1);
        expect(right[0]!.seconds).toBe(5);
        expect(right[0]!.percent).toBe(100);
    });

    it("边界：0 段与 1 段一条接缝都没有（首段之前、末段之后都不是接缝）", () => {
        expect(editTimelineSeams([], 12)).toEqual([]);
        expect(editTimelineSeams(clips([7]), 7)).toEqual([]);
        // 只有一段时，即便它挂着转场字段也不产生任何接缝（转场指向的「下一段」不存在）。
        expect(editTimelineSeams([{ id: "c1", length: 7, transition: "fade" }], 7)).toEqual([]);
    });

    it("总时长无效（0 / NaN / 负数）时位置一律 0，不抛错", () => {
        for (const total of [0, Number.NaN, -12]) {
            const seams = editTimelineSeams(clips([4, 6]), total);
            expect(seams.map((seam) => seam.percent)).toEqual([0]);
            expect(seams.map((seam) => seam.seconds)).toEqual([4]);
        }
    });

    it("长度非有限值按 0 处理，与片段条口径一致", () => {
        const lengths = [Number.NaN, 4, -3];
        const seams = editTimelineSeams(clips(lengths), 4);
        const placements = timelinePlacements(lengths, 4);
        expect(seams.map((seam) => seam.percent)).toEqual([placements[0]!.left + placements[0]!.width, placements[1]!.left + placements[1]!.width]);
        expect(seams.map((seam) => seam.seconds)).toEqual([0, 4]);
    });
});

describe("剪辑台接缝：转场字段挂在左段上（「本段 → 下一段」）", () => {
    it("转场与时长取自左段；末段自己的转场不产生接缝", () => {
        const seams = editTimelineSeams(
            [
                { id: "c1", length: 4, transition: "fade", transitionDuration: 0.8 },
                { id: "c2", length: 6, transition: "wipeleft" },
                { id: "c3", length: 5, transition: "circleopen", transitionDuration: 1.2 },
            ],
            15,
        );

        // 两条接缝分别看 c1、c2 的转场字段；c3（末段）的转场没有去处，因此不出现。
        expect(seams.map((seam) => seam.transition)).toEqual(["fade", "wipeleft"]);
        expect(seams.map((seam) => seam.transitionDuration)).toEqual([0.8, 0.5]);
    });

    it("没写转场时长时给 0.5 秒（与属性区、导出侧的缺省一致），并带上锁定状态", () => {
        const seams = editTimelineSeams(
            [
                { id: "c1", length: 4, locked: true },
                { id: "c2", length: 6 },
            ],
            10,
        );
        expect(seams[0]!.transition).toBeUndefined();
        expect(seams[0]!.transitionDuration).toBe(0.5);
        expect(seams[0]!.locked).toBe(true);
        expect(seams[0]!.index).toBe(0);
    });

    it("只读不改：计算过程不修改传入的片段数组", () => {
        const input = clips([4, 6]);
        const snapshot = JSON.stringify(input);
        editTimelineSeams(input, 10);
        expect(JSON.stringify(input)).toBe(snapshot);
    });
});
