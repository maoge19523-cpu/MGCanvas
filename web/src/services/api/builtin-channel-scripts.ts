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
 *
 * 注意：该接口的 parameters.n 上限为 1，传大于 1 会被拒（HTTP 400
 * 「Input should be less than or equal to 1: parameters.n」）。
 * 因此面板上的「生成数量」改为在本地发起多次独立请求后合并结果。
 */
const DASHSCOPE_IMAGE_SCRIPT = [
    'const content = [{ text: prompt }];',
    'for (const dataUrl of images) content.push({ image: dataUrl });',
    '',
    'const RATIO_PIXELS = { "1:1": "1024*1024", "16:9": "1280*720", "9:16": "720*1280", "4:3": "1152*864", "3:4": "864*1152" };',
    'const rawSize = params.size ? String(params.size).trim() : "";',
    'const size = RATIO_PIXELS[rawSize] || (rawSize.includes("x") ? rawSize.replace("x", "*") : rawSize || undefined);',
    'const countRaw = Math.floor(Number(params.count));',
    'const count = Number.isFinite(countRaw) && countRaw > 1 ? Math.min(countRaw, 4) : 1;',
    '',
    'const urls = [];',
    'let lastData;',
    'for (let index = 0; index < count; index += 1) {',
    '  let data;',
    '  try {',
    '    data = await request({',
    '      method: "post",',
    '      url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",',
    '      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },',
    '      data: {',
    '        model,',
    '        input: { messages: [{ role: "user", content }] },',
    '        parameters: { n: 1, watermark: false, prompt_extend: true, ...(size ? { size } : {}) },',
    '      },',
    '    });',
    '  } catch (error) {',
    '    const status = error?.response?.status;',
    '    const body = error?.response?.data;',
    '    throw new Error(`百炼图像接口调用失败${status ? `（HTTP ${status}）` : ""}：` + (body ? JSON.stringify(body).slice(0, 500) : error?.message || String(error)));',
    '  }',
    '  lastData = data;',
    '  const batch = (data.output?.choices?.[0]?.message?.content || [])',
    '    .map((part) => part.image)',
    '    .filter(Boolean);',
    '  urls.push(...batch);',
    '}',
    '',
    'if (!urls.length) throw new Error("百炼返回里没有图片字段，原始响应：" + JSON.stringify(lastData).slice(0, 500));',
    'return urls;',
].join("\n");

/**
 * 阿里云百炼（DashScope）视频生成。
 * 特点是「异步任务」：先创建任务拿 task_id（请求必须带 X-DashScope-Async: enable），
 * 再轮询 /api/v1/tasks/{task_id} 直到 SUCCEEDED，最后取 video_url。
 * 目前按文生视频（t2v）实现；图生视频在百炼是另一套接口，后续可在此扩展。
 */
const DASHSCOPE_VIDEO_SCRIPT = [
    'const RATIO_PIXELS = { "1:1": "960*960", "16:9": "1280*720", "9:16": "720*1280", "4:3": "1088*832", "3:4": "832*1088" };',
    'const rawSize = params.size ? String(params.size).trim() : "";',
    'const size = RATIO_PIXELS[rawSize] || (rawSize.includes("x") ? rawSize.replace("x", "*") : rawSize || "1280*720");',
    'const seconds = Number(params.seconds) > 0 ? Number(params.seconds) : undefined;',
    'const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };',
    '',
    'let submit;',
    'try {',
    '  submit = await request({',
    '    method: "post",',
    '    url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",',
    '    headers: { ...headers, "X-DashScope-Async": "enable" },',
    '    data: {',
    '      model,',
    '      input: { prompt },',
    '      parameters: { size, prompt_extend: true, watermark: false, ...(seconds ? { duration: seconds } : {}) },',
    '    },',
    '  });',
    '} catch (error) {',
    '  const status = error?.response?.status;',
    '  const body = error?.response?.data;',
    '  throw new Error(`百炼视频任务创建失败${status ? `（HTTP ${status}）` : ""}：` + (body ? JSON.stringify(body).slice(0, 500) : error?.message || String(error)));',
    '}',
    '',
    'const taskId = submit?.output?.task_id;',
    'if (!taskId) throw new Error("百炼没有返回 task_id，原始响应：" + JSON.stringify(submit).slice(0, 500));',
    '',
    'const done = await poll(',
    '  () => request({ method: "get", url: `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`, headers }),',
    '  (state) => {',
    '    const status = state?.output?.task_status;',
    '    if (status === "FAILED" || status === "CANCELED") throw new Error(`百炼视频任务未完成（${status}）：` + JSON.stringify(state?.output || {}).slice(0, 400));',
    '    return status === "SUCCEEDED" && state?.output?.video_url ? state.output : null;',
    '  },',
    '  { intervalMs: 5000, timeoutMs: 900000 },',
    ');',
    'return { url: done.video_url };',
].join("\n");

export const BUILTIN_CHANNEL_SCRIPTS: readonly BuiltinChannelScript[] = [
    {
        id: "dashscope-image",
        label: "阿里云百炼 DashScope 图像生成",
        match: /dashscope(-intl|-us)?\.aliyuncs\.com|bailian/i,
        capability: "image",
        script: DASHSCOPE_IMAGE_SCRIPT,
    },
    {
        id: "dashscope-video",
        label: "阿里云百炼 DashScope 视频生成",
        match: /dashscope(-intl|-us)?\.aliyuncs\.com|bailian/i,
        capability: "video",
        script: DASHSCOPE_VIDEO_SCRIPT,
    },
];

/** 按渠道接口地址与能力匹配内置脚本；没有命中时返回空字符串。 */
export function findBuiltinChannelScript(baseUrl: string, capability: BuiltinScriptCapability): string {
    const url = (baseUrl || "").trim();
    if (!url) return "";
    return BUILTIN_CHANNEL_SCRIPTS.find((item) => item.capability === capability && item.match.test(url))?.script || "";
}
