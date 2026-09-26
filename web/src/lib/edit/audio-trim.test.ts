import { describe, expect, it } from "vitest";

import { editAudioTrimEdge, editAudioTrimFields, editAudioTrimWindow, resolveEditAudioTrim, type EditAudioTrimWindow } from "./audio-trim";
import { EDIT_MIN_TRIM_SECONDS, collectEditSnapPoints } from "./timeline-edit";

/**
 * 音轨**两端裁剪**的纯函数（时间线上拖音轨条的左端 / 右端）。
 *
 * 语义与视频片段的两端裁剪同形：
 * - 拖左端改**素材内的入点**：开头被砍掉，`start`（这条轨在成片里的起点）不动，整条轨变短；
 * - 拖右端改**素材内的出点**：结尾被砍掉，左端不动；
 * - 两条边之间至少留 EDIT_MIN_TRIM_SECONDS，出点不越过素材全长；
 * - 缺省（两个字段都 undefined）= 整条素材，与改动前逐字一致。
 *
 * 边界一律按「宁可不出声变化，也不能让整条轨静默消失 / 让 FFmpeg 拿到空流」处理：
 * 入点 ≥ 出点这类畸形数据整段作废，按没裁过算。
 */
describe("剪辑台音轨：两端裁剪的区间换算", () => {
    const MATERIAL = 30;

    it("缺省 / 0 就是整条素材：trimmed 为 false，长度就是素材全长（旧项目逐字一致）", () => {
        const plain = editAudioTrimWindow({}, MATERIAL);
        expect(plain).toEqual({ start: 0, end: 0, seconds: MATERIAL, trimmed: false });
        // 0 与缺省同一口径；出点等于素材末尾也按「到素材末尾」算（不留下多余的键）。
        expect(editAudioTrimWindow({ sourceStart: 0, sourceEnd: 0 }, MATERIAL)).toEqual(plain);
        expect(editAudioTrimWindow({ sourceEnd: MATERIAL }, MATERIAL)).toEqual(plain);
        // 没裁过时落盘的两个键都是 undefined（导出请求里连键都不出现）。
        expect(editAudioTrimFields(plain)).toEqual({ sourceStart: undefined, sourceEnd: undefined });
        expect(Object.keys(editAudioTrimFields(plain))).toEqual(["sourceStart", "sourceEnd"]);
    });

    it("拖左端：入点就是素材内的起点，长度只减不增", () => {
        const window = editAudioTrimWindow({ sourceStart: 5 }, MATERIAL);
        expect(window).toEqual({ start: 5, end: 0, seconds: 25, trimmed: true });
        expect(editAudioTrimFields(window)).toEqual({ sourceStart: 5, sourceEnd: undefined });
    });

    it("拖右端：出点就是素材内的终点，长度等于出点减入点", () => {
        const window = editAudioTrimWindow({ sourceStart: 5, sourceEnd: 12 }, MATERIAL);
        expect(window).toEqual({ start: 5, end: 12, seconds: 7, trimmed: true });
        expect(editAudioTrimFields(window)).toEqual({ sourceStart: 5, sourceEnd: 12 });
    });

    it("出点越过素材末尾按素材末尾算；素材时长未知时按出点算长度", () => {
        expect(editAudioTrimWindow({ sourceEnd: 99 }, MATERIAL)).toEqual({ start: 0, end: 0, seconds: MATERIAL, trimmed: false });
        // 时长未探测到（0）+ 有出点：长度只由出点算出来，波形仍画得出来。
        expect(editAudioTrimWindow({ sourceStart: 2, sourceEnd: 6 }, 0)).toEqual({ start: 2, end: 6, seconds: 4, trimmed: true });
        // 时长未探测到又没有出点：长度算不出来（0），与今天「不画波形」的降级一致。
        expect(editAudioTrimWindow({ sourceStart: 2 }, 0)).toEqual({ start: 2, end: 0, seconds: 0, trimmed: true });
    });

    it("入点 ≥ 出点、入点越过素材末尾、非有限值：整段裁剪作废，按整条素材算", () => {
        const plain = { start: 0, end: 0, seconds: MATERIAL, trimmed: false };
        // 空区间绝不能交给 FFmpeg（atrim=start=5:end=3 会产出空流，amix 的输入数随之对不上而整次出片失败），
        // 也不能把这条轨画成 0 长度让它静默消失。
        expect(editAudioTrimWindow({ sourceStart: 5, sourceEnd: 3 }, MATERIAL)).toEqual(plain);
        expect(editAudioTrimWindow({ sourceStart: 3, sourceEnd: 3 }, MATERIAL)).toEqual(plain);
        expect(editAudioTrimWindow({ sourceStart: 40 }, MATERIAL)).toEqual(plain);
        expect(editAudioTrimWindow({ sourceStart: Number.NaN, sourceEnd: Number.POSITIVE_INFINITY }, MATERIAL)).toEqual(plain);
        expect(editAudioTrimWindow({ sourceStart: -4 }, MATERIAL)).toEqual({ start: 0, end: 0, seconds: MATERIAL, trimmed: false });
    });

    it("拖某一条边时只动那一条边，并夹进合法区间（两条边至少留 0.1 秒）", () => {
        const plain = editAudioTrimWindow({}, MATERIAL);
        // 右端往左拖到 2 秒：只改出点。
        expect(editAudioTrimWindow({ sourceEnd: editAudioTrimEdge(plain, "end", 2, MATERIAL).end }, MATERIAL)).toEqual({ start: 0, end: 2, seconds: 2, trimmed: true });
        // 左端拖到 12 秒：只改入点（右端仍到素材末尾）。
        expect(editAudioTrimEdge(plain, "start", 12, MATERIAL)).toEqual({ start: 12, end: 0 });
        // 左端不能越过右端：两条边之间夹住 0.1 秒。
        const narrow = editAudioTrimWindow({ sourceStart: 3, sourceEnd: 5 }, MATERIAL);
        expect(editAudioTrimEdge(narrow, "start", 9, MATERIAL)).toEqual({ start: 5 - EDIT_MIN_TRIM_SECONDS, end: 5 });
        // 右端不能越过左端 + 0.1 秒，也不能越过素材全长。
        expect(editAudioTrimEdge(narrow, "end", 1, MATERIAL)).toEqual({ start: 3, end: 3 + EDIT_MIN_TRIM_SECONDS });
        expect(editAudioTrimEdge(narrow, "end", 999, MATERIAL)).toEqual({ start: 3, end: MATERIAL });
        // 落点保留三位小数（与吸附候选点的精度同一把尺子，吸附是否「真的吸上」才判得准）。
        expect(editAudioTrimEdge(narrow, "end", 4.12345, MATERIAL).end).toBe(4.123);
    });

    it("**裁掉开头不改 start**：这条轨仍从同一个成片时刻混入，只是内容改从素材更后面开始", () => {
        // startSeconds 只参与「素材内秒数 ↔ 成片时间轴」的换算，绝不参与区间本身。
        const trimmed = editAudioTrimWindow({ sourceStart: 5, sourceEnd: 15 }, MATERIAL);
        expect(trimmed.start).toBe(5);
        // 换算：素材内第 5 秒落在成片时间轴上的 8 + (5 − 5) = 8 秒（也就是这条轨的起点），
        // 素材内第 15 秒落在 8 + (15 − 5) = 18 秒 —— 右端比整条素材（8 + 30 = 38）提前结束。
        const atStart = resolveEditAudioTrim(8, { edge: "start", window: trimmed, startSeconds: 8, sourceSeconds: MATERIAL }, [], 0);
        const atEnd = resolveEditAudioTrim(18, { edge: "end", window: trimmed, startSeconds: 8, sourceSeconds: MATERIAL }, [], 0);
        expect(atStart.seconds).toBe(5);
        expect(atEnd.seconds).toBe(15);
    });

    it("吸附：候选点是**成片时间轴**上的位置，吸上之后再换回素材内秒数", () => {
        const window = editAudioTrimWindow({ sourceStart: 5 }, MATERIAL);
        // 候选点：成片第 8 秒（正是这条轨的起点）、第 12 秒。
        const points = collectEditSnapPoints([], { playhead: 12 });
        const target = { edge: "end" as const, window, startSeconds: 8, sourceSeconds: MATERIAL };
        // 拖右端到成片 11.98 秒（素材内 8.98 秒）：阈值 0.1 秒内吸到 12 秒 ⇒ 素材内 9 秒。
        const snapped = resolveEditAudioTrim(11.98, target, points, 0.1);
        expect(snapped.snapped).toBe(true);
        expect(snapped.seconds).toBe(9);
        expect(snapped.point?.seconds).toBe(12);
        // 同一个落点关掉吸附（阈值 0）：原样返回。
        const free = resolveEditAudioTrim(11.98, target, [], 0);
        expect(free.snapped).toBe(false);
        expect(free.seconds).toBe(8.98);
        // 夹取把吸附结果拉走时**不算吸上**（导引线就不会指着一个到不了的位置）：
        // 候选点在成片 40 秒（素材内 37 秒 > 素材全长 30），夹回 30 秒。
        const far = resolveEditAudioTrim(40, target, collectEditSnapPoints([], { playhead: 40 }), 0.1);
        expect(far.seconds).toBe(MATERIAL);
        expect(far.snapped).toBe(false);
    });
});

/**
 * 这一组把「与视频片段的两端裁剪同口径」钉死：最小长度就是那一个常量，
 * 而且音轨行不自己写第二套百分比 / 第二套夹取。
 */
describe("剪辑台音轨：两端裁剪与片段裁剪同口径", () => {
    it("最小长度与片段裁剪同一个常量（0.1 秒）", () => {
        expect(EDIT_MIN_TRIM_SECONDS).toBe(0.1);
        const window = editAudioTrimWindow({}, 10);
        expect(editAudioTrimEdge(window, "end", 0, 10).end).toBe(EDIT_MIN_TRIM_SECONDS);
    });

    it("落盘补丁只带「回到缺省就写 undefined」的那两个键", () => {
        const window: EditAudioTrimWindow = { start: 3, end: 0, seconds: 7, trimmed: true };
        expect(editAudioTrimFields(window)).toEqual({ sourceStart: 3, sourceEnd: undefined });
        // 拖回最左端 ⇒ 入点回缺省，键值为 undefined（旧项目语义）。
        expect(editAudioTrimFields(editAudioTrimWindow({ sourceStart: 0 }, 10))).toEqual({ sourceStart: undefined, sourceEnd: undefined });
    });
});
