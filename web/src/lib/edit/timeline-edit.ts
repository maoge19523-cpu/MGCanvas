import type { EditClip } from "@/types/edit";
import { editPlaybackSeconds, editTickStep, type EditClipView } from "./timeline";

/** 吸附候选点的种类。优先级顺序沿用 OpenReel：相邻片段边缘 > 播放头 > 时间网格。 */
export type EditSnapKind = "clip-start" | "clip-end" | "playhead" | "grid";

export type EditSnapPoint = { seconds: number; kind: EditSnapKind };

export type EditSnapResult = { seconds: number; snapped: boolean; point?: EditSnapPoint };

/** 吸附阈值按像素给，换算成秒时跟随当前缩放。 */
export const EDIT_SNAP_THRESHOLD_PX = 40;

/** 拖动速度超过这个像素/秒阈值就暂停吸附，让用户能快速微调（参考上游的「快拖不吸附」）。 */
export const EDIT_SNAP_VELOCITY_LIMIT = 900;

/** 片段最短时长：小于它就不值得拆，也不允许裁到 0。 */
export const EDIT_MIN_CLIP_SECONDS = 0.05;

const SNAP_PRIORITY: Record<EditSnapKind, number> = { "clip-start": 0, "clip-end": 0, playhead: 1, grid: 2 };

/** 像素阈值 → 秒。时间线把总时长铺满整个宽度，所以每秒像素数 = 宽度 / 总时长。 */
export function editSnapThresholdSeconds(timelineWidth: number, totalSeconds: number, pixels = EDIT_SNAP_THRESHOLD_PX) {
    if (!(timelineWidth > 0) || !(totalSeconds > 0) || !(pixels > 0)) return 0;
    return (pixels * totalSeconds) / timelineWidth;
}

/** 快拖不吸附：指针速度超过阈值（或按住 Alt 临时关闭）时跳过吸附。 */
export function isEditSnapSuppressed(velocityPxPerSecond: number, limit = EDIT_SNAP_VELOCITY_LIMIT) {
    return Number.isFinite(velocityPxPerSecond) && velocityPxPerSecond > limit;
}

/** 网格取标尺当前那一档刻度：屏幕上看得见的网格才值得吸附。 */
export function editGridStep(totalSeconds: number) {
    return editTickStep(totalSeconds);
}

/**
 * 收集吸附候选点。换序拖动时被拖的那一段不参与（它是被移动的对象）；
 * 裁剪时被拖的那条边也不参与，但同一段的另一条边仍然有效。
 */
export function collectEditSnapPoints(views: EditClipView[], options: { playhead?: number; grid?: number; excludeClipIds?: string[] } = {}): EditSnapPoint[] {
    const excluded = new Set(options.excludeClipIds ?? []);
    const points: EditSnapPoint[] = [];
    for (const view of views) {
        if (excluded.has(view.id) || !view.hasDuration) continue;
        points.push({ seconds: view.offset, kind: "clip-start" });
        points.push({ seconds: view.offset + view.length, kind: "clip-end" });
    }
    if (options.playhead !== undefined && options.playhead >= 0) points.push({ seconds: options.playhead, kind: "playhead" });
    if (options.grid && options.grid > 0) {
        const total = editPlaybackSeconds(views);
        for (let seconds = 0; seconds <= total + options.grid / 2; seconds += options.grid) points.push({ seconds: Number(seconds.toFixed(3)), kind: "grid" });
    }
    return points;
}

/**
 * 把「从 rawSeconds 开始、长 durationSeconds 的一段」吸附到候选点：
 * 同时比较该段首尾与候选点的距离，先比优先级、同优先级再比距离。
 * 裁剪单条边时 durationSeconds 传 0，就退化成只吸附这一条边。
 */
export function resolveEditSnap(rawSeconds: number, durationSeconds: number, points: EditSnapPoint[], thresholdSeconds: number): EditSnapResult {
    const raw = Number.isFinite(rawSeconds) ? rawSeconds : 0;
    if (!(thresholdSeconds > 0) || !points.length) return { seconds: raw, snapped: false };

    let best: EditSnapPoint | undefined;
    let bestDistance = Infinity;
    let bestPriority = Infinity;
    let snapFromEnd = false;

    for (const point of points) {
        const priority = SNAP_PRIORITY[point.kind] ?? 2;
        const startDistance = Math.abs(point.seconds - raw);
        const endDistance = durationSeconds > 0 ? Math.abs(point.seconds - (raw + durationSeconds)) : Infinity;
        const fromEnd = endDistance < startDistance;
        const distance = fromEnd ? endDistance : startDistance;
        if (!(distance < thresholdSeconds)) continue;
        if (priority < bestPriority || (priority === bestPriority && distance < bestDistance)) {
            best = point;
            bestDistance = distance;
            bestPriority = priority;
            snapFromEnd = fromEnd;
        }
    }

    if (!best) return { seconds: raw, snapped: false };
    const seconds = snapFromEnd ? best.seconds - durationSeconds : best.seconds;
    return { seconds: Math.max(0, Number(seconds.toFixed(3))), snapped: true, point: best };
}

/** 播放头是否落在这一段内部：起点算在内、终点不算（段边界归后一段），空段永远不匹配。 */
export function editSecondsInsideClip(view: EditClipView, seconds: number) {
    return view.length > 0 && seconds >= view.offset && seconds < view.offset + view.length;
}

/** 播放头落在第几段。 */
export function editClipIndexAt(views: EditClipView[], seconds: number) {
    return views.findIndex((view) => editSecondsInsideClip(view, seconds));
}

/**
 * 换序落点：把被拖段按吸附后的起点放回「其余片段」的时间线里，落在第几个位置。
 * 判据是各段中点，保证落点稳定、不来回震荡。
 */
export function editReorderIndex(views: EditClipView[], from: number, startSeconds: number) {
    const others = views.filter((_, index) => index !== from);
    let cursor = 0;
    let target = 0;
    for (const view of others) {
        if (startSeconds >= cursor + view.length / 2) target += 1;
        cursor += view.length;
    }
    return Math.min(target, others.length);
}

/**
 * 在播放头处拆分片段：两段共用同一素材，**用真实的入点 / 出点切分**——
 * 左段出点 = 入点 + 段内偏移，右段入点取同一个值并保留原来的出点（0 表示到素材末尾）。
 * 播放头太靠近两端（少于 EDIT_MIN_CLIP_SECONDS）时返回 null，不制造毛刺片段。
 */
export function splitEditClip(clips: EditClip[], views: EditClipView[], clipId: string, seconds: number, newId: string): EditClip[] | null {
    const index = clips.findIndex((clip) => clip.id === clipId);
    const view = views.find((item) => item.id === clipId);
    const source = clips[index];
    if (index < 0 || !view || !source || !view.hasDuration) return null;

    const local = seconds - view.offset;
    if (!(local > EDIT_MIN_CLIP_SECONDS) || !(view.length - local > EDIT_MIN_CLIP_SECONDS)) return null;

    // view.end 是「入点 + 净时长」，已经按素材全长截断过，就是这段真实的出点。
    const cut = Number((view.start + local).toFixed(3));
    if (!(cut > view.start) || !(cut < view.end)) return null;

    const left: EditClip = { ...source, end: cut };
    const right: EditClip = { ...source, id: newId, start: cut };
    return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)];
}

/**
 * 删除一段。时间线是顺序模型（片段位置 = 前缀时长之和，模型里没有空隙字段），
 * 所以两种删除都会让后面的片段前移；差别落在接缝与播放头：
 * - cut：保留相邻片段上的转场设置，新的接缝沿用原来的转场。
 * - ripple：把原本指向被删片段的转场一起清掉，新的接缝是干净的硬切，不留残余。
 */
export function deleteEditClip(clips: EditClip[], clipId: string, mode: "cut" | "ripple"): EditClip[] {
    const index = clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) return clips;
    const next = clips.filter((clip) => clip.id !== clipId);
    const previous = index > 0 ? next[index - 1] : undefined;
    if (mode === "ripple" && previous?.transition) {
        next[index - 1] = { ...previous, transition: undefined, transitionDuration: undefined };
    }
    return next;
}
