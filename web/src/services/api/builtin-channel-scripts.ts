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

/**
 * 智谱（BigModel / Z.ai）图像生成。
 * 图片模型（CogView 系列）不在 OpenAI 兼容的 /models 列表里，需要手动填模型名，
 * 且请求体格式与 OpenAI 不同，因此用调用脚本转换。
 */
const ZHIPU_IMAGE_SCRIPT = [
    // 面板传的是具体尺寸（如 720x1280），映射到 CogView 支持的分辨率；匹配不上则不传，交给接口默认值。
    'const SIZE_MAP = { "1024x1024": "1024x1024", "1:1": "1024x1024", "1280x720": "1440x720", "16:9": "1440x720", "720x1280": "720x1440", "9:16": "720x1440", "1152x864": "1152x864", "4:3": "1152x864", "864x1152": "864x1152", "3:4": "864x1152" };',
    'const rawSize = params.size ? String(params.size).trim() : "";',
    'const size = SIZE_MAP[rawSize];',
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
    '      url: "https://open.bigmodel.cn/api/paas/v4/images/generations",',
    '      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },',
    '      data: { model, prompt, watermark_enabled: false, ...(size ? { size } : {}) },',
    '    });',
    '  } catch (error) {',
    '    const status = error?.response?.status;',
    '    const body = error?.response?.data;',
    '    throw new Error(`智谱图像接口调用失败${status ? `（HTTP ${status}）` : ""}：` + (body ? JSON.stringify(body).slice(0, 500) : error?.message || String(error)));',
    '  }',
    '  lastData = data;',
    '  const batch = (data?.data || []).map((item) => item.url).filter(Boolean);',
    '  urls.push(...batch);',
    '}',
    '',
    'if (!urls.length) throw new Error("智谱返回里没有图片字段，原始响应：" + JSON.stringify(lastData).slice(0, 500));',
    'return urls;',
].join("\n");

/**
 * 火山方舟（Volcengine Ark）Seedream 图片生成。
 *
 * 接口是 /images/generations，但字段与 OpenAI 不完全一致：
 * 需要 response_format、watermark，且尺寸用的是 1K / 2K / 4K 档位或显式像素值。
 */
const ARK_IMAGE_SCRIPT = [
    // 方舟的模型 ID 一律小写并用短横线；用户常按控制台展示名填写（含大写与点号），这里自动纠正。
    'const modelId = String(model || "").replace(/\\./g, "-").toLowerCase();',
    // 面板给的是具体像素，方舟接受 1K/2K/4K 档位，这里按像素大小归到最近的档位。
    'const rawSize = params.size ? String(params.size).trim() : "";',
    'const pixels = rawSize.includes("x") ? rawSize.split("x").reduce((a, b) => Math.max(Number(a) || 0, Number(b) || 0), 0) : 0;',
    'const size = pixels >= 3000 ? "4K" : pixels >= 1500 ? "2K" : pixels > 0 ? "1K" : "2K";',
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
    // 用相对路径：方舟接入点分地域（北京 / 上海等），必须跟随渠道里填写的接口地址。
    '      url: "/images/generations",',
    '      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },',
    '      data: { model: modelId, prompt, sequential_image_generation: "disabled", response_format: "url", size, stream: false, watermark: false },',
    '    });',
    '  } catch (error) {',
    '    const status = error?.response?.status;',
    '    const body = error?.response?.data;',
    '    const code = body?.error?.code || "";',
    '    const hints = {',
    '      ModelNotOpen: "该模型尚未开通：请到火山方舟控制台「开通管理」里开通这个模型。",',
    '      "InvalidEndpointOrModel.NotFound": "模型名或接入点不存在：请填写控制台里的准确模型 ID，或 ep- 开头的接入点 ID。",',
    '      AuthenticationError: "API Key 无效：请检查渠道里填写的方舟 API Key。",',
    '    };',
    '    const hint = hints[code] || (status === 401 ? hints.AuthenticationError : "");',
    '    const raw = body ? JSON.stringify(body).slice(0, 400) : error?.message || String(error);',
    '    throw new Error(`火山方舟图像接口调用失败${status ? `（HTTP ${status}）` : ""}：${hint ? hint + " " : ""}原始返回：${raw}`);',
    '  }',
    '  lastData = data;',
    '  const batch = (data?.data || []).map((item) => item.url).filter(Boolean);',
    '  urls.push(...batch);',
    '}',
    '',
    'if (!urls.length) throw new Error("火山方舟返回里没有图片字段，原始响应：" + JSON.stringify(lastData).slice(0, 400));',
    'return urls;',
].join("\n");

/**
 * 火山方舟（Volcengine Ark）Seedance 视频生成。
 *
 * 接口不是 OpenAI 兼容格式：分辨率 / 画幅 / 时长要通过提示词末尾的命令参数传递
 * （形如 `--resolution 1080p --ratio 16:9 --duration 5`），并且是异步任务。
 */
const ARK_VIDEO_SCRIPT = [
    // 方舟的模型 ID 一律小写并用短横线；用户常按控制台展示名填写（含大写与点号），这里自动纠正。
    'const modelId = String(model || "").replace(/\\./g, "-").toLowerCase();',
    'const RESOLUTIONS = { "480P": "480p", "720P": "720p", "1080P": "1080p" };',
    'const RATIOS = { "16:9": "16:9", "9:16": "9:16", "1:1": "1:1", "4:3": "4:3", "3:4": "3:4" };',
    'const resolution = RESOLUTIONS[String(params.resolution || "1080P").trim().toUpperCase()] || "1080p";',
    'const ratio = RATIOS[String(params.size || "16:9").trim()] || "16:9";',
    // Seedance 时长档位为 5 秒或 10 秒，超出范围按最近的档位处理。
    'const secondsRaw = Math.floor(Number(params.seconds));',
    'const duration = Number.isFinite(secondsRaw) && secondsRaw > 7 ? 10 : 5;',
    'const flags = ` --resolution ${resolution} --ratio ${ratio} --duration ${duration} --watermark false`;',
    '',
    'const content = [{ type: "text", text: `${prompt}${flags}` }];',
    'if (images && images[0]) content.push({ type: "image_url", image_url: { url: images[0] } });',
    'const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };',
    // 用相对路径：方舟接入点分地域（北京 / 上海等），必须跟随渠道里填写的接口地址。
    'const base = "/contents/generations/tasks";',
    '',
    'let submit;',
    'try {',
    '  submit = await request({ method: "post", url: base, headers, data: { model: modelId, content } });',
    '} catch (error) {',
    '  const status = error?.response?.status;',
    '  const body = error?.response?.data;',
    '  const code = body?.error?.code || "";',
    // 把方舟的错误码翻成可执行的中文提示，避免用户只看到一段英文原始响应。
    '  const hints = {',
    '    ModelNotOpen: "该模型尚未开通：请到火山方舟控制台「开通管理」里开通这个模型，再重新运行。",',
    '    "InvalidEndpointOrModel.NotFound": "模型名或接入点不存在：请填写控制台里的准确模型 ID，或改用 ep- 开头的推理接入点 ID。",',
    '    "InvalidParameter.RateLimitExceeded": "触发方舟并发或频率限制：稍等一会儿再试，或在控制台提高配额。",',
    '    AuthenticationError: "API Key 无效：请检查渠道里填写的方舟 API Key。",',
    '  };',
    '  const hint = hints[code] || (status === 401 ? hints.AuthenticationError : "");',
    '  const raw = body ? JSON.stringify(body).slice(0, 400) : error?.message || String(error);',
    '  throw new Error(`火山方舟视频任务创建失败${status ? `（HTTP ${status}）` : ""}：${hint ? hint + " " : ""}原始返回：${raw}`);',
    '}',
    '',
    'const taskId = submit?.id;',
    'if (!taskId) throw new Error("火山方舟没有返回任务 id，原始响应：" + JSON.stringify(submit).slice(0, 500));',
    '',
    'const done = await poll(',
    '  () => request({ method: "get", url: `${base}/${taskId}`, headers }),',
    '  (state) => {',
    '    const status = state?.status;',
    '    if (status === "failed" || status === "cancelled") throw new Error(`火山方舟视频任务未完成（${status}）：` + JSON.stringify(state).slice(0, 400));',
    '    const url = state?.content?.video_url;',
    '    return status === "succeeded" && url ? url : null;',
    '  },',
    '  { intervalMs: 5000, timeoutMs: 900000 },',
    ');',
    'return { url: done };',
].join("\n");

/**
 * 智谱（BigModel）视频生成。异步任务：先创建拿 id，再轮询 async-result。
 */
const ZHIPU_VIDEO_SCRIPT = [
    // 智谱视频的 size 是枚举值：按「画幅 + 清晰度」落到接口允许的尺寸。
    'const RATIO_SIZE = { "16:9": { "480P": "1280x720", "720P": "1280x720", "1080P": "1920x1080" }, "9:16": { "480P": "720x1280", "720P": "720x1280", "1080P": "1080x1920" } };',
    'const ratio = params.size ? String(params.size).trim() : "16:9";',
    'const resolution = params.resolution ? String(params.resolution).trim().toUpperCase() : "1080P";',
    'const size = (RATIO_SIZE[ratio] || RATIO_SIZE["16:9"])[resolution] || "1920x1080";',
    // cogvideox 系列只支持 5 秒或 10 秒，其余取值一律按 5 秒处理，避免被接口拒绝。
    'const secondsRaw = Math.floor(Number(params.seconds));',
    'const duration = Number.isFinite(secondsRaw) && secondsRaw >= 10 ? 10 : Number.isFinite(secondsRaw) && secondsRaw > 0 ? 5 : undefined;',
    'const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };',
    '',
    'let submit;',
    'try {',
    '  submit = await request({',
    '    method: "post",',
    '    url: "https://open.bigmodel.cn/api/paas/v4/videos/generations",',
    '    headers,',
    '    data: { model, prompt, ...(images && images[0] ? { image_url: images[0] } : {}), ...(size ? { size } : {}), ...(duration ? { duration } : {}) },',
    '  });',
    '} catch (error) {',
    '  const status = error?.response?.status;',
    '  const body = error?.response?.data;',
    '  throw new Error(`智谱视频任务创建失败${status ? `（HTTP ${status}）` : ""}：` + (body ? JSON.stringify(body).slice(0, 500) : error?.message || String(error)));',
    '}',
    '',
    'const taskId = submit?.id;',
    'if (!taskId) throw new Error("智谱没有返回任务 id，原始响应：" + JSON.stringify(submit).slice(0, 500));',
    '',
    'const done = await poll(',
    '  () => request({ method: "get", url: `https://open.bigmodel.cn/api/paas/v4/async-result/${taskId}`, headers }),',
    '  (state) => {',
    '    const status = state?.task_status;',
    '    if (status === "FAIL") throw new Error("智谱视频任务失败：" + JSON.stringify(state).slice(0, 400));',
    '    const url = state?.video_result?.[0]?.url;',
    '    return status === "SUCCESS" && url ? url : null;',
    '  },',
    '  { intervalMs: 5000, timeoutMs: 900000 },',
    ');',
    'return { url: done };',
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
        id: "zhipu-image",
        label: "智谱 BigModel 图像生成（CogView）",
        match: /bigmodel\.cn|zhipu|z\.ai/i,
        capability: "image",
        script: ZHIPU_IMAGE_SCRIPT,
    },
    {
        id: "ark-image",
        label: "火山方舟 Seedream 图像生成",
        match: /volces\.com|volcengine|ark\.cn/i,
        capability: "image",
        script: ARK_IMAGE_SCRIPT,
    },
    {
        id: "ark-video",
        label: "火山方舟 Seedance 视频生成",
        match: /volces\.com|volcengine|ark\.cn/i,
        capability: "video",
        script: ARK_VIDEO_SCRIPT,
    },
    {
        id: "zhipu-video",
        label: "智谱 BigModel 视频生成（CogVideoX）",
        match: /bigmodel\.cn|zhipu|z\.ai/i,
        capability: "video",
        script: ZHIPU_VIDEO_SCRIPT,
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
