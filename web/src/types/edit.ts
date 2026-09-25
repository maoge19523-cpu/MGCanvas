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
    /**
     * 关闭原声：这一段视频**自带的声音**在成片里不出现（画面照旧），预览里这一段也变静。
     * 视频轨是「一条轨 + 若干片段」的结构，所以这个开关挂在片段自己身上；
     * 轨道头上的「关闭原声」作用于本轨全部片段，一次提交、一条历史。
     * 缺省（undefined）= 保留原声，旧项目读进来语义与改动前完全一致。
     */
    muted?: boolean;
    /**
     * 锁定：这一段的拖动换序、两端裁剪、拆分、删除都会被拒绝。
     * 锁定**只影响编辑**，不参与导出（成片里照样有这一段），缺省（undefined）= 不锁定。
     * 视频轨是「一条轨 + 若干片段」的结构（没有 EditTrack 对象），所以锁挂在片段自己身上。
     */
    locked?: boolean;
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
    /**
     * 静音：这条轨在合成时整条跳过（不交给 FFmpeg），成片里不出声，其它轨不受影响。
     * 缺省（undefined）= 不静音；旧项目读进来就是缺省，语义不变，不需要任何迁移。
     */
    muted?: boolean;
    /**
     * 独奏：只要有**任一**音轨 solo === true，其余未独奏的音轨在导出里一律不出声；
     * 与 muted 叠加时以「被排除」为准（静音的轨即使 solo 也不出声）。
     */
    solo?: boolean;
    /**
     * 这条轨在**时间线上的起点**（秒）：整条素材从这个时刻开始混进成片，之前是静音。
     * 缺省（undefined）= 从 0 秒起混入，与改动前逐字一致（导出侧不出现 adelay，不需要任何迁移）。
     * 上界是成片总时长（见 lib/edit/timeline-edit 的 editTrackStartLimit）：起点落到成片末尾之后
     * 这条轨在成片里一个字都听不到（amix 是 duration=first，以视频为准）。
     */
    start?: number;
    /** 锁定：这条轨的参数编辑与删除被拒绝；不参与导出。缺省 = 不锁定。 */
    locked?: boolean;
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
