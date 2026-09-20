import { describe, expect, it } from "vitest";

import { lintDirectorOutput, lintDirectorShot, splitDirectorShots, type DirectorLintIssue } from "./prompt-lint";
import type { DirectorMode, DirectorTarget } from "./specs";

const codes = (issues: DirectorLintIssue[]) => issues.map((item) => item.code);

/**
 * 造「整片里的第 index 条」镜头：编号是它在整片里的序号，时间段是它的全局时间段。
 *
 * AI 导演是一条镜头一条提示词，所以第 2 条写的是 [Shot 2] 5.00-10.00，而不是从 0.00 重来。
 */
const shotAt = (index: number, seconds = 5) => {
    const start = ((index - 1) * seconds).toFixed(2);
    const end = (index * seconds).toFixed(2);
    return `integrated_multimodal_description: [Shot ${index}] ${start}-${end} A wide static shot of a rain-soaked rooftop at dusk; a lone figure in a grey coat stands at the ledge and slowly turns toward the camera. slow push-in with small amplitude. Rain hiss and distant traffic.
overall_soundscape: Steady rain on concrete, faint wind, a distant traffic hum.
non_diegetic_music: A single sustained cello note, low and slow.`;
};

const H3_T2V = `integrated_multimodal_description: [Shot 1] 0.00-5.00 A wide static shot of a rain-soaked rooftop at dusk; a lone figure in a grey coat stands at the ledge and slowly turns toward the camera. slow push-in with small amplitude. Rain hiss and distant traffic.
overall_soundscape: Steady rain on concrete, faint wind, a distant traffic hum.
non_diegetic_music: A single sustained cello note, low and slow.`;

const I2V_ALIGNMENT = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";
const H3_I2V = `${I2V_ALIGNMENT}

${H3_T2V}`;

const H3_REF = `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 0.00-second mark of the target video.

subject_definitions
<Subject 1>: a woman in her thirties, shoulder-length black hair, charcoal wool coat.
<Picture 1>: a city street at night, wet asphalt and neon signs.

summary
She walks through the street and stops under a sign.

retention_analysis
Visible Content: <Subject 1> identity and coat must be preserved; <Picture 1> lighting may vary.
Audio: none.

detailed_description
[Shot 1] 0.00-5.00 <Subject 1> walks into frame against <Picture 1>, slow track right with medium amplitude. Footsteps on wet asphalt.

overall_soundscape
Footsteps on wet asphalt, neon buzz.

non_diegetic_music
A sparse synth pulse.`;

const SEEDANCE = `@image1 (林小满) — 身高 168cm，黑色齐肩发，米色风衣，右手拎一只皮包。
@image2 (旧书店) — 狭窄的两层空间，木质书架与暖黄吊灯。

⚠️空间布局：林小满在画面左侧，书店门在右侧。
⚠️对白规则：同一镜头内只允许一人说话。
⚠️本视频严格只有2个镜头。

【镜头1】中景，平视。林小满推门而入，固定机位。暖光。平静。
【镜头2】特写，略俯。她抬头看向书架，缓慢上摇。暖光。期待。

风格：写实电影感，暖色调。

环境活动：门外细雨，行人偶尔走过。

15秒。21:9。`;

const lint = (shot: string, mode: DirectorMode = "t2v", target: DirectorTarget = "h3", duration = 5) => lintDirectorShot(shot, { mode, target, duration });

describe("切分镜头", () => {
    it("按「=== 镜头 N ===」切分", () => {
        const text = `=== 镜头 1 ===\n${H3_T2V}\n=== 镜头 2 ===\n${H3_T2V}`;
        expect(splitDirectorShots(text)).toHaveLength(2);
    });

    it("没有分隔符时整段作为一条", () => {
        expect(splitDirectorShots(H3_T2V)).toEqual([H3_T2V]);
    });

    it("分隔行独立成行时也能删干净", () => {
        const text = `=== 镜头 1 ===\n正文甲\n\n=== 镜头 2 ===\n正文乙\n=== 镜头 2 ===`;
        const shots = splitDirectorShots(text);
        expect(shots).toHaveLength(2);
        expect(shots[0]).not.toContain("镜头 1");
    });
});

describe("H3 基础模式", () => {
    it("完整合规的提示词没有问题", () => {
        expect(codes(lint(H3_T2V))).toEqual([]);
    });

    it("缺字段报错，并指出缺哪一个", () => {
        const issues = lint(H3_T2V.replace(/^non_diegetic_music:.*$/m, ""));
        expect(codes(issues)).toContain("missingSection");
        expect(issues.find((item) => item.code === "missingSection")?.message).toContain("non_diegetic_music");
    });

    it("字段顺序不对报错", () => {
        // 把最后两段对调，顺序就不再符合官方要求。
        const lines = H3_T2V.split("\n");
        const broken = [lines[0], lines[2], lines[1]].join("\n");
        expect(codes(lint(broken))).toContain("sectionOrder");
    });

    it("文生视频不该有对齐指令", () => {
        expect(codes(lint(H3_I2V))).toContain("unexpectedAlignment");
    });

    it("图生视频缺少对齐指令报错，补上就没问题", () => {
        expect(codes(lint(H3_T2V, "i2v"))).toContain("missingAlignment");
        expect(codes(lint(H3_I2V, "i2v"))).toEqual([]);
    });

    it("占位符没替换掉报错", () => {
        const text = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) aligns with the S.SS-second mark.\n\n${H3_T2V}`;
        expect(codes(lint(text, "i2v"))).toContain("placeholder");
    });

    it("时间不够两位小数报错", () => {
        expect(codes(lint(H3_T2V.replace("0.00-5.00", "0-5")))).toContain("missingTime");
    });

    it("镜头时间超过设定时长报错", () => {
        const issues = lint(H3_T2V, "t2v", "h3", 3);
        expect(codes(issues)).toContain("timeOverflow");
        expect(issues.find((item) => item.code === "timeOverflow")?.message).toContain("3");
    });

    it("缺少 [Shot 1] 编号报错", () => {
        expect(codes(lint(H3_T2V.replace("[Shot 1] ", "")))).toContain("missingShot");
    });

    it("内容过短只提醒不报错", () => {
        const issues = lint("integrated_multimodal_description: [Shot 1] 0.00-5.00 很短。");
        expect(codes(issues)).toContain("short");
        expect(issues.every((item) => item.code === "short" || item.severity === "error")).toBe(true);
    });
});

describe("H3 全能参考模式", () => {
    it("六段齐全且标签都定义过就没问题", () => {
        expect(codes(lint(H3_REF, "ref"))).toEqual([]);
    });

    it("用了没定义的标签报错", () => {
        const broken = H3_REF.replace("<Picture 1>: a city street at night, wet asphalt and neon signs.\n", "").replace("against <Picture 1>", "against <Picture 2>");
        const issues = lint(broken, "ref");
        expect(codes(issues)).toContain("undefinedLabel");
        expect(issues.find((item) => item.code === "undefinedLabel")?.message).toContain("<Picture 2>");
    });

    it("缺任一必填段落报错", () => {
        expect(codes(lint(H3_REF.replace("retention_analysis", "retention_summary"), "ref"))).toContain("missingSection");
    });
});

describe("Seedance", () => {
    const seed = (text: string) => lint(text, "t2v", "seedance");

    it("分节齐全、镜头数自洽就没问题", () => {
        expect(codes(seed(SEEDANCE))).toEqual([]);
    });

    it("警示里的镜头数与实际不符报错", () => {
        const issues = seed(SEEDANCE.replace("只有2个镜头", "只有3个镜头"));
        expect(codes(issues)).toContain("countMismatch");
        expect(issues.find((item) => item.code === "countMismatch")?.message).toContain("3");
    });

    it("缺句柄、缺警示、缺风格块、缺收尾行都能查出来", () => {
        expect(codes(seed(SEEDANCE.replace(/^@image\d+.*$/gm, "")))).toContain("missingHandle");
        expect(codes(seed(SEEDANCE.replace("⚠️对白规则：同一镜头内只允许一人说话。", "")))).toContain("missingWarning");
        expect(codes(seed(SEEDANCE.replace("风格：写实电影感，暖色调。", "")))).toContain("missingStyle");
        expect(codes(seed(SEEDANCE.replace("环境活动：门外细雨，行人偶尔走过。", "")))).toContain("missingAmbience");
        expect(codes(seed(SEEDANCE.replace("15秒。21:9。", "结束")))).toContain("missingTail");
    });

    it("混用 H3 字段语法报错", () => {
        expect(codes(seed(`${SEEDANCE}\noverall_soundscape: 雨声`))).toContain("mixedSyntax");
    });
});

describe("整段校验", () => {
    it("多条分开校验，并按镜头号回填", () => {
        const text = `=== 镜头 1 ===\n${H3_T2V}\n=== 镜头 2 ===\n${H3_T2V.replace(/^non_diegetic_music:.*$/m, "")}`;
        const report = lintDirectorOutput(text, { mode: "t2v", target: "h3", duration: 5 });
        expect(report.shots).toBe(2);
        expect(report.ok).toBe(false);
        expect(report.issues.every((item) => item.shot === 2)).toBe(true);
    });

    it("全部合规时 ok 为真", () => {
        const text = `=== 镜头 1 ===\n${shotAt(1)}\n=== 镜头 2 ===\n${shotAt(2)}`;
        const report = lintDirectorOutput(text, { mode: "t2v", target: "h3", duration: 10 });
        expect(report).toMatchObject({ shots: 2, errors: 0, warnings: 0, ok: true });
    });

    // 回归：每条镜头写自己的编号与全局时间段，不能按「每条都从 0.00 起」误报。
    it("多条各写自己的 [Shot N] 与全局时间段时不误报", () => {
        const text = `=== 镜头 1 ===\n${shotAt(1)}\n=== 镜头 2 ===\n${shotAt(2)}\n=== 镜头 3 ===\n${shotAt(3)}`;
        expect(codes(lintDirectorOutput(text, { mode: "t2v", target: "h3", duration: 15 }).issues)).toEqual([]);
    });

    it("编号对不上整片位置时报错，且只报在那一条上", () => {
        const text = `=== 镜头 1 ===\n${shotAt(1)}\n=== 镜头 2 ===\n${shotAt(2).replace("[Shot 2]", "[Shot 1]")}`;
        const report = lintDirectorOutput(text, { mode: "t2v", target: "h3", duration: 10 });
        expect(codes(report.issues)).toContain("shotNumbering");
        expect(report.issues.every((item) => item.shot === 2)).toBe(true);
    });

    it("起点接不上上一条时报错", () => {
        const text = `=== 镜头 1 ===\n${shotAt(1)}\n=== 镜头 2 ===\n${shotAt(2).replace("5.00-10.00", "7.00-12.00")}`;
        expect(codes(lintDirectorOutput(text, { mode: "t2v", target: "h3", duration: 15 }).issues)).toContain("timeStart");
    });

    it("字速按这一条自己的时长算，而不是按整片总时长", () => {
        // 5 秒的镜头里放 20 字正好 4 字/秒；若错用整片 15 秒会算成 1.3 字/秒而误报「太慢」。
        const line = "她低声说：" + "字".repeat(20);
        const text = `=== 镜头 1 ===\n${shotAt(1)}\n${line}\n=== 镜头 2 ===\n${shotAt(2)}\n${line}`;
        expect(codes(lintDirectorOutput(text, { mode: "t2v", target: "h3", duration: 10 }).issues)).not.toContain("speechSlow");
        expect(codes(lintDirectorOutput(text, { mode: "t2v", target: "h3", duration: 10 }).issues)).not.toContain("speechTooFast");
    });

    it("空内容报错", () => {
        expect(codes(lintDirectorShot("   ", { mode: "t2v", target: "h3" }))).toContain("empty");
    });

    it("代码块围栏与负面提示词写法都会被抓出来", () => {
        expect(codes(lint("```\n" + H3_T2V + "\n```"))).toContain("fence");
        expect(codes(lint(`${H3_T2V}\nnegative prompt: blurry`))).toContain("negative");
    });
});

describe("字段与时间轴（移植自官方校验脚本）", () => {
    it("字段重复出现报错", () => {
        expect(codes(lint(`${H3_T2V}\noverall_soundscape: 又写了一遍`))).toContain("duplicateSection");
    });

    it("字段写了但没内容报错", () => {
        expect(codes(lint(H3_T2V.replace(/^overall_soundscape:.*$/m, "overall_soundscape:")))).toContain("emptySection");
    });

    it("字段名只在正文里被提到时不算字段", () => {
        expect(codes(lint(`${H3_T2V}\n这里顺口提到 overall_soundscape 这个词。`))).toEqual([]);
    });

    // 回归：中文配乐没有空格，不能按空格数词判成「只写了情绪标签」。
    it("中文配乐写清了配器与质感就不算笼统", () => {
        const text = H3_T2V.replace(/^non_diegetic_music:.*$/m, "non_diegetic_music: 轻快活泼的旋律，带有欢快的节奏感");
        expect(codes(lint(text))).not.toContain("vagueMusic");
    });

    it("中文只写情绪标签仍算笼统", () => {
        const text = H3_T2V.replace(/^non_diegetic_music:.*$/m, "non_diegetic_music: 欢快的音乐");
        expect(codes(lint(text))).toContain("vagueMusic");
    });

    // 回归：模型常省掉描述段的字段名，内容其实是明确的，只提醒不报错。
    it("省掉描述段字段名只算警告，不再算错误", () => {
        const text = H3_T2V.replace("integrated_multimodal_description: ", "");
        const issues = lint(text);
        const missing = issues.find((item) => item.code === "missingSection");
        expect(missing?.severity).toBe("warn");
        expect(issues.some((item) => item.severity === "error")).toBe(false);
    });

    it("缺声音段的字段名仍然是错误", () => {
        const text = H3_T2V.replace(/^overall_soundscape:.*\n/m, "");
        const missing = lint(text).find((item) => item.code === "missingSection");
        expect(missing?.severity).toBe("error");
    });

    // 回归：模型常把三个字段连着写在同一行，内容是对的，不能报「缺少字段」。
    it("三个字段连着写在同一行不算缺字段", () => {
        const oneLine = `integrated_multimodal_description: [Shot 1] 0.00-5.00 Wide shot, rule of thirds. A young girl in a flowing white summer dress walks barefoot slowly along a sandy beach at dusk. Slow tracking shot with medium amplitude. overall_soundscape: Gentle ocean waves breaking on the shore, distant seagulls. non_diegetic_music: Calm and soothing acoustic guitar melody.`;
        expect(codes(lint(oneLine))).toEqual([]);
    });

    it("镜头编号跳号报错", () => {
        const text = H3_T2V.replace("[Shot 1]", "[Shot 1]\n[Shot 3] 0.00-5.00 又一段");
        expect(codes(lint(text))).toContain("shotNumbering");
    });

    it("第一段不是从 0.00 秒开始报错", () => {
        expect(codes(lint(H3_T2V.replace("0.00-5.00", "1.00-5.00")))).toContain("timeStart");
    });

    it("镜头时间不首尾相接报错", () => {
        const text = H3_T2V.replace("0.00-5.00", "0.00-2.00 第一段\n[Shot 2] 3.00-5.00 第二段");
        expect(codes(lint(text))).toContain("timeGap");
    });

    it("结束时间不晚于开始时间报错", () => {
        expect(codes(lint(H3_T2V.replace("0.00-5.00", "5.00-5.00")))).toContain("timeReverse");
    });

    it("竖线像是在贴表格", () => {
        expect(codes(lint(`${H3_T2V}\n| 镜头 | 内容 |`))).toContain("tablePipe");
    });
});

describe("配乐与引用闭环", () => {
    it("配乐只写情绪标签报错", () => {
        expect(codes(lint(H3_T2V.replace(/^non_diegetic_music:.*$/m, "non_diegetic_music: Tense.")))).toContain("vagueMusic");
    });

    it("写 N/A 或 无配乐 都算合规", () => {
        expect(codes(lint(H3_T2V.replace(/^non_diegetic_music:.*$/m, "non_diegetic_music: N/A")))).toEqual([]);
        expect(codes(lint(H3_T2V.replace(/^non_diegetic_music:.*$/m, "non_diegetic_music: 无配乐。")))).toEqual([]);
    });

    it("subject_definitions 一个标签都没定义报错", () => {
        const broken = H3_REF.replace(/^<Subject 1>:.*$/m, "").replace(/^<Picture 1>:.*$/m, "");
        expect(codes(lint(broken, "ref"))).toContain("noDefinedLabel");
    });

    it("定义过的标签在 retention_analysis 里必须恰好一条", () => {
        const broken = H3_REF.replace("Visible Content: <Subject 1> identity", "Visible Content:");
        expect(codes(lint(broken, "ref"))).toContain("retentionEntry");
    });
});

describe("作者模板泄漏", () => {
    it("认出「承接上一段 / 自行选择机位」这类写作说明", () => {
        expect(codes(lint(`${H3_T2V}\n承接上一段的机位。`))).toContain("authoringLeak");
        expect(codes(lint(`${H3_T2V}\nChoose a framing when the information lands.`))).toContain("authoringLeak");
    });

    it("正常的镜头内容不会被误判", () => {
        expect(codes(lint(H3_T2V))).toEqual([]);
    });
});

describe("密度规范", () => {
    /** 造一条带中文台词的镜头：台词字数与时长可控。 */
    const withDialogue = (characters: number, seconds: number) =>
        `integrated_multimodal_description: [Shot 1] 0.00-${seconds.toFixed(2)} A medium shot of a woman by the window; she whispers: ${"字".repeat(characters)} The camera stays still.
overall_soundscape: Rain against the glass, a clock ticking somewhere behind her.
non_diegetic_music: A single sustained cello note, low and slow.`;

    it("对白超过 4.5 字/秒报错，并给出实际字速", () => {
        const issues = lint(withDialogue(40, 5), "t2v", "h3", 5);
        expect(codes(issues)).toContain("speechTooFast");
        expect(issues.find((item) => item.code === "speechTooFast")?.message).toContain("8.0 字/秒");
    });

    it("对白在 4.0–4.5 字/秒之间是合规的", () => {
        expect(codes(lint(withDialogue(20, 5), "t2v", "h3", 5))).not.toContain("speechTooFast");
    });

    it("对白太慢只提醒是慢速节奏", () => {
        expect(codes(lint(withDialogue(6, 5), "t2v", "h3", 5))).toContain("speechSlow");
    });

    it("对白几乎占满镜头时提醒没有收尾余量", () => {
        // 5 秒镜头塞 22 字：字速刚好卡在上限内，但建立与收尾时间不够。
        expect(codes(lint(withDialogue(22, 5), "t2v", "h3", 5))).toContain("speechNoHeadroom");
    });

    it("引号里的原语言台词也算念白", () => {
        const text = `integrated_multimodal_description: [Shot 1] 0.00-5.00 A close shot; the sign reads 「今日休息」 and she turns away from the door.
overall_soundscape: Rain against the glass, a clock ticking somewhere behind her.
non_diegetic_music: A single sustained cello note, low and slow.`;
        expect(codes(lint(text, "t2v", "h3", 5))).toContain("speechSlow");
    });

    it("没有对白时不做密度核算", () => {
        expect(codes(lint(H3_T2V))).toEqual([]);
    });

    it("Seedance 一条里塞太多镜头会提醒", () => {
        const blocks = Array.from({ length: 6 }, (_, index) => `【镜头${index + 1}】中景。`).join("\n");
        const text = SEEDANCE.replace("【镜头1】中景，平视。林小满推门而入，固定机位。暖光。平静。\n【镜头2】特写，略俯。她抬头看向书架，缓慢上摇。暖光。期待。", blocks).replace("只有2个镜头", "只有6个镜头");
        expect(codes(lint(text, "t2v", "seedance", 15))).toContain("tooManyShots");
    });

    it("Seedance 设定超过 15 秒会提醒是包络超限", () => {
        expect(codes(lint(SEEDANCE, "t2v", "seedance", 20))).toContain("overEnvelope");
    });
});
