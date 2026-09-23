import { describe, expect, it } from "vitest";

import { BUILTIN_STYLE_PROMPTS } from "./builtin-prompt-styles";
import { applyPromptVariables, extractPromptVariables } from "@/components/prompts/prompt-variables";

// 变量模板挂在独立标签下，方便用户在风格馆里一眼找到可填空的那几条。
const TEMPLATE_TAG = "可填空模板";

const EXPECTED_VARIABLES: Record<string, string[]> = {
    人像定制: ["主体", "场景", "光线", "镜头"],
    场景定制: ["地点", "时间", "天气", "氛围"],
    产品定制: ["产品", "台面材质", "光位", "画幅"],
    角色特写: ["角色", "表情", "服装", "背景"],
    风格改写: ["原内容", "目标风格", "必须保留的元素"],
};

describe("内置风格馆的变量模板", () => {
    const templates = BUILTIN_STYLE_PROMPTS.filter((item) => item.tags.includes(TEMPLATE_TAG));

    it("5 条模板都在「可填空模板」标签下，变量数量在 2–4 个之间", () => {
        expect(templates.map((item) => item.title).sort()).toEqual(Object.keys(EXPECTED_VARIABLES).sort());
        for (const item of templates) {
            const count = extractPromptVariables(item.prompt).length;
            expect(count).toBeGreaterThanOrEqual(2);
            expect(count).toBeLessThanOrEqual(4);
        }
    });

    it("每条模板都能被提取出预期的变量名，顺序与文案中的出现顺序一致", () => {
        for (const item of templates) {
            expect(extractPromptVariables(item.prompt)).toEqual(EXPECTED_VARIABLES[item.title]);
        }
    });

    it("逐个填值后得到不含 {{}} 的完整文本，不填则原样保留", () => {
        for (const item of templates) {
            const values = Object.fromEntries(extractPromptVariables(item.prompt).map((name, index) => [name, `测试值${index + 1}`]));
            const filled = applyPromptVariables(item.prompt, values);
            expect(filled).not.toContain("{{");
            expect(filled).not.toContain("}}");
            expect(applyPromptVariables(item.prompt, {})).toBe(item.prompt);
        }
    });

    it("带 {{}} 的条目只有这 5 条，原有 94 条风格未被改动", () => {
        expect(
            BUILTIN_STYLE_PROMPTS.filter((item) => item.prompt.includes("{{"))
                .map((item) => item.title)
                .sort(),
        ).toEqual(Object.keys(EXPECTED_VARIABLES).sort());
        expect(BUILTIN_STYLE_PROMPTS.length).toBe(99);
    });
});
