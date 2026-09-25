import { editOutputSeconds, editTransitionSeconds, type EditClipView } from "./timeline";

/**
 * SRT / WebVTT 字幕文件的纯解析与「导入后会怎样」的映射核算。
 *
 * 铁律：任何输入都不抛异常。畸形条目一律记成一条 issue 并跳过，绝不静默丢弃，
 * 也绝不让一份坏文件把界面搞崩（解析结果里同时给出一共读到几条、跳过了几条与逐条原因）。
 */

/** 一条解析出来的字幕：时间是**源文件里的秒数**，与成片无关。 */
export type SubtitleCue = {
    start: number;
    end: number;
    text: string;
};

/** 跳过（或需要提醒）的原因，界面按这个代码给出中英文案。 */
export type SubtitleIssueReason =
    /** 这一块里没有 `-->` 时间行。 */
    | "missingTiming"
    /** 时间行在，但两侧的时间码读不出来。 */
    | "invalidTiming"
    /** 结束不晚于开始（倒序 / 零长度）。 */
    | "reversedTiming"
    /** 去掉行内标记之后一个字都没有。 */
    | "emptyText";

export type SubtitleIssue = {
    /** 该条目在源文件里的起始行号（从 1 开始），用于告诉用户「第几行有问题」。 */
    line: number;
    reason: SubtitleIssueReason;
};

export type SubtitleFormat = "srt" | "vtt";

export type SubtitleParseResult = {
    format: SubtitleFormat;
    cues: SubtitleCue[];
    issues: SubtitleIssue[];
};

/**
 * 字幕文件的字节 → 文本。UTF-8 优先（绝大多数情况），
 * 解不出来时按 BOM 认 UTF-16，再退到 GB18030（中文 SRT 里非常常见的编码），
 * 最后用非严格 UTF-8 兜底，保证**永远返回一个字符串**、绝不抛异常。
 */
export function decodeSubtitleBytes(bytes: Uint8Array): string {
    // BOM 必须先看：UTF-16 文本的字节流本身也是合法 UTF-8（每个 ASCII 字符后面跟一个 NUL），
    // 先按 UTF-8 解会解出一串夹着 \0 的乱码，而不是报错。
    const bom = bytes.length >= 2 ? (bytes[0]! << 8) | bytes[1]! : 0;
    for (const [marker, label] of [
        [0xfeff, "utf-16be"],
        [0xfffe, "utf-16le"],
    ] as const) {
        if (bom !== marker) continue;
        try {
            return new TextDecoder(label).decode(bytes);
        } catch {
            break;
        }
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        // 不是合法 UTF-8：按中文常见编码兜底。
    }
    for (const label of ["gb18030", "gbk"]) {
        try {
            return new TextDecoder(label).decode(bytes);
        } catch {
            // 这台机器的 TextDecoder 不认这个编码，换下一个。
        }
    }
    return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 时间码：`[HH:]MM:SS[,|.]mmm`，SRT 与 VTT 的两种写法都吃。
 * 逐项都往宽处理，只要求能读成一个数：
 * - 小时可以超过 99，也可以整段省略（VTT 允许 `MM:SS.mmm`）；
 * - 分 / 秒超过 59 照样按十进制折算（`00:00:75,000` = 75 秒），不整条拒绝；
 * - 毫秒不足三位按十进制小数读（`,4` = 400ms、`,45` = 450ms），超过三位截到毫秒。
 */
function parseTimeToken(token: string): number | null {
    const match = /^(?:(\d{1,6}):)?(\d{1,3}):(\d{1,3})(?:[.,](\d{1,6}))?$/.exec(token.trim());
    if (!match) return null;
    const [, hours, minutes, seconds, fraction] = match;
    const millis = fraction ? Number(fraction.padEnd(3, "0").slice(0, 3)) : 0;
    return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + millis / 1000;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * 字幕文本清洗：去掉 VTT 的行内标记（`<v Speaker>`、`<i>`、`<c.foo>`、内联时间戳）与 SRT 的 HTML 标签，
 * 再还原常见实体。直接把这些标记原样写进烧字的 SRT 里，观众看到的就是一堆尖括号。
 */
function cleanCueText(raw: string) {
    return raw
        .replace(/<[^>]*>/g, "")
        .replace(/&#(\d+);/g, (_match, code: string) => (Number(code) > 0 && Number(code) < 0x110000 ? String.fromCodePoint(Number(code)) : ""))
        .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
        .trim();
}

/** 时间行 → [开始, 结束]；两侧任一侧读不出来就是 null。 */
function splitTiming(line: string): [number | null, number | null] {
    const parts = line.split("-->");
    if (parts.length !== 2) return [null, null];
    // 结束时间后面可能跟着 VTT 的 cue settings（`align:middle line:90%`），只取第一个词。
    const endToken = parts[1]!.trim().split(/\s+/)[0] ?? "";
    return [parseTimeToken(parts[0]!), parseTimeToken(endToken)];
}

/** 两侧都能读成时间码的时间行：只有这样的行才敢当成「下一条字幕的开始」。 */
function isTimingLine(line: string) {
    if (!line.includes("-->")) return false;
    const [start, end] = splitTiming(line);
    return start !== null && end !== null;
}

/**
 * 读一个块。序号行（SRT 的 `1`）与 VTT 的 cue id 都在时间行**之前**，
 * 这里只取时间行之后的全部内容当文本，所以「序号行缺失 / 序号行写乱」都不影响解析；
 * 反过来，正文里一行纯数字也不会被误当成序号吃掉。
 *
 * 有些文件条目之间漏了空行（整份文件就是一个大块），所以块内再出现一条时间行时从这里断开，
 * 逐条读下去——否则两条字幕会被并成一条夹着时间码的怪文本。
 */
function readBlock(blockLines: string[], blockFirstLine: number, cues: SubtitleCue[], issues: SubtitleIssue[]) {
    let lines = blockLines;
    let firstLine = blockFirstLine;
    // VTT 的文件头与可选块（NOTE / STYLE / REGION）不是字幕条目：整段丢掉，且不计入「跳过条目」。
    // 文件里没写空行时它们会和第一条字幕挤在同一个块里，所以不是直接放弃这一块，
    // 而是跳到第一条时间行——这样「头后面直接跟字幕」的文件照样能读出来。
    if (/^(WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE\s*$|REGION\s*$)/i.test(lines[0]!.trim())) {
        const timing = lines.findIndex((line) => line.includes("-->"));
        if (timing < 0) return;
        lines = lines.slice(timing);
        firstLine += timing;
    }

    let offset = 0;
    while (offset < lines.length) {
        const rest = lines.slice(offset);
        const timingIndex = rest.findIndex((line) => line.includes("-->"));
        if (timingIndex < 0) {
            // 整块里连一条时间行都没有：这一块是废块，只记一次，不再往下找。
            if (offset === 0) issues.push({ line: firstLine, reason: "missingTiming" });
            return;
        }
        const textStart = offset + timingIndex + 1;
        const nextIndex = lines.findIndex((line, index) => index >= textStart && isTimingLine(line));
        // 下一条字幕的序号行紧贴在它的时间行之前：漏空行的文件里这一行会落进本条的正文，剔掉。
        const dropIndexLine = nextIndex > textStart && /^\d+$/.test(lines[nextIndex - 1]!.trim()) ? 1 : 0;
        const textEnd = nextIndex < 0 ? lines.length : nextIndex - dropIndexLine;
        const at = firstLine + offset + timingIndex;
        const [start, end] = splitTiming(lines[offset + timingIndex]!);
        const text = cleanCueText(lines.slice(textStart, textEnd).join("\n"));

        if (start === null || end === null) issues.push({ line: at, reason: "invalidTiming" });
        else if (end <= start) issues.push({ line: at, reason: "reversedTiming" });
        else if (!text) issues.push({ line: at, reason: "emptyText" });
        else cues.push({ start, end, text });

        if (nextIndex < 0) return;
        offset = nextIndex;
    }
}

/** SRT / WebVTT 文本 → 条目列表。自动判别格式：第一行非空内容以 `WEBVTT` 开头就是 WebVTT。 */
export function parseSubtitleFile(input: string): SubtitleParseResult {
    const text = String(input ?? "")
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const format: SubtitleFormat = (lines.find((line) => line.trim()) ?? "").trim().toUpperCase().startsWith("WEBVTT") ? "vtt" : "srt";

    const cues: SubtitleCue[] = [];
    const issues: SubtitleIssue[] = [];
    let block: string[] = [];
    let blockLine = 1;
    const flush = () => {
        if (block.length) readBlock(block, blockLine, cues, issues);
        block = [];
    };
    lines.forEach((line, index) => {
        if (!line.trim()) {
            flush();
            return;
        }
        if (!block.length) blockLine = index + 1;
        block.push(line);
    });
    flush();

    // 源文件里的顺序不影响成片：统一按起点排序（同起点保持原顺序），导出时逐条照写。
    cues.sort((left, right) => left.start - right.start);
    return { format, cues, issues };
}

/** 导入之后会发生什么：逐条与成片时间轴比对。一条都不丢，只是把「会怎样」如实算出来给用户看。 */
export type SubtitleImportSummary = {
    /** 起点落在成片之内的条数。 */
    inside: number;
    /** 起点已经在成片末尾之后：导出里一个字都不会出现。 */
    beyondEnd: number;
    /** 起点在成片内、结束超出成片末尾：只会显示前半段。 */
    truncated: number;
    /** 跨越片段接缝的条数：独立字幕轨按绝对时间显示，跨接缝照常连续显示，只是提醒用户。 */
    crossingSeams: number;
    /** 与上一条时间重叠的条数：成片里会同时出现两行。 */
    overlapping: number;
};

export function summarizeSubtitleImport(cues: SubtitleCue[], clips: EditClipView[]): SubtitleImportSummary {
    const total = editOutputSeconds(clips);
    const transitions = editTransitionSeconds(clips);
    // 成片时间轴上的片段边界：每经过一次转场，后面的边界都要往前挪一个转场时长（与 Rust 侧同口径）。
    const seams: number[] = [];
    let cursor = 0;
    clips.forEach((clip, index) => {
        cursor += clip.length - (transitions[index] ?? 0);
        if (index + 1 < clips.length) seams.push(cursor);
    });
    const sorted = [...cues].sort((left, right) => left.start - right.start);
    // 成片时长为 0（时间线还是空的）时，任何条目都只能算「在成片末尾之后」。
    const visible = (cue: SubtitleCue) => total > 0 && Number.isFinite(total) && cue.start < total;
    return {
        inside: cues.filter(visible).length,
        beyondEnd: cues.filter((cue) => !visible(cue)).length,
        truncated: cues.filter((cue) => visible(cue) && cue.end > total).length,
        crossingSeams: cues.filter((cue) => seams.some((seam) => cue.start < seam && seam < cue.end)).length,
        overlapping: sorted.filter((cue, index) => index > 0 && cue.start < sorted[index - 1]!.end).length,
    };
}
