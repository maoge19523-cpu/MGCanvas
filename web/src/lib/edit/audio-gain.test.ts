import { describe, expect, it } from "vitest";

import {
    EDIT_GAIN_Y_INSET,
    EDIT_VOLUME_DB_SPAN,
    EDIT_VOLUME_FLOOR_DB,
    EDIT_VOLUME_MAX,
    EDIT_VOLUME_UNITY_RATIO,
    editAudioGainShape,
    editGainAreaText,
    editGainHeightPercent,
    editGainPointsText,
    editVolumeDb,
    editVolumeFromDrag,
    editVolumeFromRatio,
    editVolumeLabel,
    editVolumeRatio,
    editVolumeReadout,
    editVolumeSnap,
    editVolumeStep,
} from "@/lib/edit/audio-gain";

/** 取值域里的全部音量（0% ~ 400%，步长 5%）：往返换算的对照表就用它。 */
const GRID = Array.from({ length: 81 }, (_, index) => Number((index * 0.05).toFixed(2)));

describe("音量 → 高度：分贝映射（0 dB 落在 75%，听感与高度成正比）", () => {
    it("0 dB（100% 原始音量）落在 75% 高度，+12 dB（400%）在顶端，0% 在底端", () => {
        expect(EDIT_VOLUME_UNITY_RATIO).toBe(0.75);
        expect(editVolumeDb(1)).toBe(0);
        expect(editVolumeRatio(1)).toBe(0.75);
        // 400% 是 +12.04 dB，超出 +12 dB 的上端，按顶端处理（与导出的 clamp(0,4) 同口径）。
        expect(editVolumeDb(EDIT_VOLUME_MAX)).toBeGreaterThan(12);
        expect(editVolumeRatio(EDIT_VOLUME_MAX)).toBe(1);
        expect(editVolumeRatio(0)).toBe(0);
        expect(editVolumeRatio(-1)).toBe(0);
        expect(editVolumeRatio(Number.NaN)).toBe(0);
        // 越界数据（手改 / 老数据）也夹进 [0,1]，不会画出界。
        expect(editVolumeRatio(99)).toBe(1);
    });

    it("每 -6 dB 下降固定的高度：听感上等距的音量在高度上也等距", () => {
        // 48 dB 均分整行高度：等距的分贝差 = 等距的高度差（0.5× 与 2× 相对 1× 各差 6.02 dB）。
        const stepDown = editVolumeRatio(1) - editVolumeRatio(0.5);
        const stepDownAgain = editVolumeRatio(0.5) - editVolumeRatio(0.25);
        const stepUp = editVolumeRatio(2) - editVolumeRatio(1);
        expect(stepDown).toBeCloseTo(stepDownAgain, 9);
        expect(stepUp).toBeCloseTo(stepDown, 9);
        // 也就是 6.02 dB ÷ 48 dB 的高度。
        expect(stepDown).toBeCloseTo(6.0206 / EDIT_VOLUME_DB_SPAN, 3);
        expect(editVolumeRatio(0.5)).toBeCloseTo((editVolumeDb(0.5)! - EDIT_VOLUME_FLOOR_DB) / EDIT_VOLUME_DB_SPAN, 12);
        // 单调递增：听感上更响的音量一定画得更高。
        for (let index = 1; index < GRID.length; index += 1) expect(editVolumeRatio(GRID[index]!)).toBeGreaterThan(editVolumeRatio(GRID[index - 1]!));
    });

    it("-36 dB 以下贴底、没有分贝可言的 0 返回 null", () => {
        expect(editVolumeDb(0)).toBeNull();
        expect(editVolumeDb(Number.NaN)).toBeNull();
        // 0.05（−26 dB）仍在刻度内；比 −36 dB 更低的音量按底端处理。
        expect(editVolumeRatio(0.01)).toBe(0);
        expect(editVolumeRatio(0.05)).toBeCloseTo((editVolumeDb(0.05)! - EDIT_VOLUME_FLOOR_DB) / EDIT_VOLUME_DB_SPAN, 12);
    });

    it("分贝 → 音量的逆映射是往返一致的（整张 5% 网格都不丢值）", () => {
        for (const volume of GRID) {
            expect(editVolumeFromRatio(editVolumeRatio(volume))).toBe(volume);
        }
        // 两端严格落在取值域的端点上。
        expect(editVolumeFromRatio(0)).toBe(0);
        expect(editVolumeFromRatio(1)).toBe(EDIT_VOLUME_MAX);
        expect(editVolumeFromRatio(-5)).toBe(0);
        expect(editVolumeFromRatio(9)).toBe(EDIT_VOLUME_MAX);
        expect(editVolumeFromRatio(Number.NaN)).toBe(0);
    });

    it("读数：百分比 + 分贝；0% 写成 −∞ dB", () => {
        expect(editVolumeLabel(1)).toBe("100%");
        expect(editVolumeLabel(0.35)).toBe("35%");
        expect(editVolumeReadout(1)).toBe("100% · 0.0 dB");
        expect(editVolumeReadout(2)).toBe("200% · 6.0 dB");
        expect(editVolumeReadout(0.5)).toBe("50% · -6.0 dB");
        expect(editVolumeReadout(0)).toBe("0% · -∞ dB");
    });

    it("对齐步长与夹取：所有落点都落在 5% 网格上、且不越出 [0,400%]", () => {
        expect(editVolumeSnap(1.013)).toBe(1);
        expect(editVolumeSnap(1.03)).toBe(1.05);
        expect(editVolumeSnap(-3)).toBe(0);
        expect(editVolumeSnap(9)).toBe(4);
        expect(editVolumeSnap(Number.NaN)).toBe(0);
        for (const volume of [1.023, 0.027, 3.999, -1]) expect(Number((editVolumeSnap(volume) / 0.05).toFixed(6)) % 1).toBe(0);
    });
});

describe("拖动位移 → 新音量（1 像素 = 1/行高，吸附 100%）", () => {
    const ROW = 36;

    it("向上拖变响、向下拖变轻，位移与画出来的高度是同一把尺子", () => {
        // 从 100% 出发向上拖 6px：行高的 1/6 = 48 dB 的 1/6 = 8 dB ≈ 2.5×（落在 5% 步长上就是 250%）。
        const louder = editVolumeFromDrag(1, 6, ROW);
        expect(louder).toBe(2.5);
        expect(editVolumeRatio(louder) - editVolumeRatio(1)).toBeCloseTo(6 / ROW, 2);
        const quieter = editVolumeFromDrag(1, -6, ROW);
        expect(quieter).toBe(0.4);
        expect(editVolumeRatio(1) - editVolumeRatio(quieter)).toBeCloseTo(6 / ROW, 2);
        // 拖同样多像素、方向相反，回到出发点（步长对齐允许一个步长的差）。
        expect(Math.abs(editVolumeFromDrag(louder, -6, ROW) - 1)).toBeLessThanOrEqual(0.05);
    });

    it("吸附到 100%（0 dB）：±2px 内落在 100%，超出吸附半径就照常跟随", () => {
        // 从 105% 往下拖 1px（≈1.3 dB，落点约 99%）：在吸附半径内 → 落在 100%。
        expect(editVolumeFromDrag(1.05, -1, ROW)).toBe(1);
        // 从 110% 往下拖 3.6px（≈4.8 dB，落点约 63%）：超出半径 → 不吸附。
        expect(editVolumeFromDrag(1.1, -3.6, ROW)).toBe(0.65);
        // 从 105% 往上拖 3px：同样超出半径 → 照常跟随（约 165%）。
        expect(editVolumeFromDrag(1.05, 3, ROW)).toBe(1.65);
        // 吸附半径按行高等比换算：行高翻倍时同样的像素位移只算一半。
        expect(editVolumeFromDrag(1, 18, ROW)).toBe(editVolumeFromDrag(1, 36, ROW * 2));
        // 按一下不动（位移 0 / 非有限值）时保持原值：起点就在吸附半径里也不会自己跳走。
        expect(editVolumeFromDrag(0.75, 0, ROW)).toBe(0.75);
        expect(editVolumeFromDrag(0.75, Number.NaN, ROW)).toBe(0.75);
    });

    it("上下限：拖出顶端 = 400%，拖到底端 = 0%（与属性区输入框的 min / max 一致）", () => {
        expect(editVolumeFromDrag(1, 999, ROW)).toBe(EDIT_VOLUME_MAX);
        expect(editVolumeFromDrag(1, -999, ROW)).toBe(0);
        expect(editVolumeFromDrag(EDIT_VOLUME_MAX, 999, ROW)).toBe(EDIT_VOLUME_MAX);
        expect(editVolumeFromDrag(0, -999, ROW)).toBe(0);
    });

    it("行高无效 / 位移非有限值时保持原值（不会把音量算成 NaN）", () => {
        expect(editVolumeFromDrag(0.75, 10, 0)).toBe(0.75);
        expect(editVolumeFromDrag(0.75, Number.NaN, ROW)).toBe(0.75);
        // 起点的音量本身是畸形值（非有限）时按 0 处理，拖动结果照样落在合法网格上。
        expect(editVolumeFromDrag(Number.NaN, 10, ROW)).toBe(0.05);
        expect(editVolumeFromDrag(Number.NaN, Number.NaN, ROW)).toBe(0);
    });

    it("键盘每次一步（5%），到端点为止", () => {
        expect(editVolumeStep(1, 1)).toBe(1.05);
        expect(editVolumeStep(1, -1)).toBe(0.95);
        // 不在网格上的存量值先对齐再加减。
        expect(editVolumeStep(1.013, 1)).toBe(1.05);
        expect(editVolumeStep(EDIT_VOLUME_MAX, 1)).toBe(EDIT_VOLUME_MAX);
        expect(editVolumeStep(0, -1)).toBe(0);
    });
});

describe("淡入淡出坡度：秒数与增益", () => {
    // 60 秒成片、20 秒音轨、从 0 秒起混入：能占 20 秒。
    const GEO = { start: 0, seconds: 20, total: 60 };
    const gains = (points: Array<{ gain: number }>) => points.map((point) => Number(point.gain.toFixed(6)));
    const times = (points: Array<{ seconds: number }>) => points.map((point) => point.seconds);

    it("淡入 2 秒 / 淡出 3 秒：折点正好落在 0 / 2 / 17 / 20 秒，增益 0 → 1 → 1 → 0", () => {
        const shape = editAudioGainShape({ volume: 1, fadeIn: 2, fadeOut: 3 }, GEO);

        expect(times(shape.points)).toEqual([0, 2, 17, 20]);
        expect(gains(shape.points)).toEqual([0, 1, 1, 0]);
        expect(shape.fadeIn).toBe(2);
        expect(shape.fadeOut).toBe(3);
        expect(shape.overlap).toBe(false);
        expect(shape.ratio).toBe(0.75);
        // 60 秒成片、淡出 3 秒：导出锚点在 57 秒，比音频终点（20 秒）还晚 → 这段淡出在成片里不会发生。
        expect(shape.exportFadeOutStart).toBe(57);
        expect(shape.fadeOutAnchor).toBe("unheard");
    });

    it("淡入 / 淡出为 0：折线只有两个点、且两点都等于音量本身（不画零宽坡度）", () => {
        const shape = editAudioGainShape({ volume: 0.5, fadeIn: 0, fadeOut: 0 }, GEO);

        expect(times(shape.points)).toEqual([0, 20]);
        // 整条折线没有任何斜率：两个点的高度就是音量线的高度。
        expect(gains(shape.points)).toEqual([0.5, 0.5]);
        expect(shape.overlap).toBe(false);
        expect(shape.fadeInClamped).toBe(false);
        expect(shape.fadeOutClamped).toBe(false);
    });

    it("起点偏移：整条坡度都是成片时间轴上的绝对秒数（淡入从起点起算，淡出到「起点 + 能占的秒数」）", () => {
        const shape = editAudioGainShape({ volume: 1, fadeIn: 1.5, fadeOut: 2 }, { start: 40, seconds: 15, total: 60 });

        expect(times(shape.points)).toEqual([40, 41.5, 53, 55]);
        expect(gains(shape.points)).toEqual([0, 1, 1, 0]);
        // 55 + 2 = 57 是音频终点之后的锚点（成片末尾 57 − …）：锚点 57 落在音频终点 55 之后 → 听不到。
        expect(shape.exportFadeOutStart).toBe(58);
        expect(shape.fadeOutAnchor).toBe("unheard");
    });

    it("音轨铺满起点之后的剩余时长（loop / 音频比成片长）：淡出锚点与画出的坡度严格一致", () => {
        const shape = editAudioGainShape({ volume: 1, fadeIn: 1, fadeOut: 2 }, { start: 0, seconds: 60, total: 60 });
        expect(times(shape.points)).toEqual([0, 1, 58, 60]);
        expect(shape.exportFadeOutStart).toBe(58);
        expect(shape.fadeOutAnchor).toBe("none");

        // 起点 50 秒、能占 10 秒（铺到成片末尾）：锚点 58 秒 == 画出的淡出起点。
        const tail = editAudioGainShape({ volume: 1, fadeIn: 1, fadeOut: 2 }, { start: 50, seconds: 10, total: 60 });
        expect(times(tail.points)).toEqual([50, 51, 58, 60]);
        expect(tail.fadeOutAnchor).toBe("none");

        // 5 秒音轨从第 55 秒起、淡出填了 8 秒（比音轨还长）：画到音轨边界（55~60），
        // 而导出的锚点在 52 秒（更早、更缓）→ 与画出来的不一致，标成 shifted。
        const shifted = editAudioGainShape({ volume: 1, fadeIn: 0, fadeOut: 8 }, { start: 55, seconds: 5, total: 60 });
        expect(times(shifted.points)).toEqual([55, 60]);
        expect(shifted.fadeOutClamped).toBe(true);
        expect(shifted.exportFadeOutStart).toBe(52);
        expect(shifted.fadeOutAnchor).toBe("shifted");
    });

    /**
     * 裁过之后导出读的是**裁剪后那一段内容的末尾**（Rust 侧 track_fade_out_start 收到的是内容长度），
     * 所以这里也必须跟着走：否则「裁短了却仍按成片末尾起淡出」，行上会报一句假的 unheard。
     */
    it("裁过的音轨：导出锚点落在留下的那一段末尾，不再报一句假的 unheard", () => {
        // 素材 30 秒、裁成 5~15 秒（内容 10 秒）、起点 0、成片 60 秒、淡出 2 秒：
        // 没裁过时锚点在 58 秒（成片末尾 − 2），早就越过了内容末尾 10 秒 ⇒ 会被标成 unheard。
        const untrimmed = editAudioGainShape({ volume: 1, fadeIn: 0, fadeOut: 2 }, { start: 0, seconds: 10, total: 60 });
        expect(untrimmed.exportFadeOutStart).toBe(58);
        expect(untrimmed.fadeOutAnchor).toBe("unheard");
        // 裁过之后锚点跟着内容末尾走：10 − 2 = 8 秒，与画出的坡度起点严格一致。
        const trimmed = editAudioGainShape({ volume: 1, fadeIn: 0, fadeOut: 2 }, { start: 0, seconds: 10, total: 60, trimmed: true });
        expect(trimmed.exportFadeOutStart).toBe(8);
        expect(trimmed.fadeOutAnchor).toBe("none");
        // 起点 20 秒、成片只剩 40 秒时长可用（内容 10 秒铺不满）：锚点仍在内容末尾（20 + 8 = 28）。
        const late = editAudioGainShape({ volume: 1, fadeIn: 0, fadeOut: 2 }, { start: 20, seconds: 10, total: 60, trimmed: true });
        expect(late.exportFadeOutStart).toBe(28);
        expect(late.fadeOutAnchor).toBe("none");
        // 锚点绝不早于这条轨的起点（淡出最多从它一开口就开始）。
        const tiny = editAudioGainShape({ volume: 1, fadeIn: 0, fadeOut: 10 }, { start: 20, seconds: 3, total: 60, trimmed: true });
        expect(tiny.exportFadeOutStart).toBe(20);
        expect(tiny.fadeOutAnchor).toBe("none");
        // 内容铺满成片（loop / 裁得只剩一段但成片更短）：锚点与成片末尾一致，与没裁过时同一个位置。
        const full = editAudioGainShape({ volume: 1, fadeIn: 0, fadeOut: 2 }, { start: 0, seconds: 60, total: 60, trimmed: true });
        expect(full.exportFadeOutStart).toBe(58);
        expect(full.fadeOutAnchor).toBe("none");
    });

    it("淡入 + 淡出 超过音轨时长：两条坡度相乘，重叠区到不了满音量，采样点落在重叠区里", () => {        // 10 秒音轨、淡入 4 秒 + 淡出 8 秒 = 12 秒 > 10 秒：重叠区 = [2, 4]。
        const shape = editAudioGainShape({ volume: 1, fadeIn: 4, fadeOut: 8 }, { start: 0, seconds: 10, total: 10 });

        expect(shape.overlap).toBe(true);
        expect(shape.fadeIn).toBe(4);
        expect(shape.fadeOut).toBe(8);
        // 折点 4 个 + 重叠区里的 5 个相乘采样点。
        expect(shape.points).toHaveLength(9);
        expect([shape.points[0]!.seconds, shape.points[1]!.seconds, shape.points[7]!.seconds, shape.points[8]!.seconds]).toEqual([0, 2, 4, 10]);
        // 重叠区里的采样点严格落在 (2, 4) 内，增益单调上升且始终小于 1：
        // 相乘的抛物线顶点在音轨中点（5 秒）上，而 5 秒已经在重叠区之外，所以这一段是单调的。
        const inside = shape.points.slice(2, 7);
        for (const point of inside) expect(point.seconds).toBeGreaterThan(2);
        for (const point of inside) expect(point.seconds).toBeLessThan(4);
        expect(inside.map((point) => Number(point.gain.toFixed(4)))).toEqual([0.559, 0.6111, 0.6563, 0.6944, 0.7257]);
        for (let index = 1; index < inside.length; index += 1) expect(inside[index]!.gain).toBeGreaterThan(inside[index - 1]!.gain);
        // 全段都到不了满音量。
        for (const point of shape.points) expect(point.gain).toBeLessThan(1);
    });

    it("淡入（或淡出）比音轨还长：画到音轨边界为止，并标出被截短", () => {
        const short = editAudioGainShape({ volume: 1, fadeIn: 5, fadeOut: 0 }, { start: 0, seconds: 3, total: 60 });

        expect(short.fadeIn).toBe(3);
        expect(short.fadeInClamped).toBe(true);
        expect(times(short.points)).toEqual([0, 3]);
        expect(gains(short.points)).toEqual([0, 1]);

        const out = editAudioGainShape({ volume: 1, fadeIn: 0, fadeOut: 4 }, { start: 0, seconds: 3, total: 60 });
        expect(out.fadeOut).toBe(3);
        expect(out.fadeOutClamped).toBe(true);
        expect(times(out.points)).toEqual([0, 3]);
        expect(gains(out.points)).toEqual([1, 0]);
    });

    it("淡入淡出的上限与导出 / 属性区一致（5 秒 / 10 秒）：超出的值先夹到上限再画", () => {
        const shape = editAudioGainShape({ volume: 1, fadeIn: 99, fadeOut: 99 }, { start: 0, seconds: 60, total: 60 });
        expect(shape.fadeIn).toBe(5);
        expect(shape.fadeOut).toBe(10);
        expect(shape.fadeInClamped).toBe(false);
    });

    it("volume = 0：折线贴底（导出里 volume=0 就是整条静音），但仍有点可画", () => {
        const shape = editAudioGainShape({ volume: 0, fadeIn: 1, fadeOut: 1 }, GEO);
        expect(shape.ratio).toBe(0);
        expect(shape.points.length).toBeGreaterThan(0);
        for (const point of shape.points) expect(point.gain).toBe(0);
    });

    it("能占 0 秒（起点落在成片末尾之后 / 成片为空）时没有折线，调用方整块不渲染", () => {
        expect(editAudioGainShape({ volume: 1, fadeIn: 1, fadeOut: 1 }, { start: 60, seconds: 0, total: 60 }).points).toEqual([]);
        expect(editAudioGainShape({ volume: 1, fadeIn: 1, fadeOut: 1 }, { start: 0, seconds: 0, total: 0 }).points).toEqual([]);
        expect(editAudioGainShape({ volume: 1, fadeIn: 1, fadeOut: 1 }, { start: 0, seconds: 20, total: 0 }).points).toEqual([]);
        // 时间与秒数非有限值同样不会算成 NaN。
        const nan = editAudioGainShape({ volume: 1, fadeIn: Number.NaN, fadeOut: Number.NaN }, { start: Number.NaN, seconds: Number.NaN, total: 60 });
        expect(nan.points.every((point) => Number.isFinite(point.gain) && Number.isFinite(point.seconds))).toBe(true);
    });
});

describe("折线的坐标：横轴走 timeline-scale，纵轴走同一套高度映射", () => {
    it("x 就是 timeToPercent（与标尺 / 波形条同一套换算），y 是行高的百分比且上下留白", () => {
        const shape = editAudioGainShape({ volume: 1, fadeIn: 2, fadeOut: 3 }, { start: 0, seconds: 20, total: 60 });
        const text = editGainPointsText(shape, 60);
        const points = text.split(" ").map((pair) => pair.split(",").map(Number) as [number, number]);

        expect(points).toHaveLength(4);
        // 0 / 2 / 17 / 20 秒 → 各自占 60 秒成片的百分比（与标尺刻度严格同一个数）。
        expect(points.map((point) => point[0])).toEqual([0, (2 / 60) * 100, (17 / 60) * 100, (20 / 60) * 100]);
        // y：增益 0 → 底端留白处，增益 1（0 dB，75% 高度）→ 26.5。
        expect(points[0]![1]).toBe(editGainHeightPercent(0));
        expect(points[0]![1]).toBe(100 - EDIT_GAIN_Y_INSET);
        expect(points[1]![1]).toBe(editGainHeightPercent(0.75));
        expect(points[1]![1]).toBe(26.5);
    });

    it("面积串 = 折线 + 沿基线收口；没有折线时是空串", () => {
        const shape = editAudioGainShape({ volume: 1, fadeIn: 1, fadeOut: 0 }, { start: 0, seconds: 20, total: 60 });
        const area = editGainAreaText(shape, 60).split(" ");

        expect(area).toHaveLength(shape.points.length + 2);
        expect(area[0]).toBe(`${(0 / 60) * 100},${editGainHeightPercent(0)}`);
        expect(area[area.length - 1]).toBe(`${(0 / 60) * 100},${editGainHeightPercent(0)}`);
        expect(editGainAreaText(editAudioGainShape({ volume: 1, fadeIn: 1, fadeOut: 1 }, { start: 9, seconds: 0, total: 9 }), 9)).toBe("");
    });
});
