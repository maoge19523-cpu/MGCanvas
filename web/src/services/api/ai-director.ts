import { platformFetch, readDesktopFileBlob } from "@/services/platform/desktop-runtime";
import { buildApiUrl, resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";
import { buildDirectorSystemPrompt, DIRECTOR_MODES, DIRECTOR_TARGETS, type DirectorMode, type DirectorTarget } from "@/lib/director/specs";

/** 参考素材：label 用于在提示词里区分素材，url 存在时会一并送给支持视觉的模型。 */
export type DirectorReference = { id: string; label: string; url?: string };

export type DirectorRequest = {
    /** 创意需求：要拍什么。 */
    brief: string;
    mode: DirectorMode;
    target: DirectorTarget;
    /** 渠道模型值，例如 channelId::modelName。 */
    modelValue: string;
    duration: number;
    aspect: string;
    images: DirectorReference[];
    audios: DirectorReference[];
    /** 阶段回调：读取参考图 / 请求模型 / 退回纯文本，面板据此显示进度。 */
    onStage?: (stage: "images" | "request" | "retry") => void;
};

export type DirectorResult = {
    prompt: string;
    /** 实际随请求发出的参考图数量。 */
    attachedImages: number;
    /** 降级说明：模型不接受图片时，会退回纯文本再试一次。 */
    fallback?: string;
};

/** 送进接口前把长边压到这个尺寸，避免整张大图撑爆请求体。 */
const MAX_IMAGE_SIDE = 1024;

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

/** 把画布里的本地素材地址读成 data URL；远程地址原样返回。 */
async function localFileDataUrl(url: string): Promise<string | null> {
    const matched = /^(?:asset:\/\/localhost|https?:\/\/asset\.localhost)\/(.+)$/i.exec(url);
    if (!matched) return null;
    let path = matched[1];
    try {
        path = decodeURIComponent(path);
    } catch {
        // 地址没编码就直接用原值。
    }
    // Windows 下会带上前导斜杠，例如 /C:/Users/...，读文件前要去掉。
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    try {
        const blob = await readDesktopFileBlob(path);
        if (!blob) return null;
        return await new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
}

/**
 * 转成接口能接受的图片地址。
 * 远程 http(s) 直接用；本地素材先读成 data URL，再缩放到长边 1024 并转 JPEG，
 * 否则模型服务会因为地址不是合法 URL 直接报 400。
 */
async function imagePayload(url?: string): Promise<string | null> {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;

    const source = /^data:/i.test(url) ? url : await localFileDataUrl(url);
    if (!source) return null;

    return await new Promise<string | null>((resolve) => {
        const image = new Image();
        image.onload = () => {
            try {
                const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
                const width = Math.max(1, Math.round(image.naturalWidth * scale));
                const height = Math.max(1, Math.round(image.naturalHeight * scale));
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext("2d");
                if (!context) return resolve(source);
                context.drawImage(image, 0, 0, width, height);
                resolve(canvas.toDataURL("image/jpeg", 0.85));
            } catch {
                resolve(source);
            }
        };
        image.onerror = () => resolve(null);
        image.src = source;
    });
}

/** 模型明确在抱怨图片/地址时，才值得退回纯文本重试一次。 */
function looksLikeImageRejection(text: string) {
    return /url|image|multimodal|InvalidParameter|data:image/i.test(text);
}

/**
 * 生成分镜提示词。
 *
 * 走渠道的 OpenAI 兼容接口与原生的平台 HTTP，避开跨域限制；
 * 规范由 buildDirectorSystemPrompt 按「模式 + 目标模型」注入。
 * 参考图会缩放后以 data URL 下发；模型不接受图片时自动退回纯文本。
 */
export async function generateDirectorPrompt(request: DirectorRequest): Promise<DirectorResult> {
    const requestConfig = resolveModelRequestConfig(useConfigStore.getState().config, request.modelValue);
    if (!requestConfig.apiKey.trim() || !requestConfig.baseUrl.trim()) throw new Error("该渠道还没有填写接口地址或 API Key。");

    const modeInfo = DIRECTOR_MODES.find((item) => item.value === request.mode);
    const targetInfo = DIRECTOR_TARGETS.find((item) => item.value === request.target);
    const lines = [
        `创意需求：${request.brief.trim() || "（未填写，请按参考素材自行设计一个连贯短片）"}`,
        `目标模型：${targetInfo?.zh ?? request.target}；生成模式：${modeInfo?.zh ?? request.mode}（${modeInfo?.h3 ?? ""}）。`,
        `总时长：${request.duration} 秒；画幅：${request.aspect}。`,
    ];

    if (request.images.length) {
        lines.push(`参考图（按顺序，共 ${request.images.length} 张）：`);
        request.images.forEach((item, index) => lines.push(`  图 ${index + 1}：${item.label}`));
    }
    if (request.audios.length) {
        lines.push(`参考音频（按顺序，共 ${request.audios.length} 个）：`);
        request.audios.forEach((item, index) => lines.push(`  音频 ${index + 1}：${item.label}`));
    }
    if (request.images.length || request.audios.length) {
        lines.push("创意需求里形如 @名称 的写法，指的就是上面同名的参考素材，请把它们当成对应素材来引用，不要当成普通文字。");
    }
    lines.push(
        request.target === "seedance"
            ? "整段输出就是一条完整提示词，直接按规范写完六节；不要输出「=== 镜头 N ===」这类分隔行，镜头只用【镜头N】表达。"
            : "请为每个镜头输出一条独立、完整、可单独投产的提示词。",
        "每条都必须自带官方格式要求的全部字段或段落，不要依赖其它条的内容。",
    );
    if (request.target !== "seedance") {
        lines.push("条与条之间用一行「=== 镜头 N ===」分隔（N 从 1 开始），分隔行之外不要写任何解释。");
    }

    const text = lines.join("\n");
    const payloads: string[] = [];
    request.onStage?.("images");
    for (const item of request.images) {
        const payload = await imagePayload(item.url);
        if (payload) payloads.push(payload);
    }

    const send = async (withImages: boolean) => {
        const content = withImages && payloads.length ? [...payloads.map((url) => ({ type: "image_url", image_url: { url } })), { type: "text", text }] : text;
        const response = await platformFetch(buildApiUrl(requestConfig.baseUrl, "/chat/completions"), {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${requestConfig.apiKey}` },
            body: JSON.stringify({
                model: requestConfig.model,
                stream: false,
                messages: [
                    { role: "system", content: buildDirectorSystemPrompt(request.mode, request.target, { duration: request.duration, aspect: request.aspect }) },
                    { role: "user", content },
                ],
            }),
        });
        return { response, body: await response.text() };
    };

    request.onStage?.("request");
    let { response, body } = await send(true);
    let attachedImages = payloads.length;

    if (!response.ok && attachedImages && looksLikeImageRejection(body)) {
        // 图片被拒时退回纯文本再试一次，至少让用户拿到可用的分镜。
        request.onStage?.("retry");
        ({ response, body } = await send(false));
        attachedImages = 0;
    }

    if (!response.ok) throw new Error(`生成失败（HTTP ${response.status}）：${body.slice(0, 400)}`);

    let payload: unknown = body;
    try {
        payload = JSON.parse(body);
    } catch {
        // 保持原始文本，下面统一读取内容。
    }
    const content = readMessageContent(payload);
    if (!content.trim()) throw new Error(`模型没有返回内容：${body.slice(0, 300)}`);

    return {
        prompt: stripFence(content),
        attachedImages,
        fallback: payloads.length && !attachedImages ? "该模型不接受参考图，已改用纯文字描述重新生成。" : undefined,
    };
}
