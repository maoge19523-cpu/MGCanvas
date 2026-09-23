import { describe, expect, it } from "vitest";

import { applyPromptVariables, extractPromptVariables } from "./prompt-variables";

describe("extractPromptVariables", () => {
    it("按出现顺序提取并去重，忽略空白名字与内层大括号", () => {
        expect(extractPromptVariables("{{角色}}站在{{场景}}，{{ 角色 }}再次出现")).toEqual(["角色", "场景"]);
        expect(extractPromptVariables("{{}}{{}}")).toEqual([]);
        expect(extractPromptVariables("没有变量的普通提示词")).toEqual([]);
    });
});

describe("applyPromptVariables", () => {
    it("同名变量全部替换，未填写的原样保留", () => {
        const template = "{{角色}}在{{场景}}微笑，{{角色}}手里拿着{{道具}}";
        expect(applyPromptVariables(template, { 角色: "少女", 场景: "天台", 道具: "" })).toBe("少女在天台微笑，少女手里拿着{{道具}}");
        expect(applyPromptVariables(template, {})).toBe(template);
    });

    it("不做正则解释，替换值里的 $ 与反斜杠按字面写入", () => {
        expect(applyPromptVariables("价格{{金额}}", { 金额: "$1\\2" })).toBe("价格$1\\2");
    });

    it("用户填写的值不会被当成新变量再次替换", () => {
        expect(applyPromptVariables("{{a}}", { a: "{{b}}", b: "x" })).toBe("{{b}}");
    });
});
