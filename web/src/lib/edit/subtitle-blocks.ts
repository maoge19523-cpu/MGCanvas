import { timeToPercent } from "@/lib/timeline-scale";
import type { EditSubtitle } from "@/types/edit";
import { resolveEditSnap, type EditSnapPoint, type EditSnapResult } from "./timeline-edit";

/**
 * 时间线上的**字幕块**：把导入的字幕（[EditSubtitle]，时间是成片时间轴上的绝对秒数）
 * 换算成一条字幕轨道行里的可见块。
 *
 * 与接缝上的转场标记**性质不同**，别照抄那一套：
 * - 转场标记是**覆盖层**——绝对定位、只写 left、不写 width，压在分界线上，不参与宽度分配；
 * - 字幕块是**按时间定位的内容**，与片段条 / 波形条同类：left 与 width **都**必须由
 *   lib/timeline-scale 的同一套换算得出（两条边各算一次百分比，宽度取两条边的差，
 *   与 timelinePlacements 的算法完全一致）。给它省掉 width 就再也对不上时间轴了。
 *
 * 时间语义上的三个既有约定在这里**照原样保留**，不做任何"修正"：
 * 允许跨片段、允许互相重叠、允许落在成片之外。落在成片之外只是"导出里看不到"，
 * 不是"数据错了"，所以这里只标注状态，绝不悄悄改数。
 */

/**
 * 极短字幕的**可点下限**（px）。
 *
 * 与片段条未探测到时长时的 EDIT_CLIP_MIN_PX 是同一个先例：绝对定位的元素写 min-width
 * 不会推动任何别的元素，因此不会引入累积偏移，也不会改变标尺 / 播放头 / 波形条的百分比。
 * 一句 0.1 秒的字幕在整条时间轴上可能只有不到 1px 宽——不给下限就既看不见也抓不住。
 * 同一件事顺带解决了「落在成片末尾之后的字幕」：它们的 left 钉在 100%、宽度为 0，
 * 这个下限让它们在轨道最右端仍然是一个可抓的小块，拖着往左就能拉回成片之内。
 */
export const EDIT_SUBTITLE_MIN_PX = 6;

/** 裁剪字幕时两条边之间至少留出的秒数（与 EDIT_MIN_CLIP_SECONDS 同口径）。 */
export const EDIT_MIN_SUBTITLE_SECONDS = 0.05;

/** 块里显示的摘要上限：正文再长也只渲染这么多个字符，全文走 title。 */
export const EDIT_SUBTITLE_LABEL_LIMIT = 48;

/** 非有限值与负数一律当 0：畸形数据不能把百分比算成 NaN。 */
function safeSeconds(value: number) {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function round3(value: number) {
    return Number((Number.isFinite(value) ? value : 0).toFixed(3));
}

/** 块的定位占位：left / width 都是整条轨道宽度的百分比。 */
export type EditSubtitlePlacement = { left: number; width: number };

/**
 * 一条字幕的占位。两条边**各自**走 timeToPercent（与标尺刻度、播放头、片段条、波形条同一套换算），
 * 宽度取两条边的差，于是右边缘永远等于 end 的换算值。
 *
 * 边界（都由 timeToPercent 的既有约定兜住，不另写分支）：
 * - start 为负 / 非有限 → 当 0；
 * - end ≤ start（时长为零或倒序）→ 宽度 0，不画负宽度；
 * - end 超出成片总长 → 右边缘裁到 100%（成片末尾那一刻），与波形条"只画到成片末尾"同口径；
 * - start 超出成片总长 → left 钉在 100%、宽度 0（整条都在成片之外）；
 * - 成片总长为 0（时间线是空的）→ left 与 width 都是 0。
 */
export function editSubtitlePlacement(start: number, end: number, totalSeconds: number): EditSubtitlePlacement {
    const total = safeSeconds(totalSeconds);
    const from = Math.min(safeSeconds(start), total);
    const to = Math.min(Math.max(safeSeconds(end), from), total);
    const left = timeToPercent(from, total);
    return { left, width: timeToPercent(to, total) - left };
}

/** 时间线上一行的字幕块：定位值 + 原始起止 + 两个"要提醒"的状态位。 */
export type EditSubtitleBlock = {
    id: string;
    /** 在字幕列表里的序号（1 起），与属性区的编号同一个来源。 */
    index: number;
    /** 原始起止（秒）：与数据逐字一致，不被任何裁剪影响。 */
    start: number;
    end: number;
    /** 时长（秒），可能为 0。 */
    seconds: number;
    /** 完整正文（块里只显示摘要，全文走 title）。 */
    text: string;
    /** 块里显示的截断摘要。 */
    label: string;
    /** 占整条轨道宽度的百分比：直接来自 editSubtitlePlacement。 */
    left: number;
    width: number;
    /** 整条落在成片末尾之后：导出里一个字都不会出现。 */
    beyondEnd: boolean;
    /** 起点在成片内、终点超出：右边缘被裁到成片末尾，成片里只显示前半段。 */
    clipped: boolean;
    /** 与别的字幕在时间上重叠：同一行会互相压住。 */
    overlapping: boolean;
};

/** 摘要：多行正文压成一行（块只有一行高），超长截断。全文由 title 给出。 */
export function editSubtitleLabel(text: string, limit = EDIT_SUBTITLE_LABEL_LIMIT) {
    const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 重叠区间：**同一时刻有两条以上字幕**的那一段。
 * 事件扫描：每个起点 +1、每个终点 −1，深度 ≥ 2 的极大区间就是一条 band，
 * count 取该区间内出现过的最大深度（"这里叠了几条"直接读它）。
 *
 * **同一时刻先处理终点**：一条 3 秒结束、另一条 3 秒开始不算重叠——
 * 与属性区 SUBTITLE 的 overlapping 统计（`cue.start < 前一条.end`）严格同一口径，
 * 也就是"首尾相接不算叠"，只在真的会同时出现两行时才标出来。
 */
export type EditSubtitleOverlapBand = { start: number; end: number; count: number };

export function editSubtitleOverlapBands(subtitles: readonly EditSubtitle[]): EditSubtitleOverlapBand[] {
    const spans = subtitles
        .map((cue) => ({ start: safeSeconds(cue.start), end: safeSeconds(cue.end) }))
        .filter((span) => span.end > span.start)
        .sort((left, right) => left.start - right.start || left.end - right.end);

    // 事件表：同一时刻终点（-1）排在起点（+1）前面，于是"首尾相接"不会凑出深度 2。
    const events = spans.flatMap((span) => [
        { at: span.start, delta: 1 },
        { at: span.end, delta: -1 },
    ]);
    events.sort((left, right) => left.at - right.at || left.delta - right.delta);

    const bands: EditSubtitleOverlapBand[] = [];
    let depth = 0;
    let openedAt: number | null = null;
    let peak = 0;
    for (const event of events) {
        const before = depth;
        depth += event.delta;
        if (depth >= 2) {
            if (before < 2) {
                openedAt = event.at;
                peak = depth;
            } else peak = Math.max(peak, depth);
            continue;
        }
        if (before >= 2 && openedAt !== null) {
            if (event.at > openedAt) bands.push({ start: openedAt, end: event.at, count: peak });
            openedAt = null;
            peak = 0;
        }
    }
    return bands;
}

/** 这条字幕落在某段重叠区间里（只要与 band 有交集就算）。 */
function spansBand(span: { start: number; end: number }, band: EditSubtitleOverlapBand) {
    return band.start < span.end && span.start < band.end;
}

/**
 * 全部字幕块，按字幕列表顺序（与属性区的编号一致）。
 * 落点一律走 editSubtitlePlacement，块本体不自己算百分比，也不从别的元素身上取宽度。
 */
export function editSubtitleBlocks(subtitles: readonly EditSubtitle[], totalSeconds: number): EditSubtitleBlock[] {
    const total = safeSeconds(totalSeconds);
    const bands = editSubtitleOverlapBands(subtitles);
    return subtitles.map((cue, index) => {
        const start = safeSeconds(cue.start);
        const end = safeSeconds(cue.end);
        const { left, width } = editSubtitlePlacement(start, end, total);
        return {
            id: cue.id,
            index: index + 1,
            start,
            end,
            seconds: Math.max(0, end - start),
            text: cue.text,
            label: editSubtitleLabel(cue.text),
            left,
            width,
            // 成片总长为 0（时间线还是空的）时，属性区同样把每条都算成"在成片末尾之后"，这里同一口径。
            beyondEnd: total > 0 ? start >= total : true,
            clipped: total > 0 && start < total && end > total,
            overlapping: bands.some((band) => spansBand({ start, end }, band)),
        };
    });
}

/** 成片末尾之外的字幕条数（时间线上给一条汇总提示，不逐条画像素）。 */
export function countEditSubtitlesBeyondEnd(blocks: readonly EditSubtitleBlock[]) {
    return blocks.filter((block) => block.beyondEnd).length;
}

/**
 * 拖块身：整段平移、**时长不变**，起点不低于 0。
 * 时长按原始 start / end 现算，于是拖动过程中反复调用不会把时长一点点磨掉。
 */
export function moveEditSubtitle(start: number, end: number, targetStart: number): { start: number; end: number } {
    const duration = Math.max(0, safeSeconds(end) - safeSeconds(start));
    const from = Math.max(0, Number.isFinite(targetStart) ? targetStart : safeSeconds(start));
    return { start: round3(from), end: round3(from + duration) };
}

/**
 * 拖两端：只动被拖的那一条边（裁剪），两条边之间至少留 EDIT_MIN_SUBTITLE_SECONDS。
 * 起点不小于 0；终点不设上界——上一轮明确允许字幕落在成片之外，这里也不偷偷把它拉回来。
 */
export function trimEditSubtitle(start: number, end: number, edge: "start" | "end", target: number): { start: number; end: number } {
    const from = safeSeconds(start);
    const to = Math.max(safeSeconds(start), safeSeconds(end));
    if (edge === "start") {
        const next = Math.min(Math.max(0, safeSeconds(target)), Math.max(0, to - EDIT_MIN_SUBTITLE_SECONDS));
        return { start: round3(next), end: round3(to) };
    }
    const next = Math.max(safeSeconds(target), from + EDIT_MIN_SUBTITLE_SECONDS);
    return { start: round3(from), end: round3(next) };
}

/**
 * 拖两端时的落点：先按**既有**吸附候选点（0 秒 / 播放头 / 片段边界 / 网格，见 collectEditSnapPoints）
 * 吸附这一条边，再夹进合法区间。夹取把吸附结果拉走时不再算吸附成功——
 * 与音轨起点、片段裁剪同一口径，导引线就不会指着一个到不了的位置。
 */
export function resolveEditSubtitleEdge(rawSeconds: number, edge: "start" | "end", start: number, end: number, points: EditSnapPoint[], thresholdSeconds: number): EditSnapResult {
    const snapped = resolveEditSnap(rawSeconds, 0, points, thresholdSeconds);
    const trimmed = trimEditSubtitle(start, end, edge, snapped.seconds);
    const applied = edge === "start" ? trimmed.start : trimmed.end;
    return snapped.snapped && applied === snapped.seconds ? { seconds: applied, snapped: true, point: snapped.point } : { seconds: applied, snapped: false };
}
