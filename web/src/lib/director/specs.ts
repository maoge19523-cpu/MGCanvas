/**
 * 「AI 导演」提示词规范。
 *
 * 内容提炼自 MiniMax H3 官方提示词指南与 Seedance 2.0 镜头提示词规范，
 * 只保留生成分镜提示词所必需的结构、字段名与硬性约束，控制注入体积。
 */

/** 生成模式：对应 H3 官方四种输入模式。 */
export type DirectorMode = "t2v" | "i2v" | "flf" | "ref";

/** 目标模型：决定输出使用哪一套语法。 */
export type DirectorTarget = "h3" | "seedance";

export const DIRECTOR_MODES: readonly { value: DirectorMode; h3: string; zh: string; en: string; hint: string }[] = [
    { value: "t2v", h3: "T2VA", zh: "文生视频", en: "Text to video", hint: "只用文字描述，不需要首帧" },
    { value: "i2v", h3: "I2VA", zh: "图生视频", en: "Image to video", hint: "以第 1 张参考图为首帧向后发展" },
    { value: "flf", h3: "FL2VA", zh: "首尾帧", en: "First and last frame", hint: "参考图 1 为首帧、图 2 为尾帧，描述中间过程" },
    { value: "ref", h3: "Ref2VA", zh: "全能参考", en: "Full reference", hint: "多主体/多素材自由引用，支持音频参考" },
];

export const DIRECTOR_TARGETS: readonly { value: DirectorTarget; zh: string; hint: string }[] = [
    { value: "h3", zh: "MiniMax H3", hint: "按 H3 官方字段结构输出" },
    { value: "seedance", zh: "Seedance 2.0", hint: "按 Seedance 结构化镜头块输出" },
];

/** 四种模式的对齐指令：H3 要求写在最终提示词第一行，后跟一个空行。 */
const H3_ALIGNMENT: Record<DirectorMode, string> = {
    t2v: "",
    i2v: "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
    flf: "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.",
    ref: "How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.",
};

/** H3 基础模式（T2VA / I2VA / FL2VA / L2VA）的三字段结构。 */
const H3_BASE = `目标格式：MiniMax H3 基础模式，输出两部分。

第一部分是「对齐指令」，必须是最终提示词的第一行，后面空一行；T2VA 没有这一行。
第二部分是三个核心字段，字段名必须原样保留、顺序不可调整：

integrated_multimodal_description: [Shot 1] ...
overall_soundscape: ...
non_diegetic_music: ...

- integrated_multimodal_description：沿时间轴描写画面、动作、镜头、说话人、对白、歌唱与画内声音。
- overall_soundscape：整条视频的环境声、动作音、非语言人声。
- non_diegetic_music：角色听不到、只有观众能听到的配乐。

硬性要求：
1. 镜头用 [Shot 1] [Shot 2] 编号，并给出每镜的起止时间，时间精确到两位小数（0.00–S.SS）。
2. 镜头数量按官方规范由总时长与叙事节奏决定，不固定数量；各镜头时间必须首尾相接并覆盖到总时长。
3. 每个镜头都要写清：构图、主体、环境、动作、运镜、声音，以及引用内容出现的准确时刻。
4. 运镜写成「运动类型 + 幅度 + 速度」，例如 slow push-in with small amplitude。
5. 有角色说话时标明说话人；对白、歌词、画面里可见的文字保留原语言，不要翻译。
6. 只写声音提示中真正会被听到的内容，不要写剧情简介或创作说明。
7. 对白按官方密度写：中文普通对白 4.0–4.5 字/秒（按 4.25 估算），慢速画外音或内心独白 2.5–3.0 字/秒；每个镜头还要留出 0.3–0.5 秒建立画面与 0.3–0.8 秒念白后的收尾，不要把台词塞满整段时长。`;

/** H3 全能参考（Ref2VA）的六段式结构。 */
const H3_REF = `目标格式：MiniMax H3 全能参考模式（Ref2VA），六段式，段落名必须原样保留、顺序不可调整：

subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music

引用标签规则：
1. 可用标签为 <Subject N>、<Picture N>、<Video N>、<Audio N>，N 从 1 开始，同一素材在所有段落里必须用同一个标签。
2. subject_definitions 里为每个标签写一条定义，写清身份、外观、服装、材质等可复现特征；音频标签写清音色、内容与用途。
3. retention_analysis 分两部分：Visible Content 与 Audio，逐条说明每个引用素材的哪些特征必须保留、哪些允许变化。
4. detailed_description 用完整引用标签写镜头，标明每个引用内容出现的准确时刻。
5. overall_soundscape 与 non_diegetic_music 与基础模式含义一致。

硬性要求：
1. 不得出现没有在 subject_definitions 里定义过的标签。
2. 时间精确到两位小数，且与要求的视频时长一致。
3. 对白、歌词、画面文字保留原语言。
4. 只输出这六个段落，不要额外的解释段落。`;

/** Seedance 2.0 的结构化镜头格式。 */
const SEEDANCE = `目标格式：Seedance 2.0，中文提示词。只输出一条完整提示词，它本身就是一次生成、一段视频，按下面的顺序写完，不许跳节、不许换序：

1. 句柄声明（只有给了参考图才写这一节）：每行一个 @image1 @image2 …，格式为「@image1 (名称) — 外观描述」。角色句柄要写身高体型、发型、面部特征、从头到脚的服装与随身道具；场景句柄写空间与视觉锚点。
2. 通用警示：依次写 ⚠️空间布局、⚠️对白规则、⚠️本视频严格只有N个镜头 三条。
3. 镜头块：【镜头1】【镜头2】…，每个镜头块内写景别与角度、主体与动作、运镜、光线、表演与情绪。
4. 风格块：以「风格：」开头。
5. 环境活动：以「环境活动：」开头。
6. 收尾行：形如「15秒。16:9。」，写本次的总时长与实际画幅，放在最末尾。

硬性要求：
1. 整条提示词里不要出现 \`=== 镜头 N ===\` 这类分隔标题，不要写 Markdown 标题，不要用代码块包裹，也不要写创作说明；镜头只靠【镜头N】表达。编号从【镜头1】开始连续递增，中间不许跳号。
2. 文生视频（没有给任何参考图）时完全不写句柄，正文里也不许出现 @image1 这类写法；给了参考图才写第 1 节。参考图的句柄编号在每条提示词内从 1 重新开始。
3. ⚠️警示里写的镜头数必须与实际写出的【镜头N】块数量完全一致；写了几块就写几个。
4. 不要在同一个提示词里混用 H3 的字段语法（integrated_multimodal_description、overall_soundscape、non_diegetic_music 一律不出现）。
5. 对白密度同官方规范：中文普通对白 4.0–4.5 字/秒，慢速画外音 2.5–3.0 字/秒，并留出 0.3–0.5 秒建立与 0.3–0.8 秒收尾的时间。
6. 一条提示词里最多 5 个镜头；15 秒包络建议 2–3 个，写满 6 个以上会明显过密。`;


/** 按模式与目标模型组装系统提示词。 */
export function buildDirectorSystemPrompt(mode: DirectorMode, target: DirectorTarget): string {
    const parts: string[] = [
        "你是资深 AI 短片导演与分镜提示词工程师，负责把用户提供的创意、参考图与音频整理成可直接投产的镜头提示词。",
        "只输出最终提示词本身，不要写解释、不要写创作说明、不要用代码块包裹。",
    ];

    if (target === "h3") {
        parts.push(mode === "ref" ? H3_REF : H3_BASE);
        const alignment = H3_ALIGNMENT[mode];
        const modeInfo = DIRECTOR_MODES.find((item) => item.value === mode);
        parts.push(
            alignment
                ? `当前模式：${modeInfo?.h3}（${modeInfo?.zh}）。最终提示词第一行必须原样使用下面这条对齐指令，把 N 与 S.SS 替换成实际值：\n${alignment}`
                : `当前模式：T2VA（文生视频）。没有对齐指令，直接从 integrated_multimodal_description 开始。`,
        );
    } else {
        parts.push(SEEDANCE);
        parts.push("当前目标：Seedance 2.0。整条输出是一条完整提示词，不要用 === 镜头 N === 分隔；用户上传的参考图按顺序映射为 @image1、@image2 … 并在正文里引用，没有参考图时不要出现任何句柄。");
    }

    return parts.join("\n\n");
}

/** 供面板展示的模式说明。 */
export function directorModeHint(mode: DirectorMode): string {
    return DIRECTOR_MODES.find((item) => item.value === mode)?.hint ?? "";
}
