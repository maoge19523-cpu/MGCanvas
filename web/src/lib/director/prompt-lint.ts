/**
 * 「AI 导演」提示词规范自检。
 *
 * 校验的是 specs.ts 注入的那些硬性要求：字段名与顺序、对齐指令、两位小数时间、
 * 引用标签是否都定义过、Seedance 的分节与镜头数是否自洽。
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

/** 一条镜头过短时提示可能漏写了构图/动作/运镜/声音，纯提醒不算错。 */
const SHORT_SHOT_CHARS = 120;
/** 时间允许比要求时长多出的秒数，避免 3.001 这类四舍五入被误判。 */
const DURATION_TOLERANCE = 0.05;

const H3_SECTIONS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"] as const;
const REF_SECTIONS = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"] as const;

/** H3 的引用标签：<Subject 1> / <Picture 2> / <Video 1> / <Audio 1>。 */
const LABEL_PATTERN = /<(Subject|Picture|Video|Audio)\s+(\d+)>/g;
/** 两位小数的时间，例如 0.00 / 3.50。 */
const TIME_PATTERN = /\b\d+\.\d{2}\b/g;

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

/** 段落名是否按给定顺序出现，返回第一个不满足的段落名。 */
function firstOutOfOrderSection(text: string, sections: readonly string[]): { missing?: string; outOfOrder?: string } {
    let cursor = -1;
    for (const name of sections) {
        const at = text.search(new RegExp(`\\b${name}\\b`));
        if (at < 0) return { missing: name };
        if (at < cursor) return { outOfOrder: name };
        cursor = at;
    }
    return {};
}

/** 校验单条镜头提示词。 */
export function lintDirectorShot(shot: string, options: { mode: DirectorMode; target: DirectorTarget; duration?: number }): DirectorLintIssue[] {
    const { mode, target, duration } = options;
    const issues: DirectorLintIssue[] = [];
    const push = (code: string, severity: LintSeverity, message: string) => issues.push({ shot: 0, code, severity, message });
    const text = shot.trim();

    if (!text) {
        push("empty", "error", "这一条是空的。");
        return issues;
    }
    if (text.length < SHORT_SHOT_CHARS) {
        push("short", "warn", `内容偏短（${text.length} 字），可能漏写了构图、主体、环境、动作、运镜或声音。`);
    }
    if (text.includes("```")) push("fence", "error", "提示词里出现了代码块围栏，应去掉。");
    if (/(负面提示词|negative\s*prompt)/i.test(text)) push("negative", "warn", "出现了「负面提示词」写法，官方结构不要求它。");
    if (/S\.SS|\[Shot\s*N\]|\bN\b\s*个镜头/.test(text)) push("placeholder", "error", "还留着 S.SS / N 这类占位符，没有替换成实际值。");

    if (target === "seedance") {
        issues.push(...lintSeedance(text));
    } else {
        issues.push(...lintH3(text, mode, duration));
    }
    return issues;
}

function lintH3(text: string, mode: DirectorMode, duration?: number): DirectorLintIssue[] {
    const issues: DirectorLintIssue[] = [];
    const push = (code: string, severity: LintSeverity, message: string) => issues.push({ shot: 0, code, severity, message });

    const sections = mode === "ref" ? REF_SECTIONS : H3_SECTIONS;
    const order = firstOutOfOrderSection(text, sections);
    if (order.missing) push("missingSection", "error", `缺少必需字段 ${order.missing}（字段名要原样保留）。`);
    if (order.outOfOrder) push("sectionOrder", "error", `字段 ${order.outOfOrder} 的顺序不对，必须按官方顺序排列。`);

    // 对齐指令：除文生视频外都必须是第一行，且已经替换掉占位符。
    const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
    const hasAlignment = /^(For the target video|How the reference pictures align)/i.test(firstLine);
    if (mode === "t2v") {
        if (hasAlignment) push("unexpectedAlignment", "warn", "文生视频不需要对齐指令，第一行应直接是 integrated_multimodal_description。");
    } else if (!hasAlignment) {
        push("missingAlignment", "error", `当前模式（${DIRECTOR_MODES.find((item) => item.value === mode)?.h3 ?? mode}）要求第一行是对齐指令。`);
    }

    if (mode !== "ref" && !/\[Shot\s*1\]/.test(text)) push("missingShot", "error", "没有找到 [Shot 1] 镜头编号。");

    const times = (text.match(TIME_PATTERN) || []).map(Number);
    if (times.length < 2) {
        push("missingTime", "error", "没有给出起止时间，或时间不是两位小数（例如 0.00）。");
    } else if (duration && Math.max(...times) > duration + DURATION_TOLERANCE) {
        push("timeOverflow", "error", `镜头时间到了 ${Math.max(...times).toFixed(2)} 秒，超过了设定的 ${duration} 秒。`);
    }

    // 全能参考模式：用到的标签必须都在 subject_definitions 里定义过。
    if (mode === "ref") {
        const used = new Set<string>();
        for (const matched of text.matchAll(LABEL_PATTERN)) used.add(`<${matched[1]} ${matched[2]}>`);
        const definedText = text.slice(text.search(/\bsubject_definitions\b/), text.search(/\bsummary\b/) > 0 ? text.search(/\bsummary\b/) : undefined);
        const undefinedLabels = [...used].filter((label) => !definedText.includes(label));
        if (undefinedLabels.length) push("undefinedLabel", "error", `这些引用标签没有在 subject_definitions 里定义：${undefinedLabels.join("、")}。`);
        if (!used.size) push("noLabel", "warn", "全能参考模式没有使用任何引用标签。");
    }

    return issues;
}

function lintSeedance(text: string): DirectorLintIssue[] {
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

    if (!text.includes("风格：")) push("missingStyle", "error", "缺少以「风格：」开头的风格块。");
    if (!text.includes("环境活动：")) push("missingAmbience", "error", "缺少以「环境活动：」开头的环境活动。");
    if (!/\d+\s*秒。\s*\d+\s*:\s*\d+。/.test(text)) push("missingTail", "error", "缺少形如「15秒。21:9。」的收尾行。");
    if (H3_SECTIONS.some((name) => text.includes(name))) push("mixedSyntax", "error", "混用了 H3 的字段语法，Seedance 提示词里不应出现。");

    return issues;
}

/** 校验整段输出：先切镜头，再逐条检查，最后按镜头号回填。 */
export function lintDirectorOutput(text: string, options: { mode: DirectorMode; target: DirectorTarget; duration?: number }): DirectorLintReport {
    const shots = splitDirectorShots(text);
    const issues: DirectorLintIssue[] = [];
    shots.forEach((shot, index) => {
        for (const issue of lintDirectorShot(shot, options)) issues.push({ ...issue, shot: index + 1 });
    });

    const errors = issues.filter((item) => item.severity === "error").length;
    const warnings = issues.filter((item) => item.severity === "warn").length;
    return { shots: shots.length, errors, warnings, issues, ok: errors === 0 };
}
