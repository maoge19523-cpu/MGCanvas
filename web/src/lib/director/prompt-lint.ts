/**
 * 「AI 导演」提示词规范自检。
 *
 * 判断逻辑移植自官方分镜交付用的 h3_prompt_lint.py，并适配「AI 导演」的实际产出形态
 * （按「=== 镜头 N ===」分隔的一条条独立提示词，而不是成对的 HTML 交付块）。
 *
 * 覆盖：字段名与顺序、对齐指令、镜头编号与时间轴、引用标签闭环、配乐是否具体、
 * 作者模板泄漏，以及官方密度规范（对白字/秒与收尾余量）。
 *
 * 全部是纯函数，不依赖网络与 DOM，方便直接单测。
 */
import { DIRECTOR_MODES, type DirectorMode, type DirectorTarget } from "./specs";

export type LintSeverity = "error" | "warn";

export type DirectorLintIssue = {
    /** 第几条镜头（从 1 开始）；整段级别的问题为 0。 */
    shot: number;
    code: string;
    severity: LintSeverity;
    message: string;
};

export type DirectorLintReport = {
    shots: number;
    errors: number;
    warnings: number;
    issues: DirectorLintIssue[];
    ok: boolean;
};

/** 一条镜头短于这个长度时提示可能漏写了构图/动作/运镜/声音；正式判定看下面的密度规则。 */
const SHORT_SHOT_CHARS = 120;
/** 时间允许比要求时长多出的秒数，避免四舍五入被误判。 */
const DURATION_TOLERANCE = 0.05;
/** 配乐要么写 N/A，要么具体到能被听见；少于这个词数就只算情绪标签。 */
const CONCRETE_MUSIC_MIN_WORDS = 4;

/** 官方密度规范：普通对白 4.0–4.5 字/秒（默认 4.25），慢速画外音 2.5–3.0（默认 3.0）。 */
const SPEECH_RATE_MAX = 4.5;
const SPEECH_RATE_SLOW_MAX = 3.0;
/** 建立镜头 0.3–0.5 秒、念白后收尾 0.3–0.8 秒，合起来至少留这么多。 */
const MIN_NON_SPEECH_HEADROOM = 0.6;
/** Seedance 是 15 秒包络，官方建议内部 2–3 个镜头，超过 5 个明显过密。 */
const SEEDANCE_MAX_SHOTS = 5;

const H3_SECTIONS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"] as const;
const REF_SECTIONS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"] as const;

/** H3 的引用标签：<Subject 1> / <Picture 2> / <Video 1> / <Audio 1>。 */
const LABEL_PATTERN = /<(Subject|Picture|Video|Audio)\s+(\d+)>/g;
/** 两位小数的时间，例如 0.00 / 3.50。 */
const TIME_PATTERN = /\b\d+\.\d{2}\b/g;
/** 起止时间区间，容忍 - – — ~ 到 至 几种写法。 */
const RANGE_PATTERN = /(\d+\.\d{2})\s*(?:-|–|—|~|至|到)\s*(\d+\.\d{2})/g;
/** 可接受的「无配乐」写法。 */
const NO_MUSIC = /^(n\/?a|none|no music|无配乐)[.。]?$/i;
/** 汉字计数：标点不计入，与官方对白字数口径一致。 */
const HAN_PATTERN = /[\u4e00-\u9fff]/g;
/**
 * 中文念白：说话动词 + 冒号 + 原语言台词。
 *
 * 动词同时认中文和英文，因为 H3 基础模式的描述是英文写的，中文台词会写成
 * 「she whispers: 你好。」这种形式；引号包起来的原语言台词也一并算上。
 */
const ZH_DIALOGUE = /[^\n]{1,240}(?:说|问|答|回应|低声|开口|画外音|实际说出|says?|saying|whispers?|asks?|answers?|replies|speaks?|delivers?)[^：:\n]{0,220}[：:]\s*(?<line>[^\n]+)/gi;
const QUOTED_DIALOGUE = /[「“"](?<line>[^」”"\n]{1,200})[」”"]/g;

/** 作者模板泄漏：模型把「怎么写」而不是「拍什么」写进了提示词。 */
const AUTHORING_LEAKS: readonly { name: string; pattern: RegExp }[] = [
    { name: "第一个决定性动作", pattern: /第一个决定性动作/ },
    { name: "下一条原文信息", pattern: /新增下一条原文信息|下一条原文信息/ },
    { name: "信息落地占位", pattern: /信息落地或动作结果/ },
    { name: "承接占位", pattern: /承接上一段|保持同前|根据需要选择镜头|同上一条|沿用上一条/ },
    { name: "镜头二选一", pattern: /(?:远景|中景|近景|特写|过肩|道具主导)[^。\n]{0,60}(?:或|、)[^。\n]{0,60}(?:远景|中景|近景|特写|过肩|道具主导)/ },
];
const EN_AUTHORING_LEAK = /same as (?:the )?(?:previous|prior) (?:clip|unit|prompt)|choose (?:a|the) (?:shot|framing)|add the next source fact|first decisive action/i;

/**
 * 按「=== 镜头 N ===」切分模型输出；识别不出分隔符就整段作为一条。
 *
 * 模型经常自己加上或去掉分隔行，所以这里同时处理「行首分隔」和「独立成行」两种写法。
 */
export function splitDirectorShots(text: string): string[] {
    const blocks = text
        .split(/\n\s*={2,}\s*镜头\s*\d+\s*={2,}\s*\n/)
        .map((item) => item.replace(/^\s*={2,}\s*镜头\s*\d+\s*={2,}\s*$/gm, "").trim())
        .filter(Boolean);
    return blocks.length > 1 ? blocks : [text.trim()];
}

function countHan(text: string): number {
    return (text.match(HAN_PATTERN) || []).length;
}

/** 抽出会被念出来的中文内容，用于密度核算。 */
function spokenLines(text: string): string[] {
    const lines: string[] = [];
    for (const pattern of [ZH_DIALOGUE, QUOTED_DIALOGUE]) {
        for (const matched of text.matchAll(pattern)) {
            const line = matched.groups?.line?.trim();
            if (line) lines.push(line);
        }
    }
    return lines;
}

/**
 * 字段检查：恰好出现一次，带冒号写法时不能为空。
 *
 * H3 的三个字段允许连着写在同一行（`… amplitude. overall_soundscape: … non_diegetic_music: …`），
 * 所以带冒号的字段名不要求独占一行；全能参考的六段是不带冒号的独立段名，那种才要求整行只有段名。
 * 只要求带冒号，是为了不让正文里顺口提到字段名就被算成字段。
 */
function lintSections(text: string, sections: readonly string[]): DirectorLintIssue[] {
    const issues: DirectorLintIssue[] = [];
    const push = (code: string, severity: LintSeverity, message: string) => issues.push({ shot: 0, code, severity, message });
    const positions: number[] = [];

    for (const name of sections) {
        const inline = [...text.matchAll(new RegExp(`${name}[ \\t]*:`, "g"))];
        const bare = [...text.matchAll(new RegExp(`^[ \\t]*${name}[ \\t]*$`, "gm"))];
        const found = inline.length ? inline : bare;
        if (!found.length) {
            push("missingSection", "error", `缺少必需字段 ${name}（字段名要原样保留）。`);
            continue;
        }
        if (found.length > 1) push("duplicateSection", "error", `字段 ${name} 出现了 ${found.length} 次，只应出现一次。`);
        positions.push(found[0].index ?? 0);
        if (inline.length) {
            const rest = text.slice((inline[0].index ?? 0) + inline[0][0].length);
            if (!rest.split(/\r?\n/)[0].trim()) push("emptySection", "error", `字段 ${name} 是空的。`);
        }
    }

    if (positions.length > 1 && positions.some((value, index) => index > 0 && value < positions[index - 1])) {
        push("sectionOrder", "error", `字段顺序不对，必须按官方顺序排列：${sections.join(" → ")}。`);
    }
    return issues;
}

/**
 * 这一条镜头在整段输出里的位置。
 *
 * 「AI 导演」的产出是「一条镜头一条独立提示词」，所以每条里的 `[Shot N]` 是它在整片里的序号、
 * 时间是它在整片里的全局时间段。按「每条都从 0.00 起、都写 [Shot 1]」判会条条误报。
 */
export type DirectorShotSlot = {
    /** 第几条，从 1 开始。 */
    index: number;
    /** 这一条应当开始的时间：接在上一条结束处，第一条是 0。 */
    start: number;
};

function shotTimes(text: string): number[] {
    return (text.match(TIME_PATTERN) || []).map(Number);
}

/** 这一条自己覆盖的时长；取不到区间时返回 undefined。 */
function shotSpan(text: string): number | undefined {
    const times = shotTimes(text);
    if (times.length < 2) return undefined;
    const span = Math.max(...times) - Math.min(...times);
    return span > 0 ? span : undefined;
}

/** 这一条覆盖到的结束时间，用来给下一条核对起点。 */
function shotEnd(text: string): number | undefined {
    const range = [...text.matchAll(RANGE_PATTERN)][0];
    if (range) return Number(range[2]);
    const times = shotTimes(text);
    return times.length ? Math.max(...times) : undefined;
}

/** 镜头编号与时间轴：编号要对得上第几条，时间首尾相接并覆盖到总时长。 */
function lintTimeline(text: string, options: { duration?: number; slot?: DirectorShotSlot }): DirectorLintIssue[] {
    const { duration, slot } = options;
    const issues: DirectorLintIssue[] = [];
    const push = (code: string, severity: LintSeverity, message: string) => issues.push({ shot: 0, code, severity, message });

    // 对齐指令里会合法地再提一次镜头编号，所以按去重后的编号判断。
    const numbers = [...new Set([...text.matchAll(/\[Shot\s+(\d+)\]/g)].map((matched) => Number(matched[1])))].sort((left, right) => left - right);
    if (numbers.length && slot && !numbers.includes(slot.index)) {
        push("shotNumbering", "error", `这是第 ${slot.index} 条镜头，提示词里应写 [Shot ${slot.index}]，实际写的是 ${numbers.map((value) => `[Shot ${value}]`).join("、")}。`);
    } else if (numbers.length && !slot && numbers.some((value, index) => value !== index + 1)) {
        push("shotNumbering", "error", `镜头编号不是从 1 连续递增：${numbers.join("、")}。`);
    }

    const ranges = [...text.matchAll(RANGE_PATTERN)].map((matched) => ({ start: Number(matched[1]), end: Number(matched[2]) }));
    const times = shotTimes(text);
    if (times.length < 2) {
        push("missingTime", "error", "没有给出起止时间，或时间不是两位小数（例如 0.00）。");
        return issues;
    }
    if (duration && Math.max(...times) > duration + DURATION_TOLERANCE) {
        push("timeOverflow", "error", `镜头时间到了 ${Math.max(...times).toFixed(2)} 秒，超过了设定的 ${duration} 秒。`);
    }

    const want = slot?.start ?? 0;
    if (ranges.length) {
        if (Math.abs(ranges[0].start - want) > DURATION_TOLERANCE) {
            push(
                "timeStart",
                "error",
                slot
                    ? `这是第 ${slot.index} 条镜头，应从 ${want.toFixed(2)} 秒开始（接在上一条之后），现在是 ${ranges[0].start.toFixed(2)} 秒。`
                    : `第一个镜头必须从 0.00 秒开始，现在是 ${ranges[0].start.toFixed(2)} 秒。`,
            );
        }
        for (let index = 1; index < ranges.length; index += 1) {
            if (Math.abs(ranges[index].start - ranges[index - 1].end) > DURATION_TOLERANCE) {
                push("timeGap", "error", `第 ${index + 1} 段从 ${ranges[index].start.toFixed(2)} 秒开始，但上一段结束在 ${ranges[index - 1].end.toFixed(2)} 秒，镜头时间必须首尾相接。`);
            }
        }
        if (ranges.some((range) => range.end <= range.start)) push("timeReverse", "error", "有镜头的结束时间不晚于开始时间。");
    }
    return issues;
}

/** 官方密度规范：对白要念得完，且留得出建立与收尾。seconds 是这一条自己的时长。 */
function lintDensity(text: string, seconds?: number): DirectorLintIssue[] {
    const issues: DirectorLintIssue[] = [];
    const push = (code: string, severity: LintSeverity, message: string) => issues.push({ shot: 0, code, severity, message });
    if (!seconds || seconds <= 0) return issues;

    const lines = spokenLines(text);
    if (!lines.length) return issues;
    const characters = lines.reduce((sum, line) => sum + countHan(line), 0);
    if (!characters) return issues;

    const rate = characters / seconds;
    if (rate > SPEECH_RATE_MAX) {
        push("speechTooFast", "error", `这段对白共 ${characters} 字、镜头 ${seconds.toFixed(2)} 秒，约 ${rate.toFixed(1)} 字/秒，超过官方上限 ${SPEECH_RATE_MAX} 字/秒，念不完。`);
    } else if (rate <= SPEECH_RATE_SLOW_MAX && characters >= 4) {
        // 慢速只在画外音/内心独白时才成立，普通对白这么慢会显得拖。
        push("speechSlow", "warn", `约 ${rate.toFixed(1)} 字/秒，属于慢速画外音的节奏；如果是普通对白会显得拖沓。`);
    }

    const speechTime = characters / SPEECH_RATE_MAX;
    if (seconds - speechTime < MIN_NON_SPEECH_HEADROOM && rate <= SPEECH_RATE_MAX) {
        push("speechNoHeadroom", "warn", `对白几乎占满 ${seconds.toFixed(2)} 秒，没有留给建立镜头（0.3–0.5 秒）和念白后收尾（0.3–0.8 秒）的余量。`);
    }
    return issues;
}

/** 校验单条镜头提示词。给了 slot 就按「整片里的第几条」判，不给就按单条自足序列判。 */
export function lintDirectorShot(shot: string, options: { mode: DirectorMode; target: DirectorTarget; duration?: number; slot?: DirectorShotSlot }): DirectorLintIssue[] {
    const { mode, target, duration, slot } = options;
    const issues: DirectorLintIssue[] = [];
    const push = (code: string, severity: LintSeverity, message: string) => issues.push({ shot: 0, code, severity, message });
    const text = shot.trim();

    if (!text) {
        push("empty", "error", "这一条是空的。");
        return issues;
    }
    if (text.length < SHORT_SHOT_CHARS) push("short", "warn", `内容偏短（${text.length} 字），可能漏写了构图、主体、环境、动作、运镜或声音。`);
    if (text.includes("```")) push("fence", "error", "提示词里出现了代码块围栏，应去掉。");
    if (/(负面提示词|negative\s*prompt)/i.test(text)) push("negative", "warn", "出现了「负面提示词」写法，官方结构不要求它。");
    if (/S\.SS|\[Shot\s*N\]|\bN\b\s*个镜头/.test(text)) push("placeholder", "error", "还留着 S.SS / N 这类占位符，没有替换成实际值。");
    if (/\|/.test(text)) push("tablePipe", "warn", "提示词里出现了竖线 |，像是在贴表格。");
    for (const leak of AUTHORING_LEAKS) {
        if (leak.pattern.test(text)) push("authoringLeak", "warn", `像是写给人看的写作说明，不是镜头内容（${leak.name}）。`);
    }
    if (EN_AUTHORING_LEAK.test(text)) push("authoringLeak", "warn", "出现了「同上一条 / 自行选择机位」这类相对指令或模板语言。");

    issues.push(...(target === "seedance" ? lintSeedance(text, duration) : lintH3(text, mode, { duration, slot })));
    // 密度按这一条自己的时长算：整片总时长套到单条上会把正常对白判成超速。
    issues.push(...lintDensity(text, shotSpan(text) ?? duration));
    return issues;
}

function lintH3(text: string, mode: DirectorMode, options: { duration?: number; slot?: DirectorShotSlot }): DirectorLintIssue[] {
    const { duration, slot } = options;
    const issues: DirectorLintIssue[] = [];
    const push = (code: string, severity: LintSeverity, message: string) => issues.push({ shot: 0, code, severity, message });

    issues.push(...lintSections(text, mode === "ref" ? REF_SECTIONS : H3_SECTIONS));
    issues.push(...lintTimeline(text, options));

    // 对齐指令：除文生视频外都必须是第一行，且已经替换掉占位符。
    const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
    const hasAlignment = /^(For the target video|How the reference pictures align)/i.test(firstLine);
    if (mode === "t2v") {
        if (hasAlignment) push("unexpectedAlignment", "warn", "文生视频不需要对齐指令，第一行应直接是 integrated_multimodal_description。");
    } else if (!hasAlignment) {
        push("missingAlignment", "error", `当前模式（${DIRECTOR_MODES.find((item) => item.value === mode)?.h3 ?? mode}）要求第一行是对齐指令。`);
    }

    const wantShot = slot?.index ?? 1;
    if (mode !== "ref" && !new RegExp(`\\[Shot\\s*${wantShot}\\]`).test(text)) push("missingShot", "error", `没有找到 [Shot ${wantShot}] 镜头编号。`);
    issues.push(...lintMusic(text));

    if (mode === "ref") {
        const used = new Set([...text.matchAll(LABEL_PATTERN)].map((matched) => `<${matched[1]} ${matched[2]}>`));
        const summaryAt = text.search(/\bsummary\b/);
        const definedText = text.slice(text.search(/\bsubject_definitions\b/), summaryAt > 0 ? summaryAt : undefined);
        const defined = [...definedText.matchAll(LABEL_PATTERN)].map((matched) => `<${matched[1]} ${matched[2]}>`);

        if (!defined.length) push("noDefinedLabel", "error", "subject_definitions 里没有定义任何引用标签。");
        const unresolved = [...used].filter((label) => !defined.includes(label));
        if (unresolved.length) push("undefinedLabel", "error", `这些引用标签没有在 subject_definitions 里定义：${unresolved.join("、")}。`);

        // 官方要求：每个定义过的标签在 retention_analysis 里恰好保留一条。
        const retentionAt = text.search(/\bretention_analysis\b/);
        const detailedAt = text.search(/\bdetailed_description\b/);
        const retention = retentionAt >= 0 ? text.slice(retentionAt, detailedAt > retentionAt ? detailedAt : undefined) : "";
        for (const label of defined) {
            const occurrences = retention.split(label).length - 1;
            if (occurrences !== 1) push("retentionEntry", "error", `${label} 在 retention_analysis 里应恰好有一条保留说明，现在是 ${occurrences} 条。`);
        }
        if (!used.size) push("noLabel", "warn", "全能参考模式没有使用任何引用标签。");
    }

    return issues;
}

/** 配乐要么写 N/A，要么具体到能被听见。 */
function lintMusic(text: string): DirectorLintIssue[] {
    const matched = /^\s*non_diegetic_music\s*:\s*(.*)$/m.exec(text);
    if (!matched) return [];
    const value = matched[1].trim();
    if (!value || NO_MUSIC.test(value)) return [];
    if (value.split(/\s+/).length < CONCRETE_MUSIC_MIN_WORDS) {
        return [{ shot: 0, code: "vagueMusic", severity: "error", message: "non_diegetic_music 只写了情绪标签，要写清配器、质感、进出点，或者写 N/A。" }];
    }
    return [];
}

function lintSeedance(text: string, duration?: number): DirectorLintIssue[] {
    const issues: DirectorLintIssue[] = [];
    const push = (code: string, severity: LintSeverity, message: string) => issues.push({ shot: 0, code, severity, message });

    if (!/@image\d+/.test(text)) push("missingHandle", "error", "缺少句柄声明（形如 @image1 (名称) — 外观描述）。");
    for (const warning of ["空间布局", "对白规则"]) {
        if (!text.includes(warning)) push("missingWarning", "error", `缺少「⚠️${warning}」这条通用警示。`);
    }

    const declared = /⚠️[^\n]*?只有\s*(\d+)\s*个镜头/.exec(text);
    if (!declared) push("missingCount", "error", "缺少「⚠️本视频严格只有 N 个镜头」这条警示。");

    const shots = text.match(/【镜头\s*\d+】/g) || [];
    if (!shots.length) push("missingShotBlock", "error", "没有找到【镜头1】这样的镜头块。");
    if (declared && shots.length && Number(declared[1]) !== shots.length) {
        push("countMismatch", "error", `警示里写的是 ${declared[1]} 个镜头，实际写了 ${shots.length} 个。`);
    }
    if (shots.length > SEEDANCE_MAX_SHOTS) {
        push("tooManyShots", "warn", `一条 Seedance 提示词里塞了 ${shots.length} 个镜头，官方 15 秒包络建议 2–3 个，超过 5 个会明显过密。`);
    }

    if (!text.includes("风格：")) push("missingStyle", "error", "缺少以「风格：」开头的风格块。");
    if (!text.includes("环境活动：")) push("missingAmbience", "error", "缺少以「环境活动：」开头的环境活动。");
    if (!/\d+\s*秒。\s*\d+\s*:\s*\d+。/.test(text)) push("missingTail", "error", "缺少形如「15秒。21:9。」的收尾行。");
    if (H3_SECTIONS.some((name) => text.includes(name))) push("mixedSyntax", "error", "混用了 H3 的字段语法，Seedance 提示词里不应出现。");
    if (duration && duration > 15) push("overEnvelope", "warn", `Seedance 是 15 秒包络，当前设了 ${duration} 秒，建议拆分而不是拉长单条。`);

    return issues;
}

/** 校验整段输出：先切镜头，再按「它是整片里的第几条」逐条检查，最后按镜头号回填。 */
export function lintDirectorOutput(text: string, options: { mode: DirectorMode; target: DirectorTarget; duration?: number }): DirectorLintReport {
    const shots = splitDirectorShots(text);
    const issues: DirectorLintIssue[] = [];
    // 每条是整片里连续的一段：编号要递增，起点要接在上一条的结束处。
    let cursor = 0;
    shots.forEach((shot, index) => {
        const slot: DirectorShotSlot = { index: index + 1, start: cursor };
        for (const issue of lintDirectorShot(shot, { ...options, slot })) issues.push({ ...issue, shot: index + 1 });
        cursor = shotEnd(shot) ?? cursor;
    });

    const errors = issues.filter((item) => item.severity === "error").length;
    const warnings = issues.filter((item) => item.severity === "warn").length;
    return { shots: shots.length, errors, warnings, issues, ok: errors === 0 };
}
