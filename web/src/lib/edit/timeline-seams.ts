import { timelinePlacements } from "@/lib/timeline-scale";

/**
 * 接缝：**相邻两段**的交界。`EditClip.transition` 的语义是「本段 → 下一段」，
 * 所以第 index 条接缝（clips[index] 与 clips[index + 1] 之间）的转场挂在**左段**身上——
 * 一条接缝一个标记，不需要新的数据模型。
 *
 * 接缝的位置与片段条**同源**：百分比直接取左段的右边缘（placements[index].left + width），
 * 不自己写第二套换算，于是「接缝标记」与「两条片段的分界线」在任何浮点情况下都是同一个数。
 * 时长按 placements 内部的累加方式累加，接缝秒数也因此与片段起点严格一致。
 *
 * 边界：片段少于 2 段时没有任何接缝（1 段不渲染接缝标记），首段之前、末段之后都不是接缝。
 */

export type EditSeamInput = {
    id: string;
    length: number;
    transition?: string;
    transitionDuration?: number;
    locked?: boolean;
};

export type EditSeam = {
    /** 接缝序号：第 index 条接缝在 clips[index] 与 clips[index + 1] 之间。 */
    index: number;
    leftClipId: string;
    rightClipId: string;
    /** 接缝所在秒数 = 前 index + 1 段时长之和。 */
    seconds: number;
    /** 接缝在轨道上的百分比位置，与左段的右边缘严格同值。 */
    percent: number;
    transition?: string;
    transitionDuration: number;
    locked: boolean;
};

export function editTimelineSeams(clips: readonly EditSeamInput[], totalSeconds: number): EditSeam[] {
    if (clips.length < 2) return [];
    const placements = timelinePlacements(clips.map((clip) => clip.length), totalSeconds);
    let seconds = 0;
    return clips.slice(0, -1).map((clip, index) => {
        // 与 timelinePlacements 完全相同的清洗与累加，接缝秒数因此就是左段的右边缘时刻。
        seconds += Number.isFinite(clip.length) && clip.length > 0 ? clip.length : 0;
        const placement = placements[index]!;
        return {
            index,
            leftClipId: clip.id,
            rightClipId: clips[index + 1]!.id,
            seconds,
            percent: placement.left + placement.width,
            transition: clip.transition,
            transitionDuration: clip.transitionDuration ?? 0.5,
            locked: clip.locked === true,
        };
    });
}
