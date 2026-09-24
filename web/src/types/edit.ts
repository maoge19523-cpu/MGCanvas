/** 剪辑台自己的项目实体：与画布节点、连线、compositeSettings 完全无关，可脱离画布独立使用。 */

/** 素材来源：本地文件导入 / 我的资产 / 画布节点发送。 */
export type EditMediaSource = "local" | "asset" | "canvas";

export type EditMedia = {
    id: string;
    /** 素材显示名，默认取文件名或节点标题。 */
    name: string;
    kind: "video" | "audio";
    source: EditMediaSource;
    /** 桌面绝对路径（画布成片、缓存文件）；有它时导出直接用 FFmpeg 读取。 */
    localPath?: string;
    /** 浏览器存储键（localforage media_files），导出前再落盘到 media-cache。 */
    storageKey?: string;
    /** 可直接播放的地址（asset://、blob:、http）。 */
    url?: string;
    mimeType?: string;
    bytes?: number;
    /** 真实时长，探测不到时为 undefined，此时该素材不能入轨。 */
    durationMs?: number;
    width?: number;
    height?: number;
    createdAt: string;
};

/** 一个片段引用一个素材；片段之间的先后顺序就是本数组的顺序，不依赖任何连线。 */
export type EditClip = {
    id: string;
    mediaId: string;
    /** 入点（秒）。 */
    start: number;
    /** 出点（秒），0 表示到素材末尾。 */
    end: number;
    volume: number;
    fadeIn: number;
    fadeOut: number;
    /** 从本段过渡到下一段：fade / dissolve / wipeleft / wiperight / slideleft / slideup / circleopen，空为硬切。 */
    transition?: string;
    transitionDuration?: number;
    subtitle?: string;
};

/** 片段转场白名单：与 Rust 侧 compose_video 认识的转场一一对应，属性区下拉框也只从这里取。 */
export const EDIT_TRANSITIONS = ["fade", "dissolve", "wipeleft", "wiperight", "slideleft", "slideup", "circleopen"] as const;

/**
 * 归一化片段转场：空串、未知字符串、undefined 一律当成硬切。
 * 空转场名会被 FFmpeg 拼成 `xfade=transition=:...` 而直接拒绝出片，所以无效值绝不往下传。
 */
export function normalizeEditTransition(value?: string): string | undefined {
    return EDIT_TRANSITIONS.find((kind) => kind === value);
}

/**
 * 音频素材不参与画面拼接（compose_video 的片段必须有视频流），统一作为附加音轨混进成片。
 * 与画布合成节点的「配音 / 背景音乐」是同一套 FFmpeg 语义。
 */
export type EditAudioTrack = {
    id: string;
    mediaId: string;
    volume: number;
    fadeIn: number;
    fadeOut: number;
    loop: boolean;
};

export type EditOutput = {
    /** 输出长边像素。 */
    longEdge: number;
    fps: number;
    /** 成片整体淡入淡出（秒）。 */
    fadeIn: number;
    fadeOut: number;
    subtitleStyle: "bottom" | "center";
    subtitleSize: "small" | "medium" | "large";
};

export type EditProject = {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    media: EditMedia[];
    clips: EditClip[];
    audioTracks: EditAudioTrack[];
    output: EditOutput;
};

export const EDIT_DEFAULT_OUTPUT: EditOutput = { longEdge: 1080, fps: 30, fadeIn: 0.5, fadeOut: 0.5, subtitleStyle: "bottom", subtitleSize: "medium" };
