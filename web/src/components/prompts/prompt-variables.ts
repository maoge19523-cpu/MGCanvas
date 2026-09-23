// 提示词模板变量：只认一层 {{名字}}，不写复杂解析器。
const PROMPT_VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

// 按出现顺序提取变量名并去重。
export function extractPromptVariables(template: string) {
    const names: string[] = [];
    for (const match of template.matchAll(PROMPT_VARIABLE_PATTERN)) {
        const name = match[1].trim();
        if (name && !names.includes(name)) names.push(name);
    }
    return names;
}

// 字面替换：按占位符原文 split/join（同名变量全部替换），
// 未填写或只填空白的变量原样保留，用户输入里的 {{...}} 不会被二次替换。
export function applyPromptVariables(template: string, values: Record<string, string>) {
    let result = template;
    for (const match of template.matchAll(PROMPT_VARIABLE_PATTERN)) {
        const value = (values[match[1].trim()] || "").trim();
        if (!value) continue;
        result = result.split(match[0]).join(value);
    }
    return result;
}
