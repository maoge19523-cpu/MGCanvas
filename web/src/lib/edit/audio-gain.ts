import { timeToPercent } from "@/lib/timeline-scale";
import type { EditAudioTrack } from "@/types/edit";

/**
 * 时间线上一条音轨的**音量基准线**与**淡入 / 淡出坡度**的纯计算部分。
 * 全部不碰 DOM，便于单测；真正的绘制在 pages/editor/components/edit-audio-track.tsx 里。
 *
 * 横轴与波形条**同源**：这里的每个时间点最后都由 lib/timeline-scale 的 timeToPercent 换成百分比
 * （见 editGainPointsText），所以音量线与同一行的波形条、标尺刻度、播放头用的是同一把尺子。
 * 这里绝不自己写第二套「秒数 ÷ 音轨时长」的百分比。
 *
 * 纵轴是**分贝**映射而不是线性映射：线性映射下 100%（原始音量）只要 1/4 行高，
 * 而 0.5× 与 2× 这两件听感上完全对称的事会画成一高一低（0.125 与 0.5），用户没法照着线判断自己调了多少。
 * 现在 -36 dB ~ +12 dB 均分 48 段、每 1 dB 占 1/48 高度，0 dB（原始音量）正好落在 75% 高度：
 * 上下各拖同样多的像素，听感上的变化也一样大，与 DAW 的推子刻度是同一个直觉。
 *
 * 导出侧的真实参数（web/src-tauri/src/ffmpeg_compose.rs 的 track_chain）：
 * `volume` 夹进 [0,4] → `afade=t=in:st=0:d=fadeIn`（本地 0 秒 = 成片里的起点）→
 * `afade=t=out:st=(span − fadeOut):d=fadeOut`，其中 span 是起点之后剩下的时长、`fadeIn`/`fadeOut`
 * 分别夹进 [0,5] / [0,10]。这里的夹取范围与它们逐字一致，画出来的坡度就是导出真正会做的那一段。
 */

/** 音量取值域与步长：与属性区那条 InputNumber（min 0 / max 400 / step 5）逐字一致。 */
export const EDIT_VOLUME_MIN = 0;
export const EDIT_VOLUME_MAX = 4;
export const EDIT_VOLUME_STEP = 0.05;

/** 淡入 / 淡出的上限：属性区（max 5 / max 10）与 ffmpeg_compose.rs 的 clamp 三处同一口径。 */
export const EDIT_FADE_IN_MAX = 5;
export const EDIT_FADE_OUT_MAX = 10;

/**
 * 高度映射的两端：−36 dB 画在最低、+12 dB 画在最高。
 * −36 dB 以下（≈ 1.6% 音量）在 36px 行高里已经和静音看不出差别，再往下拉开只是浪费高度；
 * +12 dB 是听感上「很响」的一档，而取值域的 400% 是 +12.04 dB，正好落在顶端。
 */
export const EDIT_VOLUME_FLOOR_DB = -36;
export const EDIT_VOLUME_CEIL_DB = 12;
export const EDIT_VOLUME_DB_SPAN = EDIT_VOLUME_CEIL_DB - EDIT_VOLUME_FLOOR_DB;

/** 0 dB（原始音量 = 100%）在高度上的位置：0.75，也就是「基准线」默认高度。 */
export const EDIT_VOLUME_UNITY_RATIO = (0 - EDIT_VOLUME_FLOOR_DB) / EDIT_VOLUME_DB_SPAN;

/**
 * 拖动时吸附到 100%（0 dB）的半径（像素）。
 *
 * 取 2px：这条线本身就 2px 粗，指针落在线上时正好吸住。行高只有 36px 而刻度跨 48 dB，
 * 所以 2px 换算过去是 ±2.7 dB（约 0.73× ~ 1.36×）——再放大吸附半径就会把「想调 90% / 110%」的人拽走。
 */
export const EDIT_VOLUME_SNAP_PX = 2;

/** 折线在行高上的上下留白（百分比）：0 增益与满音量贴边时，2px 的线也不会被裁掉一半。 */
export const EDIT_GAIN_Y_INSET = 3;

/**
 * 折线下方那块面积填充的不透明度。**这一行上波形是主信息，音量与淡入淡出是叠加信息，叠加的那块必须让路。**
 *
 * 这块填充原来直接用了 antd 的 `colorPrimaryBg`，而这个应用把 `colorPrimary` 设成了中性色
 * （实测浅色 #171717 / 深色 #d8d8d8），由它派生出来的 `colorPrimaryBg` 是 **#575757 / #595959 这种中灰，
 * 而且不带任何透明度**：整行顿时变成一块占 70.5% 行高的实心灰板（行 860×36 时是 860×25.4px），
 * 而波形条是 1px 一列铺满整段的实心色块——被压在这块灰板下面，用户看到的就只剩「一整块不通透的灰色矩形」。
 *
 * 现在填充改用**与波形条同一个 token（colorPrimary）**，再加这层透明度：
 * 叠在波形条上时合成色 = 0.92 × 波形色 + 0.08 × 同一个波形色 = 波形色本身，逐像素等于没变，
 * 所以这层填充**在算术上不可能削弱波形的对比度**（它只在波形条之间的行底色上留一层很淡的同色底纹，
 * 继续把「折线以下被削掉多少」画出来）。0.08 是权衡值：低于 0.1 这条安全线，又高于看不见的程度。
 */
export const EDIT_GAIN_AREA_FILL_OPACITY = 0.08;

/** 淡入淡出重叠区里相乘曲线的采样段数（两条直线相乘是一段抛物线，取几个点就画得出形状）。 */
const EDIT_GAIN_OVERLAP_SAMPLES = 5;

/** 非有限值与越界值一律夹进区间：畸形数据不能把百分比算成 NaN，也不能画出界。 */
function clamp(value: number, minimum: number, maximum: number) {
    if (!Number.isFinite(value)) return minimum;
    return Math.min(maximum, Math.max(minimum, value));
}

/**
 * 对齐到取值域的步长（5%）：属性区输入框的 step 就是它。
 * **只用于交互**（拖动落点、键盘每次一步），高度换算绝不走它——
 * 折线上的增益是连续量（两条淡变相乘出来的），按设置步长取整会把曲线的形状抹平。
 */
export function editVolumeSnap(volume: number): number {
    const clamped = clamp(volume, EDIT_VOLUME_MIN, EDIT_VOLUME_MAX);
    return Number((Math.round(clamped / EDIT_VOLUME_STEP) * EDIT_VOLUME_STEP).toFixed(2));
}

/** 音量 → 分贝：0（以及非有限值）= 不出声，没有分贝可言，返回 null。越界数据按取值域的端点处理。 */
export function editVolumeDb(volume: number): number | null {
    const safe = clamp(volume, EDIT_VOLUME_MIN, EDIT_VOLUME_MAX);
    if (safe <= 0) return null;
    return 20 * Math.log10(safe);
}

/**
 * 音量 → 音量基准线的高度比例（0..1，0 = 行底、1 = 行顶）。
 * 0 与越界值分别落在 0 与 1（与导出的 clamp(0,4) 同口径）。
 */
export function editVolumeRatio(volume: number): number {
    const db = editVolumeDb(volume);
    if (db === null) return 0;
    return clamp((db - EDIT_VOLUME_FLOOR_DB) / EDIT_VOLUME_DB_SPAN, 0, 1);
}

/**
 * 高度比例 → 音量（editVolumeRatio 的逆映射）。
 * 两端直接给取值域的端点，所以「拖到顶 = 400%」「拖到底 = 0%」严格成立、往返换算也不丢值。
 */
export function editVolumeFromRatio(ratio: number): number {
    if (!Number.isFinite(ratio) || ratio <= 0) return EDIT_VOLUME_MIN;
    if (ratio >= 1) return EDIT_VOLUME_MAX;
    return editVolumeSnap(10 ** ((EDIT_VOLUME_FLOOR_DB + ratio * EDIT_VOLUME_DB_SPAN) / 20));
}

/**
 * 拖动音量线：**向上拖为正**的像素位移 → 新音量。
 *
 * 1 像素就是 1/行高 的高度比例，与画出来的高度是同一把尺子（线跟着指针走，不多不少）。
 * 唯一一处吸附：进入 100%（0 dB）±2px 就落到 100%——它是「原始音量」这个唯一有量纲意义的基准，
 * 也是用户最常回到的值；其余位置不吸附，免得想调 90% / 110% 的人被磁力拽走。
 * 越界由 clamp 兜住：拖出顶端 = 400%，拖到底端 = 静音（0%），与属性区输入框的上下限一致。
 */
export function editVolumeFromDrag(startVolume: number, liftPx: number, rowHeightPx: number, snapPx = EDIT_VOLUME_SNAP_PX): number {
    const start = editVolumeSnap(startVolume);
    if (!(rowHeightPx > 0)) return start;
    const lift = Number.isFinite(liftPx) ? liftPx : 0;
    // 一步都没动就保持原值：起点本来就在吸附半径里时，不能因为「按了一下」就跳到 100%。
    if (lift === 0) return start;
    const ratio = clamp(editVolumeRatio(start) + lift / rowHeightPx, 0, 1);
    if (Math.abs(ratio - EDIT_VOLUME_UNITY_RATIO) * rowHeightPx <= snapPx) return editVolumeSnap(1);
    return editVolumeFromRatio(ratio);
}

/** 键盘调整：每次一步（5%，与属性区 step 一致），direction 取 +1 / −1。 */
export function editVolumeStep(volume: number, direction: number): number {
    const step = direction >= 0 ? EDIT_VOLUME_STEP : -EDIT_VOLUME_STEP;
    return editVolumeSnap(editVolumeSnap(volume) + step);
}

/** 音量读数：「100%」——与属性区输入框显示的是同一个数（四舍五入到整百分比），不按步长取整。 */
export function editVolumeLabel(volume: number): string {
    return `${Math.round(clamp(volume, EDIT_VOLUME_MIN, EDIT_VOLUME_MAX) * 100)}%`;
}

/** 拖动 / 悬停时的完整读数：「100% · 0.0 dB」；0% 没有分贝，写成 −∞ dB。 */
export function editVolumeReadout(volume: number): string {
    const db = editVolumeDb(volume);
    return `${editVolumeLabel(volume)} · ${db === null ? "-∞" : db.toFixed(1)} dB`;
}

/** 折线上的一个采样点：秒数（成片时间轴）+ 线性增益（0..4）。 */
export type EditAudioGainPoint = { seconds: number; gain: number };

/** 音轨在时间线上的几何：起点、能占的秒数（见 waveformStripSeconds）、成片总秒数。 */
export type EditAudioGainGeometry = { start: number; seconds: number; total: number };

/**
 * 画出的淡出坡度与导出锚点的关系：
 * - `none`：一致（音轨在成片里铺满起点之后剩下的时长，或音频刚好接在成片末尾结束）；
 * - `shifted`：导出按「成片末尾 − fadeOut」起淡出，与这里画出的起点不同（导出更早 / 更缓）；
 * - `unheard`：导出锚点落在音频内容结束之后，这段淡出在成片里根本不会发生。
 */
export type EditAudioGainAnchor = "none" | "shifted" | "unheard";

export type EditAudioGainShape = {
    /** 音轨起点 / 终点（成片时间轴，秒）。 */
    start: number;
    end: number;
    seconds: number;
    /** 画出的音量（夹进取值域，不按步长取整：画出来的必须与数据一致）。 */
    volume: number;
    /** 音量基准线的高度比例（0..1）。 */
    ratio: number;
    /** 实际画出的淡入 / 淡出秒数：先按导出的范围夹取，再夹进这条轨能占的秒数。 */
    fadeIn: number;
    fadeOut: number;
    /** 淡入 + 淡出 超过音轨时长：两条坡度重叠，导出里相乘，这条轨到不了满音量。 */
    overlap: boolean;
    /** 单独的淡入 / 淡出比音轨本身还长：坡度画到音轨边界为止。 */
    fadeInClamped: boolean;
    fadeOutClamped: boolean;
    /** 导出侧淡出的锚点（绝对秒 = 成片末尾 − fadeOut）。 */
    exportFadeOutStart: number;
    fadeOutAnchor: EditAudioGainAnchor;
    /** 增益折线：每个点是（秒，线性增益）= volume × 淡入系数 × 淡出系数。 */
    points: EditAudioGainPoint[];
};

/**
 * 一条音轨的音量线高度 + 淡入淡出坡度。
 *
 * 几处边界都是明确取舍，不静默画错：
 * - `fadeIn + fadeOut > 音轨时长`：两条坡度按**真实长度**画出来、允许交叉，折线取两者的**乘积**
 *   （导出就是两条 afade 串在同一条链上，逐点相乘），并给出 overlap 标记：
 *   这条轨在重叠区永远到不了满音量。不把某一条悄悄截短——那会画出一个导出里并不存在的形状。
 * - `fadeIn`（或 fadeOut）比音轨还长：画到音轨边界为止（clamped），因为再往后的时间上根本没有音频，
 *   导出那边超出的部分同样不会发生。注意值本身仍保持用户填的数，这里只决定画多长。
 * - 起点偏移（`start`）：整条坡度的秒数都是**成片时间轴上的绝对秒数**，淡入从起点起算、
 *   淡出到「起点 + 能占的秒数」为止，与同一行波形条的左右边缘严格重合。
 * - 音轨被偏移到成片之外（能占 0 秒）：不画任何坡度（没有能进成片的音频），由调用方跳过整块可视化。
 * - `volume = 0`：折线是一条贴在底部的平线（导出里 volume=0 就是整条静音），但基准线仍画在底部，
 *   用户能看出「这里被拉到 0 了」而不是「这个功能没画出来」。
 */
export function editAudioGainShape(track: Pick<EditAudioTrack, "volume" | "fadeIn" | "fadeOut">, geometry: EditAudioGainGeometry): EditAudioGainShape {
    const total = Number.isFinite(geometry.total) && geometry.total > 0 ? geometry.total : 0;
    const start = clamp(geometry.start, 0, total);
    const seconds = clamp(geometry.seconds, 0, total - start);
    const end = start + seconds;
    const volume = clamp(track.volume, EDIT_VOLUME_MIN, EDIT_VOLUME_MAX);
    const rawIn = clamp(track.fadeIn, 0, EDIT_FADE_IN_MAX);
    const rawOut = clamp(track.fadeOut, 0, EDIT_FADE_OUT_MAX);
    const fadeIn = Math.min(rawIn, seconds);
    const fadeOut = Math.min(rawOut, seconds);
    // 导出锚点：span − fade_out 再延迟 delay，绝对位置就是「成片末尾 − fadeOut」。
    const exportFadeOutStart = Math.max(0, total - rawOut);

    const rampIn = (at: number) => (fadeIn > 0 ? clamp((at - start) / fadeIn, 0, 1) : 1);
    const rampOut = (at: number) => (fadeOut > 0 ? clamp(1 - (at - (end - fadeOut)) / fadeOut, 0, 1) : 1);
    const gainAt = (at: number) => volume * rampIn(at) * rampOut(at);

    // 折点：起点、淡入结束、淡出开始、终点（四条边都在 [start, end] 内），重叠时再补几个相乘曲线的采样点。
    const marks = [start, start + fadeIn, end - fadeOut, end];
    if (fadeIn > 0 && fadeOut > 0 && fadeIn + fadeOut > seconds) {
        const from = end - fadeOut;
        const span = start + fadeIn - from;
        for (let index = 1; index <= EDIT_GAIN_OVERLAP_SAMPLES; index += 1) marks.push(from + (span * index) / (EDIT_GAIN_OVERLAP_SAMPLES + 1));
    }
    const unique = [...new Set(marks.map((at) => Number(at.toFixed(6))))].sort((left, right) => left - right);
    // 这条轨在成片里一秒都占不到（起点落在成片末尾之后 / 成片是空的）：没有任何可画的区间。
    const points = seconds > 0 ? unique.map((at) => ({ seconds: at, gain: gainAt(at) })) : [];

    const fadeOutAnchor: EditAudioGainAnchor = rawOut <= 0 || seconds <= 0 ? "none" : exportFadeOutStart >= end - 1e-6 ? "unheard" : Math.abs(exportFadeOutStart - (end - fadeOut)) > 1e-6 ? "shifted" : "none";

    return {
        start,
        end,
        seconds,
        volume,
        ratio: editVolumeRatio(volume),
        fadeIn,
        fadeOut,
        overlap: fadeIn + fadeOut > seconds + 1e-9,
        fadeInClamped: rawIn > seconds,
        fadeOutClamped: rawOut > seconds,
        exportFadeOutStart,
        fadeOutAnchor,
        points,
    };
}

/**
 * 高度比例 → 折线纵坐标（行高的百分比，0 = 行顶）。
 * 上下各留 EDIT_GAIN_Y_INSET：折线与基准线都比边缘内缩一点，贴边时不会被 overflow-hidden 裁掉一半。
 */
export function editGainHeightPercent(ratio: number): number {
    return EDIT_GAIN_Y_INSET + (1 - clamp(ratio, 0, 1)) * (100 - EDIT_GAIN_Y_INSET * 2);
}

/**
 * 折线 → SVG 的 points 字符串：x 用 timeline-scale 的 timeToPercent（与标尺 / 波形条同一套换算），
 * y 用 heightPercent（与音量基准线的 top 同一套）。不取整、不做第二次换算，误差为零。
 */
export function editGainPointsText(shape: EditAudioGainShape, totalSeconds: number): string {
    return shape.points.map((point) => `${timeToPercent(point.seconds, totalSeconds)},${editGainHeightPercent(editVolumeRatio(point.gain))}`).join(" ");
}

/** 折线下方那块面积的顶点串：折线 + 回到基线的右下角 / 左下角（描边仍然只用折线那一条）。 */
export function editGainAreaText(shape: EditAudioGainShape, totalSeconds: number): string {
    const line = editGainPointsText(shape, totalSeconds);
    if (!line) return "";
    return `${line} ${timeToPercent(shape.end, totalSeconds)},${editGainHeightPercent(0)} ${timeToPercent(shape.start, totalSeconds)},${editGainHeightPercent(0)}`;
}
