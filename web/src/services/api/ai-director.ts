import { platformFetch } from "@/services/platform/desktop-runtime";
import { buildApiUrl, resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";
import { buildDirectorSystemPrompt, DIRECTOR_MODES, DIRECTOR_TARGETS, type DirectorMode, type DirectorTarget } from "@/lib/director/specs";

/** 参考素材：label 用于在提示词里区分素材，url 存在时会一并送给支持视觉的模型。 */
export type DirectorReference = { label: string; url?: string };

export type DirectorRequest = {
    /** 创意需求：要拍什么。 */
    brief: string;
    mode: DirectorMode;
    target: DirectorTarget;
    /** 渠道模型值，例如 channelId::modelName。 */
    modelValue: string;
    shots: number;
    duration: number;
    aspect: string;
    images: DirectorReference[];
    audios: DirectorReference[];
};

function readMessageContent(payload: unknown): string {
    const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
    const content = choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
            .join("");
    }
    return "";
}

/** 去掉模型可能套上的代码块围栏，保留纯提示词。 */
function stripFence(text: string): string {
    const trimmed = text.trim();
    const matched = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
    return (matched ? matched[1] : trimmed).trim();
}

/**
 * 生成分镜提示词。
 *
 * 走渠道的 OpenAI 兼容接口与原生的平台 HTTP，避开跨域限制；
 * 规范由 buildDirectorSystemPrompt 按「模式 + 目标模型」注入。
 */
export async function generateDirectorPrompt(request: DirectorRequest): Promise<string> {
    const requestConfig = resolveModelRequestConfig(useConfigStore.getState().config, request.modelValue);
    if (!requestConfig.apiKey.trim() || !requestConfig.baseUrl.trim()) throw new Error("该渠道还没有填写接口地址或 API Key。");

    const modeInfo = DIRECTOR_MODES.find((item) => item.value === request.mode);
    const targetInfo = DIRECTOR_TARGETS.find((item) => item.value === request.target);
    const lines = [
        `创意需求：${request.brief.trim() || "（未填写，请按参考素材自行设计一个连贯短片）"}`,
        `目标模型：${targetInfo?.zh ?? request.target}；生成模式：${modeInfo?.zh ?? request.mode}（${modeInfo?.h3 ?? ""}）。`,
        `镜头数量：${request.shots} 个；总时长：${request.duration} 秒；画幅：${request.aspect}。`,
    ];

    if (request.images.length) {
        lines.push(`参考图（按顺序，共 ${request.images.length} 张）：`);
        request.images.forEach((item, index) => lines.push(`  图 ${index + 1}：${item.label}`));
    }
    if (request.audios.length) {
        lines.push(`参考音频（按顺序，共 ${request.audios.length} 个）：`);
        request.audios.forEach((item, index) => lines.push(`  音频 ${index + 1}：${item.label}`));
    }
    lines.push(
        `请为每个镜头输出一条独立、完整、可单独投产的提示词，共 ${request.shots} 条。`,
        "每条都必须自带官方格式要求的全部字段或段落，不要依赖其它条的内容；",
        "条与条之间用一行「=== 镜头 N ===」分隔（N 从 1 开始），分隔行之外不要写任何解释。",
    );

    // 有图片地址时按多模态下发，让支持视觉的模型能直接读到画面细节。
    const imageParts = request.images
        .filter((item) => item.url)
        .map((item) => ({ type: "image_url", image_url: { url: item.url } }));
    const userContent = imageParts.length ? [...imageParts, { type: "text", text: lines.join("\n") }] : lines.join("\n");

    const response = await platformFetch(buildApiUrl(requestConfig.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${requestConfig.apiKey}` },
        body: JSON.stringify({
            model: requestConfig.model,
            stream: false,
            messages: [
                { role: "system", content: buildDirectorSystemPrompt(request.mode, request.target) },
                { role: "user", content: userContent },
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
        const detail = typeof payload === "object" && payload ? JSON.stringify(payload).slice(0, 400) : text.slice(0, 400);
        throw new Error(`生成失败（HTTP ${response.status}）：${detail}`);
    }
    const content = readMessageContent(payload);
    if (!content.trim()) throw new Error(`模型没有返回内容：${text.slice(0, 300)}`);
    return stripFence(content);
}
