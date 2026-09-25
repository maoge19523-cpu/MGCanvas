/**
 * 时间轴几何：时间（秒）→ 位置（轨道宽度的百分比）/ 像素。
 *
 * 时间轴上的**所有**按时间定位的元素——标尺刻度、播放头、吸附导引线、音轨波形条、片段条——
 * 必须共用这一条换算。剪辑台原先的片段行用 flex + `gap-1` 分配宽度：4px 的间隙被从容器宽度里
 * 吃掉，每条片段的宽度变成「(容器宽 − (N−1)×间隙) × 本段秒数 / 总秒数」，
 * 第 k 段的左边缘因此比严格百分比多出 `k×间隙 − 该处前缀占比×(N−1)×间隙`，而标尺、播放头、
 * 波形走的是严格百分比——片段一多就逐渐错开，波形这把「音画对齐的尺子」随之失效。
 *
 * 现在的约定：位置与宽度**只**由这里的函数给出；片段之间的视觉缝只能画在片段内部
 * （边框 / 内层元素 / 内阴影），不允许再用 gap、margin 或 flex 分配去占轨道的像素。
 */

/** 时间（秒）→ 占整条轨道宽度的百分比。总时长无效或秒数非有限值时返回 0。 */
export function timeToPercent(seconds: number, totalSeconds: number): number {
    if (!(totalSeconds > 0) || !Number.isFinite(seconds)) return 0;
    return (seconds / totalSeconds) * 100;
}

/** 时间（秒）→ 像素：与 timeToPercent 同一条换算，供只有像素概念的地方使用（例如波形柱换算）。 */
export function timeToPx(seconds: number, totalSeconds: number, trackWidthPx: number): number {
    if (!(trackWidthPx > 0)) return 0;
    return (timeToPercent(seconds, totalSeconds) * trackWidthPx) / 100;
}

/** 轨道上一个按时间定位的元素的占位：left / width 都是整条轨道宽度的百分比。 */
export type TimelinePlacement = { left: number; width: number };

/**
 * 片段条占位：按列表顺序累加时长得到每段的起点，两条边都直接用 timeToPercent 换算，
 * 于是第 k 段的右边缘严格等于「前 k 段时长之和」的位置——误差不随片段数累积。
 * 宽度取「两条边的差」而不是「本段时长单独换算」，保证右边缘与边的换算永远一致。
 */
export function timelinePlacements(lengths: readonly number[], totalSeconds: number): TimelinePlacement[] {
    let offset = 0;
    return lengths.map((length) => {
        const safe = Number.isFinite(length) && length > 0 ? length : 0;
        const left = timeToPercent(offset, totalSeconds);
        offset += safe;
        return { left, width: timeToPercent(offset, totalSeconds) - left };
    });
}
