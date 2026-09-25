import { describe, expect, it } from "vitest";

import { timelinePlacements, timeToPercent } from "@/lib/timeline-scale";
import type { EditSubtitle } from "@/types/edit";
import {
    EDIT_MIN_SUBTITLE_SECONDS,
    EDIT_SUBTITLE_LABEL_LIMIT,
    EDIT_SUBTITLE_MIN_PX,
    countEditSubtitlesBeyondEnd,
    editSubtitleBlocks,
    editSubtitleLabel,
    editSubtitleOverlapBands,
    editSubtitlePlacement,
    moveEditSubtitle,
    resolveEditSubtitleEdge,
    trimEditSubtitle,
} from "./subtitle-blocks";

const cue = (id: string, start: number, end: number, text = id): EditSubtitle => ({ id, start, end, text });

describe("字幕块定位：left / width 就是 timeToPercent 这一套换算（纯函数）", () => {
    it("两条边各走一次换算，宽度取两条边的差；右边缘严格等于 end 的换算值", () => {
        const placement = editSubtitlePlacement(2, 5, 10);

        expect(placement.left).toBe(timeToPercent(2, 10));
        expect(placement.left + placement.width).toBe(timeToPercent(5, 10));
        expect(placement.width).toBe(timeToPercent(5, 10) - timeToPercent(2, 10));
    });

    it("start = 0 时左边缘就是 0%", () => {
        expect(editSubtitlePlacement(0, 3, 10)).toEqual({ left: 0, width: timeToPercent(3, 10) });
    });

    it("与片段条共用同一次推导：一组首尾相接、铺满全片的区间，占位与 timelinePlacements 完全相同", () => {
        // 这正是不允许另写一套百分比换算的原因：字幕块与片段条必须是同一把尺子。
        const lengths = [4, 6, 5];
        const total = lengths.reduce((sum, length) => sum + length, 0);
        let offset = 0;
        const ours = lengths.map((length) => {
            const placement = editSubtitlePlacement(offset, offset + length, total);
            offset += length;
            return placement;
        });

        expect(ours).toEqual(timelinePlacements(lengths, total));
    });

    it("end 超出成片总长时右边缘裁到 100%（与波形条「只画到成片末尾」同口径）", () => {
        const placement = editSubtitlePlacement(8, 12, 10);

        expect(placement.left).toBe(timeToPercent(8, 10));
        expect(placement.left + placement.width).toBe(100);
    });

    it("start 已经在成片末尾之后时：left 钉在 100%、宽度 0（不画到 100% 之外）", () => {
        expect(editSubtitlePlacement(12, 14, 10)).toEqual({ left: 100, width: 0 });
        expect(editSubtitlePlacement(10, 14, 10)).toEqual({ left: 100, width: 0 });
    });

    it("时长为零或起止倒序时宽度是 0，绝不出现负宽度", () => {
        expect(editSubtitlePlacement(3, 3, 10).width).toBe(0);
        expect(editSubtitlePlacement(5, 3, 10)).toEqual({ left: timeToPercent(5, 10), width: 0 });
    });

    it("负值 / NaN / Infinity / 成片总长为 0 都不产生 NaN，全部落回 0", () => {
        expect(editSubtitlePlacement(-4, 3, 10)).toEqual({ left: 0, width: timeToPercent(3, 10) });
        expect(editSubtitlePlacement(Number.NaN, 3, 10)).toMatchObject({ left: 0 });
        // 非有限值一律当 0（与 timeToPercent 自己的守卫同一口径）：宁可画成一个零宽的块
        // （还有可点下限托着，抓得住、删得掉），也不要让 NaN 漏进样式里把整行搞崩。
        expect(editSubtitlePlacement(1, Number.POSITIVE_INFINITY, 10)).toEqual({ left: timeToPercent(1, 10), width: 0 });
        expect(editSubtitlePlacement(Number.POSITIVE_INFINITY, 3, 10)).toEqual({ left: 0, width: timeToPercent(3, 10) });
        expect(editSubtitlePlacement(Number.NEGATIVE_INFINITY, Number.NaN, Number.NaN)).toEqual({ left: 0, width: 0 });
        expect(editSubtitlePlacement(1, 3, 0)).toEqual({ left: 0, width: 0 });
    });
});

describe("字幕块：摘要、超出成片与重叠标记（纯函数）", () => {
    it("摘要把多行压成一行并截断；全文仍留在 text 里", () => {
        expect(editSubtitleLabel("  第一行\n第二行  ")).toBe("第一行 第二行");
        const long = "字".repeat(EDIT_SUBTITLE_LABEL_LIMIT + 5);
        expect(editSubtitleLabel(long)).toHaveLength(EDIT_SUBTITLE_LABEL_LIMIT + 1);
        expect(editSubtitleLabel(long).endsWith("…")).toBe(true);
    });

    it("逐条给定位与状态位：成片之内 / 结尾超出 / 整条在外 / 重叠", () => {
        const blocks = editSubtitleBlocks([cue("a", 0, 2), cue("b", 8, 12), cue("c", 12, 14), cue("d", 1, 3)], 10);

        expect(blocks.map((block) => block.index)).toEqual([1, 2, 3, 4]);
        expect(blocks.map((block) => block.beyondEnd)).toEqual([false, false, true, false]);
        expect(blocks.map((block) => block.clipped)).toEqual([false, true, false, false]);
        // a(0–2) 与 d(1–3) 真的同时出现；b 与 c 都在成片之外，不算在重叠里（它们都在末尾之后）。
        expect(blocks.map((block) => block.overlapping)).toEqual([true, false, false, true]);
        // c 整条在成片之外：left 钉在 100%、宽度 0，但原始起止一个数都没被改。
        expect(blocks[2]).toMatchObject({ left: 100, width: 0, start: 12, end: 14 });
        expect(blocks[1]!.left + blocks[1]!.width).toBe(100);
        expect(countEditSubtitlesBeyondEnd(blocks)).toBe(1);
    });

    it("成片总长为 0（时间线还是空的）时，每条都算在成片末尾之后——与属性区同一口径", () => {
        const blocks = editSubtitleBlocks([cue("a", 1, 2)], 0);

        expect(blocks[0]!.beyondEnd).toBe(true);
        expect(blocks[0]!.clipped).toBe(false);
        expect(blocks[0]!.left).toBe(0);
    });
});

describe("重叠区间：同一时刻有两条以上才算叠（纯函数）", () => {
    it("真正重叠的一段给出区间与条数", () => {
        expect(editSubtitleOverlapBands([cue("a", 1, 4), cue("b", 3, 5)])).toEqual([{ start: 3, end: 4, count: 2 }]);
    });

    it("首尾相接（一条 3 秒结束、另一条 3 秒开始）不算重叠——与属性区的 overlapping 统计同一口径", () => {
        expect(editSubtitleOverlapBands([cue("a", 1, 3), cue("b", 3, 5)])).toEqual([]);
    });

    it("同一时刻的终点先算：两条正好在 3 秒结束、第三条正好从 3 秒开始，count 仍然是 2 而不是 3", () => {
        // 同刻次序反过来（先算起点）时这一条会得到 count 3——把「正好接上」错报成「三条叠在一起」。
        expect(editSubtitleOverlapBands([cue("a", 1, 3), cue("b", 2, 3), cue("c", 3, 5)])).toEqual([{ start: 2, end: 3, count: 2 }]);
    });

    it("三条同时出现时合成一段，count 取该段内出现过的最大深度", () => {
        expect(editSubtitleOverlapBands([cue("a", 1, 6), cue("b", 2, 5), cue("c", 3, 4)])).toEqual([{ start: 2, end: 5, count: 3 }]);
    });

    it("深度掉回 1 再升上去时切成两段，不会糊成一整条", () => {
        expect(editSubtitleOverlapBands([cue("a", 1, 6), cue("b", 2, 3), cue("c", 4, 5)])).toEqual([
            { start: 2, end: 3, count: 2 },
            { start: 4, end: 5, count: 2 },
        ]);
    });

    it("没有重叠 / 空列表 / 零长度条目都不产生区间", () => {
        expect(editSubtitleOverlapBands([cue("a", 1, 2), cue("b", 5, 6)])).toEqual([]);
        expect(editSubtitleOverlapBands([])).toEqual([]);
        expect(editSubtitleOverlapBands([cue("a", 2, 2), cue("b", 2, 2)])).toEqual([]);
    });

    it("重叠的字幕在时间轴上就是叠着的：区间两端的百分比能直接当覆盖层的 left / width 用", () => {
        const band = editSubtitleOverlapBands([cue("a", 0, 6), cue("b", 4, 10)])[0]!;

        expect(band).toEqual({ start: 4, end: 6, count: 2 });
        expect(editSubtitlePlacement(band.start, band.end, 10)).toEqual({ left: timeToPercent(4, 10), width: timeToPercent(6, 10) - timeToPercent(4, 10) });
    });
});

describe("字幕起止的改动：拖块身与拖两端（纯函数）", () => {
    it("拖块身只平移：时长不变，起点不低于 0", () => {
        expect(moveEditSubtitle(1, 3, 5)).toEqual({ start: 5, end: 7 });
        expect(moveEditSubtitle(1, 3, -2)).toEqual({ start: 0, end: 2 });
        // 反复调用不会一点点磨掉时长（时长按原始两条边现算）。
        let pair = { start: 1, end: 3 };
        for (let step = 0; step < 50; step += 1) pair = moveEditSubtitle(pair.start, pair.end, pair.start + 0.1);
        expect(pair.end - pair.start).toBeCloseTo(2, 9);
    });

    it("拖块身可以拖到成片之外（上一轮明确允许），这里不偷偷把它拉回来", () => {
        expect(moveEditSubtitle(1, 3, 100)).toEqual({ start: 100, end: 102 });
    });

    it("目标值不是有限数时落回原来的起点，不产生 NaN", () => {
        expect(moveEditSubtitle(1, 3, Number.NaN)).toEqual({ start: 1, end: 3 });
    });

    it("拖两端只动一条边，并保证两条边之间至少留 EDIT_MIN_SUBTITLE_SECONDS", () => {
        expect(trimEditSubtitle(1, 3, "start", 2)).toEqual({ start: 2, end: 3 });
        expect(trimEditSubtitle(1, 3, "start", 9)).toEqual({ start: 3 - EDIT_MIN_SUBTITLE_SECONDS, end: 3 });
        expect(trimEditSubtitle(1, 3, "start", -5)).toEqual({ start: 0, end: 3 });
        expect(trimEditSubtitle(1, 3, "end", 0)).toEqual({ start: 1, end: 1 + EDIT_MIN_SUBTITLE_SECONDS });
        // 终点不设上界：允许落在成片之外，与导入时的语义一致。
        expect(trimEditSubtitle(1, 3, "end", 20)).toEqual({ start: 1, end: 20 });
    });

    it("拖两端的落点先吸附、再夹取；夹取把吸附结果拉走时不再算吸附成功", () => {
        const points = [{ seconds: 5, kind: "playhead" as const }];

        // 吸附点在合法区间里：落点就是它，导引线可以指过去。
        expect(resolveEditSubtitleEdge(4.9, "end", 1, 4.8, points, 0.5)).toEqual({ seconds: 5, snapped: true, point: points[0] });
        // 吸附点被最小间隔夹走：落点不是 1，导引线不能指着 1。
        const pulled = resolveEditSubtitleEdge(1.01, "start", 1, 1.02, [{ seconds: 1, kind: "grid" as const }], 0.5);
        expect(pulled.snapped).toBe(false);
        expect(pulled.seconds).toBe(1.02 - EDIT_MIN_SUBTITLE_SECONDS);
        // 没有候选点时永远不吸附。
        expect(resolveEditSubtitleEdge(4.9, "end", 1, 4.8, [], 0.5)).toEqual({ seconds: 4.9, snapped: false });
    });
});

describe("极短字幕的可点下限（常量契约）", () => {
    it("下限是渲染下限，不参与换算：宽度仍然是真值", () => {
        // 0.02 秒 / 9 秒在 1000px 宽的时间轴上只有 2px 出头——不给下限就抓不住。
        const placement = editSubtitlePlacement(2, 2.02, 9);

        expect(placement.width).toBeCloseTo(timeToPercent(0.02, 9), 12);
        expect(EDIT_SUBTITLE_MIN_PX).toBeGreaterThan(0);
    });
});
