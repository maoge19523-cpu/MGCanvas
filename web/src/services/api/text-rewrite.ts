import { platformFetch } from "@/services/platform/desktop-runtime";
import { buildApiUrl, resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";

/**
 * 画风分类目录：按类别分组，每个选项都带一句「扩写方向」。
 * 目的是给用户足够多的灵感入口，同时显著提升扩写后的提示词质量。
 */
export const TEXT_PROMPT_STYLE_GROUPS: readonly { label: string; options: readonly { label: string; guide: string }[] }[] = [
    {
        label: "写实向",
        options: [
            { label: "通用", guide: "高质量通用风格，主体清晰、整体协调" },
            { label: "写实摄影", guide: "专业单反摄影，真实光影、自然肤色、可见细节纹理" },
            { label: "电影感", guide: "电影剧照质感，宽银幕构图、戏剧化打光、色彩分级" },
            { label: "胶片质感", guide: "35mm 胶片颗粒、轻微褪色、复古色调与暗角" },
            { label: "人像写真", guide: "棚拍或外景人像写真，柔和补光、浅景深、皮肤通透" },
            { label: "纪实抓拍", guide: "纪实摄影抓拍感，自然瞬间、环境真实、不过度修饰" },
            { label: "微距特写", guide: "微距镜头，极浅景深、表面细节与材质纹理极其清晰" },
            { label: "黑白摄影", guide: "黑白影调，强调明暗层次与灰阶过渡" },
        ],
    },
    {
        label: "插画与动画",
        options: [
            { label: "二次元", guide: "日系二次元动画风格，线条干净、上色通透、有动漫分镜感" },
            { label: "厚涂插画", guide: "厚涂数字插画，笔触明确、体积感强、色彩浓郁" },
            { label: "赛璐璐动画", guide: "赛璐璐上色，硬边阴影、平涂色块、动画分镜感" },
            { label: "国漫", guide: "中国漫画风格，线条利落、配色明快、东方审美" },
            { label: "美漫", guide: "美式漫画风格，粗犷墨线、高对比排线、英雄式构图" },
            { label: "水彩", guide: "水彩晕染，湿画法边缘、留白透气、纸纹质感" },
            { label: "油画", guide: "古典油画，可见笔触与厚涂肌理、层次丰富的暗部" },
            { label: "素描线稿", guide: "铅笔素描或钢笔线稿，排线明确、无上色或轻上色" },
            { label: "绘本童趣", guide: "儿童绘本插画，造型圆润、配色温暖、构图简单可爱" },
            { label: "像素风", guide: "像素艺术，有限色板、清晰像素块、复古游戏观感" },
        ],
    },
    {
        label: "三维与数字",
        options: [
            { label: "CG 渲染", guide: "电影级 3D CG 渲染，材质细节丰富、体积光与景深明显" },
            { label: "3D 卡通", guide: "皮克斯式 3D 卡通，圆润造型、次表面散射、明亮打光" },
            { label: "低多边形", guide: "低多边形几何风格，块面分明、配色简洁" },
            { label: "黏土定格", guide: "黏土或橡皮泥定格动画质感，手作痕迹、柔和棚拍光" },
            { label: "盲盒潮玩", guide: "盲盒潮玩手办质感，PVC 光泽、纯色背景、居中展示" },
            { label: "等距立体", guide: "等距视角 3D 场景，干净配色、微缩模型感" },
            { label: "概念艺术", guide: "游戏或影视概念设定图，宏大场景、明确剪影与氛围光" },
        ],
    },
    {
        label: "东方美学",
        options: [
            { label: "古风", guide: "中国古风，配色含蓄、服饰器物考究、意境悠远" },
            { label: "水墨国画", guide: "水墨写意，墨色浓淡、飞白笔触、大量留白" },
            { label: "工笔重彩", guide: "工笔重彩，线条精细、设色浓郁、装饰性强" },
            { label: "敦煌壁画", guide: "敦煌壁画风，土红石青配色、斑驳剥落肌理" },
            { label: "新中式", guide: "新中式审美，留白简约、材质雅致、古典与现代结合" },
            { label: "浮世绘", guide: "日本浮世绘，平涂色块、装饰性线条、波浪云纹" },
        ],
    },
    {
        label: "题材场景",
        options: [
            { label: "风景自然", guide: "自然风景摄影，层次分明、大气透视、光线引导视线" },
            { label: "城市街景", guide: "城市街拍，建筑与人流、招牌霓虹、生活气息" },
            { label: "建筑空间", guide: "建筑摄影，几何线条、结构感强、材质与光影讲究" },
            { label: "美食", guide: "美食摄影，诱人质感、热气与光泽、摆盘精致" },
            { label: "产品静物", guide: "商业产品摄影，干净背景、柔和渐变光、材质高光准确" },
            { label: "动物", guide: "动物摄影，毛发细节清晰、眼神有神、自然环境" },
            { label: "机甲科幻", guide: "机甲或科幻设定，机械结构细节、金属磨损、冷光氛围" },
            { label: "太空星海", guide: "太空与星云场景，宏大尺度、星尘与体积光" },
            { label: "奇幻魔法", guide: "奇幻魔法世界，发光符文、悬浮元素、绚丽能量" },
            { label: "暗黑哥特", guide: "暗黑哥特，阴郁色调、尖顶建筑、烛光与阴影" },
            { label: "末日废土", guide: "末日废土，锈蚀残骸、沙尘弥漫、荒凉低饱和" },
            { label: "赛博朋克", guide: "赛博朋克，霓虹配色、雨夜反光、冷暖撞色、未来都市" },
            { label: "蒸汽朋克", guide: "蒸汽朋克，黄铜齿轮、蒸汽管道、维多利亚质感" },
        ],
    },
    {
        label: "氛围与光影",
        options: [
            { label: "黄金时刻", guide: "日出日落黄金时刻，暖金色侧逆光、长阴影" },
            { label: "霓虹夜景", guide: "霓虹夜景，多彩光源反射、湿地反光、高对比" },
            { label: "逆光剪影", guide: "强逆光剪影，主体轮廓清晰、背景过曝辉光" },
            { label: "柔光清透", guide: "柔光棚拍，低反差、通透干净、浅色背景" },
            { label: "阴郁戏剧", guide: "低调戏剧光，大面积暗部、单侧硬光、氛围压抑" },
            { label: "极简留白", guide: "极简构图，大面积留白、主体突出、色彩克制" },
            { label: "高饱和撞色", guide: "高饱和撞色，强烈色彩对比、视觉冲击力强" },
            { label: "复古怀旧", guide: "怀旧复古色调，略微发黄、低饱和、年代感道具" },
            { label: "梦幻柔焦", guide: "梦幻柔焦，光斑散景、柔光滤镜、朦胧氛围" },
        ],
    },
    {
        label: "视角与构图",
        options: [
            { label: "特写", guide: "特写构图，突出局部细节与情绪" },
            { label: "半身", guide: "半身构图，兼顾人物姿态与表情" },
            { label: "全身", guide: "全身构图，完整展示造型与动作" },
            { label: "俯拍", guide: "俯视角度，强化平面构成与场景关系" },
            { label: "仰拍", guide: "仰视角度，突出主体高大与压迫感" },
            { label: "广角", guide: "广角镜头，夸张透视、收纳更多环境" },
            { label: "长焦压缩", guide: "长焦镜头，空间压缩、背景虚化、主体突出" },
            { label: "航拍", guide: "航拍俯瞰视角，宏大场景、地理纹理清晰" },
        ],
    },
];

export const TEXT_PROMPT_STYLE_OPTIONS = TEXT_PROMPT_STYLE_GROUPS.flatMap((group) => group.options);

export const DEFAULT_TEXT_PROMPT_STYLE = "通用";

/** 画风取值就是选项的 label，保留 string 以便兼容旧数据。 */
export type TextPromptStyle = string;

const SYSTEM_PROMPT = [
    "你是资深的 AI 绘画提示词工程师。",
    "请把用户的一句话想法扩写成可以直接用于文生图模型的提示词。",
    "要求：覆盖主体、外观细节、动作、环境、光线、镜头与画幅、质感与画质关键词；",
    "可以合理补充与风格相符的细节，但不要改变用户想画的主体；",
    "每条提示词控制在 200 字以内，只输出提示词本身，不要任何解释。",
].join("");

/** 输出语言与组数由用户在面板上选择。 */
export type TextRewriteOptions = { count: number; english: boolean };

function guideFor(style: string) {
    return TEXT_PROMPT_STYLE_OPTIONS.find((item) => item.label === style)?.guide || "高质量通用风格，主体清晰、整体协调";
}

/**
 * 把简单想法扩写成专业生图提示词。
 * 直接请求渠道的 OpenAI 兼容接口，并走原生 HTTP 以避开跨域限制。
 */
export async function rewriteImagePrompt(idea: string, style: TextPromptStyle, modelValue: string, options: TextRewriteOptions = { count: 1, english: false }): Promise<string[]> {
    const count = Math.min(Math.max(Math.floor(options.count) || 1, 1), 4);
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
                {
                    role: "user",
                    content: [
                        `目标画风：${style}（${guideFor(style)}）。`,
                        `我的想法：${idea}`,
                        count > 1 ? `请给出 ${count} 条互不相同的提示词，每条单独一行，行首用「1. 」「2. 」这样的编号，不要其它文字。` : "请给出 1 条提示词，直接输出内容，不要编号。",
                        options.english ? "用英文输出。" : "用中文输出。",
                    ].join("\n"),
                },
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
    return splitVariants(content, count);
}

/** 把模型返回拆成若干条提示词：优先按编号行拆，其次按空行，最后按换行。 */
function splitVariants(content: string, count: number): string[] {
    const clean = (value: string) => value.trim().replace(/^\d+[.、)]\s*/, "").replace(/^[-*]\s*/, "").replace(/^["“]|["”]$/g, "").trim();
    const numbered = content
        .split(/\r?\n/)
        .filter((line) => /^\s*\d+[.、)]/.test(line))
        .map(clean)
        .filter(Boolean);
    const parts = numbered.length ? numbered : content.split(/\n\s*\n|\r?\n/).map(clean).filter(Boolean);
    const variants = (parts.length ? parts : [clean(content)]).filter(Boolean);
    if (!variants.length) throw new Error("模型没有返回可用的提示词。");
    return variants.slice(0, count);
}

function readMessageContent(payload: unknown) {
    if (typeof payload !== "object" || !payload) return "";
    const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
    const content = choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
}
