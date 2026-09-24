import { describe, expect, it } from "vitest";

import {
    EDIT_SNAP_THRESHOLD_PX,
    EDIT_SNAP_VELOCITY_LIMIT,
    collectEditSnapPoints,
    deleteEditClip,
    editClipIndexAt,
    editGridStep,
    editReorderIndex,
    editSecondsInsideClip,
    editSnapThresholdSeconds,
    isEditSnapSuppressed,
    resolveEditSnap,
    splitEditClip,
} from "./timeline-edit";
import { buildEditClips } from "./timeline";
import type { EditClip, EditMedia } from "@/types/edit";

function media(id: string, seconds: number | undefined): EditMedia {
    return { id, name: `素材${id.toUpperCase()}`, kind: "video", source: "local", url: `blob:${id}`, durationMs: seconds === undefined ? undefined : Math.round(seconds * 1000), createdAt: "2024-01-01T00:00:00.000Z" };
}

function clip(id: string, mediaId: string, patch: Partial<EditClip> = {}): EditClip {
    return { id, mediaId, start: 0, end: 0, volume: 1, fadeIn: 0, fadeOut: 0, ...patch };
}

// c1: 全局 0–4s（素材 1–5s）；c2: 4–9s（素材 0–5s）；c3: 9–12s（素材 0.5–3.5s）。
const MEDIA = [media("a", 6), media("b", 5), media("c", 4)];
const CLIPS = [clip("c1", "a", { start: 1, end: 5 }), clip("c2", "b"), clip("c3", "c", { start: 0.5, end: 3.5 })];
const VIEWS = buildEditClips(MEDIA, CLIPS);

describe("剪辑台吸附：阈值换算", () => {
    it("按像素阈值与当前缩放换算成秒，并跟随缩放变化", () => {
        // 600px 宽铺 12s：每秒 50px，40px 就是 0.8s。
        expect(editSnapThresholdSeconds(600, 12)).toBeCloseTo(0.8, 6);
        // 同样内容放大到 1200px：每秒 100px，40px 变成 0.4s。
        expect(editSnapThresholdSeconds(1200, 12)).toBeCloseTo(0.4, 6);
        expect(EDIT_SNAP_THRESHOLD_PX).toBe(40);
    });

    it("宽度或总时长无效时阈值取 0（等于不吸附），不会出现 Infinity / NaN", () => {
        expect(editSnapThresholdSeconds(0, 12)).toBe(0);
        expect(editSnapThresholdSeconds(600, 0)).toBe(0);
        expect(editSnapThresholdSeconds(Number.NaN, 12)).toBe(0);
        expect(editSnapThresholdSeconds(600, 12, 0)).toBe(0);
    });

    it("网格取标尺当前那一档刻度，屏幕上看得见的网格才吸附", () => {
        expect(editGridStep(12)).toBe(2);
        expect(editGridStep(3)).toBe(0.5);
    });
});

describe("剪辑台吸附：候选点与优先级", () => {
    const points = collectEditSnapPoints(VIEWS, { playhead: 6.15, grid: editGridStep(12), excludeClipIds: ["c1"] });

    it("候选点包含其余片段的头尾、播放头与网格，且不含被拖片段自己的边缘", () => {
        expect(points.filter((point) => point.kind === "playhead")).toEqual([{ seconds: 6.15, kind: "playhead" }]);
        // c1 被排除：它自己的 0 不再是片段边缘（4 是 c2 的起点，仍然保留）。
        expect(points.some((point) => point.seconds === 0 && point.kind === "clip-start")).toBe(false);
        expect(points).toContainEqual({ seconds: 4, kind: "clip-start" });
        expect(points).toContainEqual({ seconds: 9, kind: "clip-start" });
        expect(points).toContainEqual({ seconds: 9, kind: "clip-end" });
        expect(points).toContainEqual({ seconds: 12, kind: "clip-end" });
        expect(points.filter((point) => point.kind === "grid").map((point) => point.seconds)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    });

    it("同距离时相邻片段边缘优先于网格", () => {
        // 4.05 距离片段边缘（c2 的 clip-start=4）与网格点 4 都是 0.05。
        const result = resolveEditSnap(4.05, 0, points, 0.5);
        expect(result.snapped).toBe(true);
        expect(result.seconds).toBe(4);
        expect(result.point?.kind).toBe("clip-start");
    });

    it("片段边缘不在阈值内时播放头优先于网格", () => {
        // 6.1：离播放头 6.15 是 0.05，离网格点 6 是 0.1。
        const result = resolveEditSnap(6.1, 0, points, 0.5);
        expect(result.point?.kind).toBe("playhead");
        expect(result.seconds).toBe(6.15);
    });

    it("网格兜底：没有片段边缘与播放头时吸到最近的网格点", () => {
        const only = collectEditSnapPoints(VIEWS, { grid: editGridStep(12), excludeClipIds: ["c1"] });
        const result = resolveEditSnap(8.15, 0, only.filter((point) => point.kind === "grid"), 0.5);
        expect(result.snapped).toBe(true);
        expect(result.seconds).toBe(8);
    });

    it("超出阈值就完全不吸附，原值返回", () => {
        const result = resolveEditSnap(7.5, 0, points, 0.1);
        expect(result).toEqual({ seconds: 7.5, snapped: false });
    });

    it("带时长的拖动会同时比较首尾：末尾贴近候选点时按末尾吸附", () => {
        // 一段 2s 的片段放在 8.05：起点离网格 8 是 0.05，终点 10.05 离网格 10 也是 0.05，
        // 起点更近所以起点被吸附到 8。
        expect(resolveEditSnap(8.05, 2, points, 0.5).seconds).toBe(8);
        // 放在 7.9：终点 9.9 离片段边缘 9 是 0.9（超阈值），起点离网格 8 是 0.1 → 起点吸附。
        expect(resolveEditSnap(7.9, 2, points, 0.5).seconds).toBe(8);
        // 放在 7.05：终点 9.05 离片段边缘 9 只有 0.05，比起点离 7（不在网格上）更近 → 终点对齐 9，起点落在 7。
        expect(resolveEditSnap(7.05, 2, points, 0.5).seconds).toBeCloseTo(7, 6);
    });

    it("吸附结果不会出现负数起点", () => {
        expect(resolveEditSnap(0.05, 2, [{ seconds: 0, kind: "clip-start" }], 0.5)).toEqual({ seconds: 0, snapped: true, point: { seconds: 0, kind: "clip-start" } });
        // 末尾对齐到 5s 的候选点、片段长 5s：起点会被算成 0，不能变成负数。
        expect(resolveEditSnap(0.2, 5, [{ seconds: 5, kind: "clip-end" }], 0.5)).toEqual({ seconds: 0, snapped: true, point: { seconds: 5, kind: "clip-end" } });
    });
});

describe("剪辑台吸附：快拖不吸附", () => {
    it("指针速度超过阈值就暂停吸附，慢拖时保留", () => {
        expect(isEditSnapSuppressed(300)).toBe(false);
        expect(isEditSnapSuppressed(EDIT_SNAP_VELOCITY_LIMIT)).toBe(false);
        expect(isEditSnapSuppressed(EDIT_SNAP_VELOCITY_LIMIT + 1)).toBe(true);
        expect(isEditSnapSuppressed(4000)).toBe(true);
        expect(isEditSnapSuppressed(Number.POSITIVE_INFINITY)).toBe(false);
    });

    it("阈值可覆盖，用于不同缩放的场景", () => {
        expect(isEditSnapSuppressed(500, 400)).toBe(true);
        expect(isEditSnapSuppressed(500, 800)).toBe(false);
    });
});

describe("剪辑台换序落点", () => {
    it("按吸附后的起点落到其余片段的第几个位置", () => {
        // 拖走 c1（4s）后其余是 c2(0–5)、c3(5–8)，中点在 2.5 与 6.5。
        expect(editReorderIndex(VIEWS, 0, 0)).toBe(0);
        expect(editReorderIndex(VIEWS, 0, 2.4)).toBe(0);
        expect(editReorderIndex(VIEWS, 0, 6.6)).toBe(2);
        expect(editReorderIndex(VIEWS, 0, 12)).toBe(2);
    });

    it("落在中点附近不来回震荡：中点两侧各取最近的位置", () => {
        // 拖走 c2（5s）后其余是 c1(0–4)、c3(4–7)，第一个中点在 2s。
        expect(editReorderIndex(VIEWS, 1, 1.9)).toBe(0);
        expect(editReorderIndex(VIEWS, 1, 2.1)).toBe(1);
    });
});

describe("剪辑台拆分：真实入出点切分", () => {
    it("按播放头把一段切成两段，出点 / 入点都取真实的素材秒数", () => {
        // c1 入点 1s、出点 5s、全局 0–4s；播放头在全局 2s → 段内 2s → 切点 3s。
        const next = splitEditClip(CLIPS, VIEWS, "c1", 2, "new");
        expect(next).not.toBeNull();
        expect(next!.map((item) => item.id)).toEqual(["c1", "new", "c2", "c3"]);
        expect(next![0]).toMatchObject({ id: "c1", mediaId: "a", start: 1, end: 3 });
        expect(next![1]).toMatchObject({ id: "new", mediaId: "a", start: 3, end: 5 });
        // 两段净时长之和等于原来的净时长，没有凭空造时长。
        expect(buildEditClips(MEDIA, next!).slice(0, 2).map((view) => view.length)).toEqual([2, 2]);
    });

    it("原来出点为 0（到素材末尾）时右半段继续保留 0，不会被写死成某个秒数", () => {
        // c2 全局 4–9s，素材全长 5s，播放头在全局 6.5s → 段内 2.5s。
        const next = splitEditClip(CLIPS, VIEWS, "c2", 6.5, "new");
        expect(next![1]).toMatchObject({ id: "c2", start: 0, end: 2.5 });
        expect(next![2]).toMatchObject({ id: "new", start: 2.5, end: 0 });
    });

    it("拆分保留音量、淡入淡出、转场与字幕", () => {
        const decorated = [clip("c1", "a", { start: 1, end: 5, volume: 0.6, fadeIn: 1, fadeOut: 2, transition: "fade", transitionDuration: 0.8, subtitle: "第一句" })];
        const next = splitEditClip(decorated, buildEditClips(MEDIA, decorated), "c1", 2, "new");
        expect(next![0]).toMatchObject({ volume: 0.6, fadeIn: 1, fadeOut: 2, transition: "fade", subtitle: "第一句" });
        expect(next![1]).toMatchObject({ volume: 0.6, start: 3, end: 5, transition: "fade", subtitle: "第一句" });
    });

    it("播放头太靠边或不在段内时拒绝拆分，不制造毛刺片段", () => {
        expect(splitEditClip(CLIPS, VIEWS, "c1", 0.02, "new")).toBeNull();
        expect(splitEditClip(CLIPS, VIEWS, "c1", 3.99, "new")).toBeNull();
        expect(splitEditClip(CLIPS, VIEWS, "c1", 5, "new")).toBeNull();
        expect(splitEditClip(CLIPS, VIEWS, "nope", 2, "new")).toBeNull();
    });

    it("素材没探测到时长（净时长为 0）的段不能拆", () => {
        const broken = [clip("c1", "gone")];
        expect(splitEditClip(broken, buildEditClips([], broken), "c1", 0.5, "new")).toBeNull();
    });

    it("播放头落在第几段：起点算在内、终点归下一段，空段永远不匹配", () => {
        expect(editClipIndexAt(VIEWS, 0)).toBe(0);
        expect(editClipIndexAt(VIEWS, 3.99)).toBe(0);
        expect(editClipIndexAt(VIEWS, 4)).toBe(1);
        expect(editClipIndexAt(VIEWS, 12)).toBe(-1);
        // 开头是「没探测到时长的空段」时，播放头在 0 秒要落到后面那段真正的片段上。
        const withEmpty = buildEditClips([media("a", undefined), media("b", 3)], [clip("c1", "a"), clip("c2", "b")]);
        expect(editClipIndexAt(withEmpty, 0)).toBe(1);
        expect(editSecondsInsideClip(withEmpty[0]!, 0)).toBe(false);
    });
});

describe("剪辑台删除与涟漪删除", () => {
    const chained = [clip("c1", "a", { start: 1, end: 5, transition: "fade", transitionDuration: 0.8 }), clip("c2", "b"), clip("c3", "c")];

    it("普通删除：后续片段前移（顺序模型里位置=前缀时长之和），接缝上的转场保留", () => {
        const next = deleteEditClip(chained, "c2", "cut");
        expect(next.map((item) => item.id)).toEqual(["c1", "c3"]);
        expect(next[0]!.transition).toBe("fade");
        expect(buildEditClips(MEDIA, next).map((view) => view.offset)).toEqual([0, 4]);
    });

    it("涟漪删除：把原本指向被删片段的转场一起清掉，新的接缝是干净的硬切", () => {
        const next = deleteEditClip(chained, "c2", "ripple");
        expect(next.map((item) => item.id)).toEqual(["c1", "c3"]);
        expect(next[0]!.transition).toBeUndefined();
        expect(next[0]!.transitionDuration).toBeUndefined();
        expect(buildEditClips(MEDIA, next).map((view) => view.offset)).toEqual([0, 4]);
    });

    it("删除首段时没有前一段可清理，两种模式结果一致", () => {
        expect(deleteEditClip(chained, "c1", "cut").map((item) => item.id)).toEqual(["c2", "c3"]);
        expect(deleteEditClip(chained, "c1", "ripple").map((item) => item.id)).toEqual(["c2", "c3"]);
    });

    it("删除不存在的片段时原样返回", () => {
        expect(deleteEditClip(chained, "nope", "ripple")).toBe(chained);
    });
});
