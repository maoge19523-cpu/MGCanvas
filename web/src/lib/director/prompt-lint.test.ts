import { describe, expect, it } from "vitest";

import { lintDirectorOutput, lintDirectorShot, splitDirectorShots, type DirectorLintIssue } from "./prompt-lint";
import type { DirectorMode, DirectorTarget } from "./specs";

const codes = (issues: DirectorLintIssue[]) => issues.map((item) => item.code);

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
        expect(lint(H3_T2V)).toEqual([]);
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
        expect(lint(H3_I2V, "i2v")).toEqual([]);
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
        expect(lint(H3_REF, "ref")).toEqual([]);
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
        expect(seed(SEEDANCE)).toEqual([]);
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
        const text = `=== 镜头 1 ===\n${H3_T2V}\n=== 镜头 2 ===\n${H3_T2V}`;
        const report = lintDirectorOutput(text, { mode: "t2v", target: "h3", duration: 5 });
        expect(report).toMatchObject({ shots: 2, errors: 0, warnings: 0, ok: true });
    });

    it("空内容报错", () => {
        expect(codes(lintDirectorShot("   ", { mode: "t2v", target: "h3" }))).toContain("empty");
    });

    it("代码块围栏与负面提示词写法都会被抓出来", () => {
        expect(codes(lint("```\n" + H3_T2V + "\n```"))).toContain("fence");
        expect(codes(lint(`${H3_T2V}\nnegative prompt: blurry`))).toContain("negative");
    });
});
