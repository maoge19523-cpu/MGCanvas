import { describe, expect, it } from "vitest";

import { editWaveformBuckets, WAVEFORM_BUCKETS, waveformColumns, waveformHasSignal, waveformPointAt, waveformStripSeconds, waveformY } from "./waveform";

const f32 = (values: number[]) => Float32Array.from(values);

describe("波形：采样档位跟随时间线宽度", () => {
    it("宽度向上取到最近的档位，缩放时只有跨档才重新计算", () => {
        expect(editWaveformBuckets(0)).toBe(256);
        expect(editWaveformBuckets(1)).toBe(256);
        expect(editWaveformBuckets(256)).toBe(256);
        expect(editWaveformBuckets(257)).toBe(512);
        expect(editWaveformBuckets(900)).toBe(1024);
        expect(editWaveformBuckets(1024)).toBe(1024);
    });

    it("超宽与异常输入都不会越出档位表", () => {
        expect(editWaveformBuckets(99_999)).toBe(WAVEFORM_BUCKETS[WAVEFORM_BUCKETS.length - 1]);
        expect(editWaveformBuckets(Number.NaN)).toBe(256);
        expect(editWaveformBuckets(-100)).toBe(256);
    });

    it("档位表从小到大排列，最大档位不至于让 IPC 负载失控", () => {
        expect([...WAVEFORM_BUCKETS]).toEqual([...WAVEFORM_BUCKETS].sort((left, right) => left - right));
        expect(Math.max(...WAVEFORM_BUCKETS)).toBeLessThanOrEqual(4096);
    });
});

describe("波形：波形条在时间线上占多长", () => {
    it("不循环时按自身时长，且不超过全片", () => {
        expect(waveformStripSeconds(20, 9, false)).toBe(9);
        expect(waveformStripSeconds(4, 9, false)).toBe(4);
    });

    it("循环（loop）时铺满全片，与 FFmpeg 的 -stream_loop -1 一致", () => {
        expect(waveformStripSeconds(4, 9, true)).toBe(9);
        expect(waveformStripSeconds(20, 9, true)).toBe(9);
    });

    it("时长缺失或全片为空时不占位置", () => {
        expect(waveformStripSeconds(0, 9, false)).toBe(0);
        expect(waveformStripSeconds(4, 0, true)).toBe(0);
        expect(waveformStripSeconds(Number.NaN, 9, false)).toBe(0);
    });
});

describe("波形：秒数 → 采样点换算", () => {
    it("按比例映射并夹在有效范围内", () => {
        expect(waveformPointAt(0, 4, false, 100)).toBe(0);
        expect(waveformPointAt(2, 4, false, 100)).toBe(50);
        expect(waveformPointAt(3.99, 4, false, 100)).toBe(99);
        expect(waveformPointAt(4, 4, false, 100)).toBe(99);
        expect(waveformPointAt(99, 4, false, 100)).toBe(99);
        expect(waveformPointAt(-1, 4, false, 100)).toBe(0);
    });

    it("循环音轨按自身时长回卷", () => {
        expect(waveformPointAt(5, 4, true, 100)).toBe(25);
        expect(waveformPointAt(9, 4, true, 100)).toBe(25);
        expect(waveformPointAt(5, 4, false, 100)).toBe(99);
    });

    it("没有数据时返回 -1", () => {
        expect(waveformPointAt(1, 4, false, 0)).toBe(-1);
        expect(waveformPointAt(1, 0, false, 100)).toBe(-1);
    });
});

describe("波形：峰值 → canvas 每一列", () => {
    it("按列聚合区间内的极值，不把尖峰平均掉", () => {
        // 断言用精确相等的浮点值（都是二进制有限小数），避免 Float32Array 的舍入噪声。
        const peaks = f32([0.25, 0.75, 0.5, 0.375]);
        const troughs = f32([-0.25, -0.75, -0.5, -0.375]);
        const columns = waveformColumns(peaks, troughs, 2, 4, 4, false);
        expect(columns).toEqual([
            { peak: 0.75, trough: -0.75 },
            { peak: 0.5, trough: -0.5 },
        ]);
    });

    it("列数多于采样点时每列都有值，不出现空列", () => {
        const columns = waveformColumns(f32([0.5, -0.5]), f32([-0.5, 0.5]), 8, 2, 2, false);
        expect(columns).toHaveLength(8);
        expect(columns.every((column) => Number.isFinite(column.peak) && Number.isFinite(column.trough))).toBe(true);
        expect(columns[0]).toEqual({ peak: 0.5, trough: -0.5 });
        expect(columns[7]).toEqual({ peak: -0.5, trough: 0.5 });
    });

    it("循环音轨的重复段与首段一致，接缝列不会混入两端极值", () => {
        const peaks = f32([0.25, 0.5, 0.75, 0.375]);
        const troughs = f32([-0.25, -0.5, -0.75, -0.375]);
        const columns = waveformColumns(peaks, troughs, 8, 8, 4, true);
        expect(columns).toHaveLength(8);
        // 前 4 列与后 4 列是同一个循环的两遍。
        expect(columns.slice(4)).toEqual(columns.slice(0, 4));
        // 回卷的那一列只取循环末尾（0.375），不该把整段最大 0.75 糊上来。
        expect(columns[3]).toEqual({ peak: 0.375, trough: -0.375 });
    });

    it("空包络 / 零列宽降级为全 0 列（调用方画中位线）", () => {
        const empty = waveformColumns(f32([]), f32([]), 4, 4, 4, false);
        expect(empty).toEqual([
            { peak: 0, trough: 0 },
            { peak: 0, trough: 0 },
            { peak: 0, trough: 0 },
            { peak: 0, trough: 0 },
        ]);
        // 时长缺失（strip / audio 为 0）时同样是全 0 列，不能算出 NaN。
        expect(waveformColumns(f32([0.5, 0.5]), f32([-0.5, -0.5]), 2, 0, 0, false)).toEqual([
            { peak: 0, trough: 0 },
            { peak: 0, trough: 0 },
        ]);
        expect(waveformColumns(f32([0.5]), f32([-0.5]), 0, 4, 4, false)).toEqual([]);
    });
});

describe("波形：幅度 → canvas 坐标", () => {
    it("0 落在中位线，±1 各留 1px 不贴边", () => {
        expect(waveformY(0, 10)).toBe(5);
        expect(waveformY(1, 10)).toBe(1);
        expect(waveformY(-1, 10)).toBe(9);
        expect(waveformY(0.5, 10)).toBe(3);
    });

    it("越界与非法值都不会把点画到画布外", () => {
        expect(waveformY(2, 10)).toBe(1);
        expect(waveformY(-2, 10)).toBe(9);
        expect(waveformY(Number.NaN, 10)).toBe(5);
        // 高度很小时不出现负高度。
        expect(waveformY(1, 2)).toBe(1);
    });
});

describe("波形：有无真实信号（降级判断）", () => {
    it("空包络与全 0 都判为没有信号", () => {
        expect(waveformHasSignal(f32([]), f32([]))).toBe(false);
        expect(waveformHasSignal(f32([0, 0, 0]), f32([0, 0, 0]))).toBe(false);
        expect(waveformHasSignal(f32([1e-5]), f32([-1e-5]))).toBe(false);
    });

    it("任一侧有幅度都算有信号", () => {
        expect(waveformHasSignal(f32([0, 0.5]), f32([0, 0]))).toBe(true);
        expect(waveformHasSignal(f32([0, 0]), f32([0, -0.9]))).toBe(true);
    });
});
