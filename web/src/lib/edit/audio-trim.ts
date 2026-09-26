import type { EditAudioTrack } from "@/types/edit";
import { EDIT_MIN_TRIM_SECONDS, resolveEditSnap, type EditSnapPoint, type EditSnapResult } from "./timeline-edit";

/**
 * 时间线上一条音轨的**裁剪区间**（在素材内取哪一段）的纯计算部分：区间换算、拖两端的夹取、吸附落点。
 * 全部不碰 DOM，便于单测；真正的拖动与绘制在 pages/editor/components/edit-audio-track.tsx 里。
 *
 * 语义与**视频片段拖两端裁剪**完全一致（同一套最小长度、同一套吸附候选点，见 lib/edit/timeline-edit）：
 * - 拖**左端** = 改素材内的**入点**：音轨开头被砍掉，`start`（它在成片里的起点）**不动**，整条轨变短；
 * - 拖**右端** = 改素材内的**出点**：音轨结尾被砍掉，左端（`start`）不动；
 * - 两条边之间至少留 EDIT_MIN_TRIM_SECONDS，出点不越过素材全长（与视频片段的两端裁剪同值）。
 *
 * 为什么裁左端不改 `start`：`start` 是这条轨在**成片时间轴**上的起点，入点是它在**素材内部**的起点，
 * 两者是两把尺子。视频片段拖左端时，片段自己在成片里的位置由前序片段时长决定、同样不动，只是变短——
 * 音轨的 `start` 扮演的正是那个「已经在成片里定好的位置」，所以裁掉开头后它仍从同一时刻混入，
 * 只是内容改从素材的更后面开始，整条轨的右端因此提前结束（导出侧 atrim + adelay 的组合就是这个结果）。
 *
 * 缺省（两个字段都是 undefined）= 整条素材，与改动前**逐字一致**：`trimmed` 为 false 时
 * 导出请求里不出现任何新键（见 lib/edit/timeline 的 buildComposeTracks），
 * 波形 / 音量线 / 淡入淡出折线也照旧铺满整条素材。
 */

/**
 * 一条音轨在素材内的取用区间。
 * - `start`：素材内的入点（秒，≥ 0）；
 * - `end`：素材内的出点（秒）；**0 = 到素材末尾**（与 EditClip.end 同一口径）；
 * - `seconds`：取用长度（秒）；素材时长未知且没有出点时是 0（与「时长未探测到就不画波形」的降级口径一致）；
 * - `trimmed`：真的裁过（决定导出请求 / 落盘要不要带新键）。
 */
export type EditAudioTrimWindow = { start: number; end: number; seconds: number; trimmed: boolean };

/** 被拖的那一端：`start` = 素材内入点（音轨条的左端），`end` = 素材内出点（右端）。 */
export type EditAudioTrimEdge = "start" | "end";

/** 素材时长：非有限值 / 0 / 负数一律当「未知」（此时长度只能靠出点算）。 */
function safeSourceSeconds(sourceSeconds: number) {
    return Number.isFinite(sourceSeconds) && sourceSeconds > 0 ? sourceSeconds : 0;
}

/** 非有限值一律当缺省值（0）：畸形数据不能把长度算成 NaN 或负数。 */
function clampNumber(value: number | undefined, minimum: number, maximum: number) {
    if (value === undefined || !Number.isFinite(value)) return minimum;
    return Math.min(maximum, Math.max(minimum, value));
}

/** 落点保留三位小数：与 resolveEditSnap 的候选秒数、音轨起点同一精度，吸附是否「真的吸上」才判得准。 */
function round3(value: number) {
    return Number((Number.isFinite(value) ? value : 0).toFixed(3));
}

/**
 * 读出一条音轨的取用区间。边界（都由这里兜住，调用方不再各写一份）：
 * - 入点缺省 / 0 → 素材开头；负数 / 非有限值 → 0；
 * - 出点缺省 / 0 / 越过素材末尾 → **到素材末尾**（落盘与导出请求里都不留多余的键）；
 * - 素材时长未知 → 只按出点算长度，没有出点就是 0（画不出波形，与今天的降级一致）；
 * - **入点 ≥ 出点**（含入点越过素材末尾这种畸形数据）→ 整段裁剪作废、按整条素材处理：
 *   既不能让整条轨静默消失，也不能把空区间交给 FFmpeg（`atrim=start=5:end=3` 会产出空流，
 *   让 amix 的输入数对不上而整次出片失败）。
 */
export function editAudioTrimWindow(track: Pick<EditAudioTrack, "sourceStart" | "sourceEnd">, sourceSeconds: number): EditAudioTrimWindow {
    const full = safeSourceSeconds(sourceSeconds);
    const ceiling = full > 0 ? full : Number.POSITIVE_INFINITY;
    const start = clampNumber(track.sourceStart, 0, ceiling);
    const requested = clampNumber(track.sourceEnd, 0, ceiling);
    // 与素材末尾重合的出点按「到素材末尾」处理（存 0），这样再拖回去时状态与改动前逐字相同。
    const end = requested > 0 && requested < ceiling ? requested : 0;
    const tail = end > 0 ? end : ceiling;
    if (tail <= start) return { start: 0, end: 0, seconds: full, trimmed: false };
    const length = tail - start;
    return { start, end, seconds: Number.isFinite(length) ? length : 0, trimmed: start > 0 || end > 0 };
}

/**
 * 拖某一端之后的落点（素材内的秒数）：只动被拖的那一条边，并夹进合法区间。
 * 夹到边界的落点仍然会被原样返回（调用方据此画把手），与视频片段的两端裁剪同一口径。
 */
export function editAudioTrimEdge(window: EditAudioTrimWindow, edge: EditAudioTrimEdge, targetSeconds: number, sourceSeconds: number): { start: number; end: number } {
    const full = safeSourceSeconds(sourceSeconds);
    const ceiling = full > 0 ? full : Number.POSITIVE_INFINITY;
    const upper = window.end > 0 ? window.end : ceiling;
    if (edge === "start") {
        return { start: round3(clampNumber(targetSeconds, 0, Math.max(0, upper - EDIT_MIN_TRIM_SECONDS))), end: window.end };
    }
    return { start: window.start, end: round3(clampNumber(targetSeconds, window.start + EDIT_MIN_TRIM_SECONDS, ceiling)) };
}

/**
 * 落盘 / 下发用的两个键：回到缺省的那一侧写回 `undefined`。
 * 两个字段都是可选、缺省即旧行为，所以**没有裁剪的工程一个字节都不变**，也不需要任何迁移代码。
 */
export function editAudioTrimFields(window: EditAudioTrimWindow): { sourceStart?: number; sourceEnd?: number } {
    return { sourceStart: window.start > 0 ? window.start : undefined, sourceEnd: window.end > 0 ? window.end : undefined };
}

/**
 * 拖某一端时的目标：被拖的那条边、当前的取用区间、这条轨在**成片时间轴**上的起点、素材时长。
 * 时间线容器（edit-stage）只认这一份描述，吸附候选点与阈值仍是它自己那唯一的一份。
 */
export type EditAudioTrimTarget = { edge: EditAudioTrimEdge; window: EditAudioTrimWindow; startSeconds: number; sourceSeconds: number };

/**
 * 拖两端时的落点：先按**既有**吸附候选点（0 秒 / 播放头 / 片段边界 / 网格，见 collectEditSnapPoints）
 * 吸附这条边，再夹进合法区间。夹取把吸附结果拉走时不再算吸附成功——
 * 与音轨起点、片段裁剪、字幕裁剪同一口径，导引线就不会指着一个到不了的位置。
 *
 * `filmSeconds` 是这条边在**成片时间轴上的绝对秒数**，也就是拖动时交给吸附的那个数
 * （素材内的秒数 − 入点 + 起点）；吸附完再按同一条换算换回素材内秒数，与**片段裁剪**逐字同形。
 */
export function resolveEditAudioTrim(filmSeconds: number, target: EditAudioTrimTarget, points: EditSnapPoint[], thresholdSeconds: number): EditSnapResult {
    const snapped = resolveEditSnap(filmSeconds, 0, points, thresholdSeconds);
    const material = round3(snapped.seconds - target.startSeconds + target.window.start);
    const trimmed = editAudioTrimEdge(target.window, target.edge, material, target.sourceSeconds);
    // 比较用的是**素材内的秒数**（夹取后的落点）：夹取把吸附结果拉走时就不算吸上，导引线随之收起。
    const applied = target.edge === "start" ? trimmed.start : trimmed.end;
    return snapped.snapped && applied === material ? { seconds: applied, snapped: true, point: snapped.point } : { seconds: applied, snapped: false };
}
