import assert from "node:assert/strict";
import test from "node:test";

import { MAX_SKILL_DIRECTORY_CHARS, MAX_SKILL_INSTRUCTIONS_CHARS, apiSystemPrompt, skillDirectoryPrompt } from "./api-agent.js";

type Skill = { name: string; description: string };

/**
 * 本机实测的 50 个 Skill 名（取自真实 Codex skills/list，含它自己返回的同名重复项 preset-square）。
 * 用途统一用一条长中文描述代替，正好覆盖「描述被截断」这条路径。
 */
const REAL_NAMES = [
    "screenplay-writer", "3d-animation-short-generator", "ask-matt", "brand-promo-video-generator", "co-op-game-intro-generator",
    "code-review", "codebase-design", "computer-use:computer-use", "diagnosing-bugs", "documents:documents",
    "domain-modeling", "find-skills", "grill-with-docs", "h3-prompt-writing", "h3-shortfilm-scriptwriter",
    "handdrawn-live-video-generator", "implement", "improve-codebase-architecture", "minimalist-product-ad-generator", "music-video-subtitle-generator",
    "paper-collage-explainer-generator", "papercraft-stop-motion-explainer", "pdf:pdf", "presentations:Presentations", "preset-square",
    "prototype", "reference-first-motion-director", "research", "resolving-merge-conflicts", "setup-matt-pocock-skills",
    "shotlist-builder", "spreadsheets:Spreadsheets", "spreadsheets:excel-live-control", "tdd", "template-creator:template-creator",
    "to-spec", "to-tickets", "triage", "universal-image-prompt-generator", "universal-short-drama-screenwriter",
    "visualize:visualize", "wayfinder", "wizard", "imagegen", "openai-docs",
    "plugin-creator", "review-agent", "skill-creator", "skill-installer", "preset-square",
];

const LONG_DESCRIPTION = "这是一个用于生成长篇影像作品的技能：先确认题材与时长，再规划分镜与提示词，最后逐场生成并合成，必要时还会检查音画对齐与内容合规风险，避免把多个镜头的提示词接到同一个生成节点上。";

function sample(names: string[], description = LONG_DESCRIPTION): Skill[] {
    return names.map((name) => ({ name, description }));
}

/** 目录里「另有 N 个未列出」声明的数量；没有这句时返回 0。 */
function unlistedCount(text: string) {
    const match = text.match(/另有 (\d+) 个 Skill 未列出/);
    return match ? Number(match[1]) : 0;
}

/** 目录里被列出的 Skill 名（去掉表头、说明行与收尾提示）。 */
function listedNames(text: string) {
    return text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).split("：")[0]);
}

/** 公共断言：不超上限，且没有任何一个 Skill「存在却完全没被提及」。 */
function assertDirectoryContract(text: string, skills: Skill[]) {
    assert.ok(text.length <= MAX_SKILL_DIRECTORY_CHARS, `目录 ${text.length} 字超过上限 ${MAX_SKILL_DIRECTORY_CHARS}`);
    const names = [...new Set(skills.map((skill) => skill.name.trim()).filter(Boolean))];
    const missing = names.filter((name) => !text.includes(name));
    assert.equal(unlistedCount(text), missing.length, `未被列出的 ${missing.length} 个 Skill 没有被「另有 N 个未列出」说明`);
    if (missing.length) {
        assert.match(text, /「✨ 选择 Skill」/);
        assert.match(text, /以上不是全部/);
    }
}

test("没有 Skill 时不生成目录文本", () => {
    assert.equal(skillDirectoryPrompt([]), "");
    assert.equal(skillDirectoryPrompt([{ name: "  ", description: "x" }]), "");
});

test("1 个 Skill：列名字加一句话用途，且不超上限", () => {
    const skills = [{ name: "shotlist-builder", description: "从剧本生成可投产的电影分镜清单与自包含 HTML 提示词表，目标格式为 Seedance 2.0 或 MiniMax H3。" }];
    const text = skillDirectoryPrompt(skills);
    assert.match(text, /^- shotlist-builder：从剧本生成可投产的电影分镜清单/m);
    assert.deepEqual(listedNames(text), ["shotlist-builder"]);
    assertDirectoryContract(text, skills);
});

test("50 个 Skill：全部列出、不超上限、不出现「未列出」", () => {
    const skills = sample(REAL_NAMES);
    assert.equal(skills.length, 50);
    const text = skillDirectoryPrompt(skills);
    assertDirectoryContract(text, skills);
    assert.equal(unlistedCount(text), 0);
    for (const name of new Set(REAL_NAMES)) assert.ok(text.includes(`- ${name}`), `Skill ${name} 没有被列出`);
});

test("描述极长：每条用途被压到一句话以内", () => {
    const skills = sample(["h3-prompt-writing", "wizard"], "很长的用途说明".repeat(400));
    const text = skillDirectoryPrompt(skills);
    assertDirectoryContract(text, skills);
    for (const line of text.split("\n").filter((item) => item.startsWith("- "))) {
        const description = line.split("：").slice(1).join("：");
        assert.ok(description.length <= 33, `单条用途未截断：${line}`);
    }
});

test("技能名极长：装不下的部分计入「未列出」，仍不超上限", () => {
    const skills = sample([...Array.from({ length: 30 }, (_, index) => `${"n".repeat(300)}-${index}`), "shotlist-builder"]);
    const text = skillDirectoryPrompt(skills);
    assertDirectoryContract(text, skills);
    assert.ok(unlistedCount(text) > 0, "超长名字应当触发部分列表");
    assert.match(text, /本机已启用 31 个 Skill/);
});

test("全部超出上限：不返回空文本，并且明确说明还有多少没列出", () => {
    const skills = sample(Array.from({ length: 20 }, (_, index) => `${"y".repeat(3000)}-${index}`));
    const text = skillDirectoryPrompt(skills);
    assert.ok(text.length > 0);
    assertDirectoryContract(text, skills);
    assert.equal(unlistedCount(text), 20);
    assert.match(text, /本机已启用 20 个 Skill/);
});

test("同名重复只列一次，数量按去重后统计", () => {
    const text = skillDirectoryPrompt(sample(["tdd", "tdd", "research"]));
    assert.equal(listedNames(text).length, 2);
    assert.match(text, /本机已启用 2 个 Skill/);
});

test("选中 Skill 时正文照旧注入，顺序仍是 记忆 → 目录 → 正文 → 补充要求", () => {
    const directory = skillDirectoryPrompt(sample(REAL_NAMES));
    const instructions = "先确认题材，再落分镜。".repeat(1000);
    const prompt = apiSystemPrompt({ memoryPrefix: "MEMORY-MARKER", skills: { directory, active: { name: "shotlist-builder", instructions } } });
    assert.ok(prompt.includes(instructions.trim()), "选中 Skill 的正文没有被注入");
    const order = ["MEMORY-MARKER", "【可用 Skill】", "【本轮启用 Skill：shotlist-builder】", "补充要求（API 模式）："].map((marker) => prompt.indexOf(marker));
    assert.ok(order.every((index) => index >= 0), `拼装顺序缺少片段：${order.join(",")}`);
    assert.deepEqual(order, [...order].sort((left, right) => left - right), "拼装顺序被改动");
});

test("超长正文仍按原上限截断后注入", () => {
    const instructions = "z".repeat(MAX_SKILL_INSTRUCTIONS_CHARS + 500);
    const prompt = apiSystemPrompt({ skills: { active: { name: "wizard", instructions } } });
    assert.ok(prompt.includes("z".repeat(MAX_SKILL_INSTRUCTIONS_CHARS)));
    assert.ok(!prompt.includes("z".repeat(MAX_SKILL_INSTRUCTIONS_CHARS + 1)));
    assert.match(prompt, /【Skill「wizard」说明过长/);
});

test("没有目录和选中 Skill 时，prompt 只由基础提示与补充要求组成", () => {
    const prompt = apiSystemPrompt({});
    assert.equal(prompt.includes("【可用 Skill】"), false);
    assert.equal(prompt.includes("本轮启用 Skill"), false);
    assert.match(prompt, /补充要求（API 模式）：/);
    assert.ok(prompt.endsWith("胸口能量核心亮起，镜头缓慢环绕」。"), "补充要求应当在最后一段");
});
