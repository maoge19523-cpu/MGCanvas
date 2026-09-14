/**
 * 内置渠道调用脚本。
 *
 * 部分服务商（例如阿里云百炼 DashScope）的接口格式与 OpenAI 规范不同，
 * 必须通过「调用脚本」做一次转换。为了不要求用户手写脚本，这里按渠道接口地址
 * 自动匹配内置实现：
 *   - 用户在模型上自定义了脚本 → 优先使用用户的脚本；
 *   - 没有自定义脚本 → 按 baseUrl 命中内置脚本；
 *   - 都没有命中 → 走默认的协议请求（OpenAI / Gemini / 火山方舟）。
 */

export type BuiltinScriptCapability = "image" | "video" | "audio" | "text";

export type BuiltinChannelScript = {
    id: string;
    /** 展示用名称，方便在日志或未来的设置界面里说明来源 */
    label: string;
    /** 匹配渠道接口地址 */
    match: RegExp;
    capability: BuiltinScriptCapability;
    script: string;
};

/**
 * 阿里云百炼（DashScope）图像生成。
 * 百炼的兼容模式只覆盖对话接口，图像生成必须走原生异步/同步接口，
 * 因此这里直接调用 multimodal-generation 同步接口，并把面板上的尺寸参数带过去。
 * 同一个脚本同时覆盖文生图（images 为空）与图生图（images 有参考图）。
 */
const DASHSCOPE_IMAGE_SCRIPT = [
    'const content = [{ text: prompt }];',
    'for (const dataUrl of images) content.push({ image: dataUrl });',
    '',
    'const RATIO_PIXELS = { "1:1": "1024*1024", "16:9": "1280*720", "9:16": "720*1280", "4:3": "1152*864", "3:4": "864*1152" };',
    'const rawSize = params.size ? String(params.size).trim() : "";',
    'const size = RATIO_PIXELS[rawSize] || (rawSize.includes("x") ? rawSize.replace("x", "*") : rawSize || undefined);',
    'const count = Number(params.count) > 0 ? Number(params.count) : 1;',
    '',
    'let data;',
    'try {',
    '  data = await request({',
    '    method: "post",',
    '    url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",',
    '    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },',
    '    data: {',
    '      model,',
    '      input: { messages: [{ role: "user", content }] },',
    '      parameters: { n: count, watermark: false, prompt_extend: true, ...(size ? { size } : {}) },',
    '    },',
    '  });',
    '} catch (error) {',
    '  const status = error?.response?.status;',
    '  const body = error?.response?.data;',
    '  throw new Error(`百炼图像接口调用失败${status ? `（HTTP ${status}）` : ""}：` + (body ? JSON.stringify(body).slice(0, 500) : error?.message || String(error)));',
    '}',
    '',
    'const urls = (data.output?.choices?.[0]?.message?.content || [])',
    '  .map((part) => part.image)',
    '  .filter(Boolean);',
    'if (!urls.length) throw new Error("百炼返回里没有图片字段，原始响应：" + JSON.stringify(data).slice(0, 500));',
    'return urls;',
].join("\n");

export const BUILTIN_CHANNEL_SCRIPTS: readonly BuiltinChannelScript[] = [
    {
        id: "dashscope-image",
        label: "阿里云百炼 DashScope 图像生成",
        match: /dashscope(-intl|-us)?\.aliyuncs\.com|bailian/i,
        capability: "image",
        script: DASHSCOPE_IMAGE_SCRIPT,
    },
];

/** 按渠道接口地址与能力匹配内置脚本；没有命中时返回空字符串。 */
export function findBuiltinChannelScript(baseUrl: string, capability: BuiltinScriptCapability): string {
    const url = (baseUrl || "").trim();
    if (!url) return "";
    return BUILTIN_CHANNEL_SCRIPTS.find((item) => item.capability === capability && item.match.test(url))?.script || "";
}
