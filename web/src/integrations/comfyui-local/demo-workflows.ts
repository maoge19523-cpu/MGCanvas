/**
 * 内置示例工作流清单。
 *
 * 两个使用场景差异很大，因此示例按环境区分：
 * - `local`：本机部署 ComfyUI 的用户通常熟悉节点与模型，只需要一个「能跑通的」文生图示例即可；
 * - `cloud`：云端用户多为新手，需要按用途分类的丰富示例（生图 / 视频 / 图片编辑等）。
 *
 * 云端示例的 JSON 由运营方在云端平台搭好后导出 API 格式，放进 `public/workflows/cloud/`
 * 并在此登记即可，无需改动其它代码。
 */

export type ComfyDemoScope = "local" | "cloud" | "both";
export type ComfyDemoCategory = "image" | "video" | "edit" | "utility";

export type ComfyDemoWorkflow = {
    /** 稳定标识，用于安装时定位；不要随意改动已发布的 id。 */
    id: string;
    /** 适用环境。 */
    scope: ComfyDemoScope;
    /** 分类，云端示例按此分组展示。 */
    category: ComfyDemoCategory;
    /** 相对 `public/workflows/` 的文件路径。 */
    file: string;
    /** 安装后的工作流名称。 */
    name: string;
    /** 一句话说明，展示在示例列表里。 */
    description: string;
};

/** 内置示例工作流清单。 */
export const COMFY_DEMO_WORKFLOWS: ComfyDemoWorkflow[] = [
    {
        id: "local-text-to-image",
        scope: "local",
        category: "image",
        file: "local/text-to-image.json",
        name: "Z-Image Turbo 文生图",
        description: "Z-Image Turbo 基础文生图，与本地 ComfyUI 默认工作流一致。模型可在参数面板替换。",
    },
    // 云端示例：面向新手，按用途分类。
    {
        id: "cloud-drama-asset",
        scope: "cloud",
        category: "image",
        file: "cloud/drama-asset-generator.json",
        name: "短剧资产生成器",
        description: "生成短剧场景与角色资产，内置画风提示词，可选画面比例。",
    },
    {
        id: "cloud-krea2-character-sheet",
        scope: "cloud",
        category: "edit",
        file: "cloud/krea2-character-sheet.json",
        name: "Krea2 角色三视图",
        description: "上传一张角色图，生成脸部特写＋正面全身＋侧面全身的标准三视图，适合做设定图。",
    },
    {
        id: "cloud-h3-reference-video",
        scope: "cloud",
        category: "video",
        file: "cloud/h3-reference-video.json",
        name: "MiniMax H3 全能参考",
        description: "用最多三张参考图配合提示词生成 1280 分辨率视频，可设置时长，自带音频。",
    },
];

/** 按当前环境筛选可用示例。 */
export function demosForScope(scope: "local" | "cloud") {
    return COMFY_DEMO_WORKFLOWS.filter((item) => item.scope === scope || item.scope === "both");
}

/** 分类的展示顺序与名称。 */
export const DEMO_CATEGORY_ORDER: ComfyDemoCategory[] = ["image", "video", "edit", "utility"];

export const DEMO_CATEGORY_LABELS: Record<ComfyDemoCategory, string> = {
    image: "图像生成",
    video: "视频生成",
    edit: "图片编辑",
    utility: "实用工具",
};

/** 按分类分组，便于云端示例列表展示。 */
export function groupDemosByCategory(items: ComfyDemoWorkflow[]) {
    return DEMO_CATEGORY_ORDER.map((category) => ({
        category,
        label: DEMO_CATEGORY_LABELS[category],
        items: items.filter((item) => item.category === category),
    })).filter((group) => group.items.length > 0);
}

/** 云端环境使用固定标识绑定工作流（与 use-workflow-import 中的 CLOUD_ENVIRONMENT_ID 一致）。 */
const CLOUD_WORKFLOW_ENVIRONMENT_ID = "cloud-remote";

/** 判断工作流是否属于云端环境；本地页与云端页各自只展示自己环境的工作流。 */
export function isCloudWorkflow(definition: { environmentId: string }) {
    return definition.environmentId === CLOUD_WORKFLOW_ENVIRONMENT_ID;
}