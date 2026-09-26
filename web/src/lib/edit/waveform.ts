/**
 * 时间线波形的纯计算部分：采样档位、像素列 → 采样点映射、幅度 → canvas 坐标、降级判断。
 * 全部不碰 DOM，便于单测；真正的绘制在 pages/editor/components/edit-audio-track.tsx 里。
 */

/** 峰值采样档位：宽度向上取到最近的档位，缩放时只有跨档才需要重新算峰值。 */
export const WAVEFORM_BUCKETS = [256, 512, 1024, 2048, 4096] as const;

/**
 * 波形在素材内**取用哪一段**（裁剪后的那一段）。
 * 缺省 = 整条素材（`start` 0、`length` = 素材时长），也就是改动前的口径：
 * 两个函数都把它当成可选参数，省略时逐字沿用旧行为，所以没有裁剪的音轨一个像素都不会变。
 */
export type EditWaveformWindow = { start: number; length: number };

/** 时间线可用宽度（设备像素）→ 峰值采样点数档位。 */
export function editWaveformBuckets(deviceWidth: number): number {
    if (!Number.isFinite(deviceWidth) || deviceWidth <= 0) return WAVEFORM_BUCKETS[0];
    return WAVEFORM_BUCKETS.find((bucket) => bucket >= deviceWidth) ?? WAVEFORM_BUCKETS[WAVEFORM_BUCKETS.length - 1];
}

/**
 * 波形条在时间线上能占多长：从 `startSeconds`（这条轨的起点）起算，loop 的音轨铺满**剩余**的全片
 * （FFmpeg 侧是 -stream_loop -1 / aloop），其余按自身时长且不超过剩余全片。
 * 起点之后剩下的才是它真正能落进成片的部分——amix 是 duration=first（以视频为准），
 * 所以「音频比视频长」时条宽只到成片末尾为止，不会画出一条根本没进成片的尾巴。
 * `startSeconds` 缺省 0 = 改动前的口径（整条从 0 秒铺开）。
 *
 * `audioSeconds` 传的是**裁剪后**的取用长度（见 lib/edit/audio-trim 的 editAudioTrimWindow.seconds）：
 * 裁掉两头之后，这条轨在成片里能占多长本来就该按留下的那一段算，而不是整条素材。
 * 循环的轨仍然铺满剩余全片（循环体是裁剪后的那一段，循环次数由成片尽头决定）。
 */
export function waveformStripSeconds(audioSeconds: number, totalSeconds: number, loop: boolean, startSeconds = 0): number {
    if (!(totalSeconds > 0) || !(audioSeconds > 0)) return 0;
    const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
    const remaining = Math.max(0, totalSeconds - start);
    return loop ? remaining : Math.min(audioSeconds, remaining);
}

/** 时间线秒数 → 峰值下标；loop 的音轨按**取用区间**回卷到开头。没有可用数据时返回 -1。 */
export function waveformPointAt(seconds: number, audioSeconds: number, loop: boolean, points: number, window?: EditWaveformWindow): number {
    if (points <= 0 || !(audioSeconds > 0)) return -1;
    const start = window && Number.isFinite(window.start) && window.start > 0 ? window.start : 0;
    const length = window && Number.isFinite(window.length) && window.length > 0 ? window.length : audioSeconds;
    // loop 的循环体是**裁剪后的那一段**（导出侧 aloop 循环的也是它），不是整条素材：
    // 按整条素材回卷会把用户裁掉的那一段又画（也放）回来。
    const wrapped = loop ? ((seconds % length) + length) % length : seconds;
    const index = Math.floor(((start + wrapped) / audioSeconds) * points);
    return Math.min(points - 1, Math.max(0, index));
}

export type WaveformColumn = { peak: number; trough: number };

/**
 * 峰值包络 → canvas 每一列的极值（一列取该列时间范围内所有采样点的最大 / 最小值，缩放不丢尖峰）。
 * `stripSeconds` 是这条波形条覆盖的时间长度，`audioSeconds` 是音频自身时长（loop 时用它回卷）。
 * `window` 是裁剪后在素材内取用的那一段（缺省 = 整条素材）。
 * 包络为空（还没算出来 / 素材没有音频流）时返回等长的全 0 列，调用方据此只画一条中位线，界面不会坏。
 */
export function waveformColumns(peaks: Float32Array, troughs: Float32Array, columns: number, stripSeconds: number, audioSeconds: number, loop: boolean, window?: EditWaveformWindow): WaveformColumn[] {
    const result: WaveformColumn[] = [];
    if (columns <= 0) return result;
    const points = Math.min(peaks.length, troughs.length);
    const usable = points > 0 && stripSeconds > 0 && audioSeconds > 0;
    for (let column = 0; column < columns; column += 1) {
        if (!usable) {
            result.push({ peak: 0, trough: 0 });
            continue;
        }
        const from = waveformPointAt((column / columns) * stripSeconds, audioSeconds, loop, points, window);
        let to = waveformPointAt(((column + 1) / columns) * stripSeconds, audioSeconds, loop, points, window) + 1;
        // loop 的接缝列会回卷到开头：这时只取循环末尾这一段，
        // 绝不能把「循环头 + 循环尾」的极值糊到同一列上（那会在接缝处冒出一条假的满幅尖峰）。
        if (to <= from) to = points;
        let peak = peaks[from];
        let trough = troughs[from];
        for (let point = from + 1; point < to && point < points; point += 1) {
            peak = Math.max(peak, peaks[point]);
            trough = Math.min(trough, troughs[point]);
        }
        result.push({ peak, trough });
    }
    return result;
}

/** 幅度（-1..1）→ canvas 纵坐标：0 落在中位线，满幅值上下各留 1px 不贴边。 */
export function waveformY(value: number, height: number): number {
    const half = height / 2;
    const amplitude = Math.max(0, half - 1);
    const clamped = Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
    return half - clamped * amplitude;
}

/** 包络里有没有真实信号：全 0（纯静音或没算出来）时只画中位线，不假装有波形。 */
export function waveformHasSignal(peaks: Float32Array, troughs: Float32Array, threshold = 1e-4): boolean {
    return peaks.some((value) => Math.abs(value) > threshold) || troughs.some((value) => Math.abs(value) > threshold);
}
