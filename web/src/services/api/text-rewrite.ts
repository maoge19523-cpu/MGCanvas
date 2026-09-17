import { platformFetch } from "@/services/platform/desktop-runtime";
import { buildApiUrl, resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";

/** 可选画风分类：决定扩写时套用的风格方向。 */
export const TEXT_PROMPT_STYLES = ["通用", "二次元", "仿真人", "风景图", "CG", "古风", "赛博"] as const;

export type TextPromptStyle = (typeof TEXT_PROMPT_STYLES)[number];

const STYLE_GUIDE: Record<string, string> = {
    通用: "通用高质量写实风格，兼顾主体与氛围",
    二次元: "日系二次元动画风格，线条干净、上色通透、有动漫分镜感",
    仿真人: "超写实人像摄影风格，皮肤质感真实、光影自然、可见毛孔与发丝细节",
    风景图: "风景摄影风格，强调构图、层次、大气透视与自然光线",
    CG: "电影级 3D CG 渲染风格，材质细节丰富、体积光与景深明显",
    古风: "中国古风国画 / 工笔风格，配色含蓄、留白讲究、服饰器物考究",
    赛博: "赛博朋克风格，霓虹配色、雨夜反光、高对比冷暖撞色、未来都市氛围",
};

const SYSTEM_PROMPT = [
    "你是资深的 AI 绘画提示词工程师。",
    "请把用户的一句话想法扩写成一条可以直接用于文生图模型的中文提示词。",
    "要求：覆盖主体、外观细节、动作、环境、光线、镜头与画幅、质感与画质关键词；",
    "只输出提示词本身，不要解释、不要分点、不要加引号或前后缀，控制在 200 字以内。",
].join("");

/**
 * 把简单想法扩写成专业生图提示词。
 * 直接请求渠道的 OpenAI 兼容接口，并走原生 HTTP 以避开跨域限制。
 */
export async function rewriteImagePrompt(idea: string, style: TextPromptStyle, modelValue: string): Promise<string> {
    const requestConfig = resolveModelRequestConfig(useConfigStore.getState().config, modelValue);
    if (!requestConfig.apiKey.trim() || !requestConfig.baseUrl.trim()) throw new Error("该渠道还没有填写接口地址或 API Key。");

    const response = await platformFetch(buildApiUrl(requestConfig.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${requestConfig.apiKey}` },
        body: JSON.stringify({
            model: requestConfig.model,
            stream: false,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: `目标画风：${style}（${STYLE_GUIDE[style] || STYLE_GUIDE.通用}）。\n我的想法：${idea}` },
            ],
        }),
    });

    const text = await response.text();
    let payload: unknown = text;
    try {
        payload = JSON.parse(text);
    } catch {
        // 保持原始文本，下面统一读取错误信息。
    }
    if (!response.ok) {
        const detail = typeof payload === "object" && payload ? JSON.stringify(payload).slice(0, 300) : text.slice(0, 300);
        throw new Error(`扩写失败（HTTP ${response.status}）：${detail}`);
    }
    const content = readMessageContent(payload);
    if (!content) throw new Error(`模型没有返回内容：${text.slice(0, 300)}`);
    return content.trim().replace(/^["“]|["”]$/g, "");
}

function readMessageContent(payload: unknown) {
    if (typeof payload !== "object" || !payload) return "";
    const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
    const content = choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
}
