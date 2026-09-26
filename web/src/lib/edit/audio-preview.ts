import { EDIT_FADE_IN_MAX, EDIT_FADE_OUT_MAX, EDIT_VOLUME_MAX } from "./audio-gain";
import { resolveAudibleTracks } from "./audio-mix";
import { editAudioTrimWindow } from "./audio-trim";
import type { EditAudioTrack, EditMedia } from "@/types/edit";

/**
 * 预览混音的**纯计算部分**：一条音轨在某个成片时刻该处于素材内的哪个位置、以多大增益出声。
 * 全部不碰 DOM，便于单测；真正的播放（<audio> 的 currentTime / volume / play / pause）在
 * pages/editor/components/edit-stage.tsx 的播放心跳里。
 *
 * 口径来源是**导出侧** web/src-tauri/src/ffmpeg_compose.rs 的 track_chain，逐项对应：
 * `[i:a]atrim=start=入点[:end=出点],asetpts[,aloop=loop=-1:size=N],aformat=…,volume=V,
 *  atrim=end=total,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=fi,afade=t=out:st=(内容长度 − fo):d=fo,adelay=start`
 * （裁剪那两步**只在真的裁过时**才出现，`aloop` 只在「裁过 + 循环」时才出现）
 * - `V` 夹进 [0,4]、`fi` 夹进 [0,5]、`fo` 夹进 [0,10]（与属性区、与 lib/edit/audio-gain 的取值域同一口径）；
 * - `afade=t=in` 的 `st=0` 是**延迟之前的本地时间轴**，配上 `adelay=start` 就是「淡入自音轨起点起算」；
 * - `afade=t=out` 的 `st=内容长度 − fadeOut` 换算到成片时间轴就是 `start + 内容长度 − fadeOut`，
 *   其中内容长度是**裁剪后**这一段（起点之后剩下的时长也一并夹进去），也就是淡出收在这条轨
 *   真正有声音的内容末尾——音轨比成片短、或两头被裁短时，它都不是成片末尾
 *   （可视化里的 fadeOutAnchor 会标出这处差异）；
 * - `内容长度 − fadeOut` 为负时导出取 0，绝对位置退化成 `start`，这里逐字照搬 `Math.max(0, …)`；
 * - 裁剪后的 `atrim` + amix 的 `duration=first`：留下的那一段放完就没有了（循环轨由 `aloop` 续上），
 *   所以本地时间超过裁剪后的内容长度之后一律不出声（预览同样按它截断）。
 *
 * 「哪条轨真的出声」**不在这里判**：本模块只读 lib/edit/audio-mix 的 resolveAudibleTracks
 * （导出请求构造与轨道头显示读的也是它），不另造第二套静音 / 独奏规则。
 */

/** 一条音轨在预览里的静态几何：夹取后的参数 + 起点之后还剩多少成片时长。 */
export type EditAudioPreviewTrack = {
    id: string;
    mediaId: string;
    name: string;
    /** 可播放地址（与片段预览同一来源，见 editAudioPreviewPlan）。 */
    src: string;
    /** 音量，夹进 [0,4]（导出 volume 同口径）。 */
    volume: number;
    /** 淡入 / 淡出秒数，夹进 [0,5] / [0,10]（导出两条 afade 同口径）。 */
    fadeIn: number;
    fadeOut: number;
    /** 起点（成片时间轴绝对秒），夹进 [0, 成片总长]（导出 adelay 同口径）。 */
    start: number;
    /** 起点之后剩下的成片时长（导出里的 span）。 */
    span: number;
    loop: boolean;
    /** 素材自身时长（秒），0 = 没探测到。 */
    sourceSeconds: number;
    /** 素材内的入点（秒，缺省 0）；裁剪后这条轨从素材的更后面开始取。 */
    sourceStart: number;
    /** 素材内的出点（秒，0 / 缺省 = 到素材末尾，与 EditClip.end 同一口径）。 */
    sourceEnd: number;
};

/**
 * 一条音轨「素材还在、也没被静音，却拿不到可播放地址」的缺口。
 * 这类轨过去是**静默跳过**的：没有元素、没有提示，用户看到的正是「按了播放却没声音、界面上一个字都没有」。
 * 两种缺口必须分开，否则要么刷屏、要么漏报：
 * - `pending`：地址还在解析（`useEditMediaUrls` 那一轮异步解析，通常一瞬间）——静默跳过，不打扰用户；
 * - `missing`：**已经能确定**拿不到地址（素材上既没有地址也没有存储键，或者解析完就是一个空串）——
 *   预览里真的听不到它，必须让界面说得出来。
 */
export type EditAudioPreviewGap = {
    name: string;
    reason: "pending" | "missing";
};

export type EditAudioPreviewPlan = {
    /** 会在预览里出声的音轨（已按可听性过滤，且有可播放地址）。 */
    tracks: EditAudioPreviewTrack[];
    /** 素材已被移除 / 不是音频：预览里听不到它，调用方据此给出可理解的提示。 */
    unavailable: string[];
    /** 有素材、可听、但没有可播放地址：调用方只对 `missing` 那一类给出提示。 */
    gaps: EditAudioPreviewGap[];
};

/**
 * 音轨的漂移容差（帧）：比视频松。
 * 几十毫秒的音画偏差听不出来，而每纠正一次都要重新解码、可能带出一声咔哒；
 * 判定仍然走**同一个** editDriftAction，只是把它的 tolerance 调大（不是另起一套判定）。
 */
export const EDIT_AUDIO_DRIFT_TOLERANCE = 3;

function clamp(value: number, minimum: number, maximum: number) {
    if (!Number.isFinite(value)) return minimum;
    return Math.min(maximum, Math.max(minimum, value));
}

/**
 * 预览要加载哪些音轨：只对**可听**的轨建元素，地址与片段预览同一来源
 * （use-edit-media-urls 解析出来的 blob: / asset://，或者是素材上记的地址）。
 *
 * 与导出 buildComposeTracks 的三条一致：静音 / 被独奏排除的轨整条跳过；素材不是音频的跳过；
 * 素材已经不在了的跳过。区别只有一处——导出用的是本地路径，这里要的是可播放地址：
 * 地址还没解析出来（只有 storageKey）时**只静默跳过**（与预览里「片段没有可播地址就留空状态」同一口径，
 * 解析完成后的重渲染会把元素补上），只有「素材被移除 / 不是音频」才算真的听不到，进 unavailable 让界面说明。
 */
export function editAudioPreviewPlan(tracks: EditAudioTrack[], media: EditMedia[], urls: Record<string, string>, totalSeconds: number): EditAudioPreviewPlan {
    const byId = new Map(media.map((item) => [item.id, item]));
    const audible = resolveAudibleTracks(tracks);
    const total = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
    const list: EditAudioPreviewTrack[] = [];
    const unavailable: string[] = [];
    const gaps: EditAudioPreviewGap[] = [];
    for (const track of tracks) {
        if (!audible.has(track.id)) continue;
        const source = byId.get(track.mediaId);
        if (!source || source.kind !== "audio") {
            unavailable.push(source?.name || track.mediaId);
            continue;
        }
        const src = urls[track.mediaId] || source.url || "";
        if (!src) {
            // 素材上什么都没得解析（既没有地址也没有存储键）时是**确定**拿不到，不必等解析那一轮；
            // 反过来，有得解析但解析结果还没落到 urls 里时只是一瞬间的中间态，报出来只会刷屏。
            const resolvable = Boolean(source.storageKey) || Boolean(source.url);
            gaps.push({ name: source.name, reason: resolvable && !(track.mediaId in urls) ? "pending" : "missing" });
            continue;
        }
        const start = clamp(track.start ?? 0, 0, total);
        const trim = editAudioTrimWindow(track, (source.durationMs || 0) / 1000);
        list.push({
            id: track.id,
            mediaId: track.mediaId,
            name: source.name,
            src,
            // 三个夹取范围与 ffmpeg_compose.rs 的 track_chain、属性区输入框三处同一口径。
            volume: clamp(track.volume, 0, EDIT_VOLUME_MAX),
            fadeIn: clamp(track.fadeIn, 0, EDIT_FADE_IN_MAX),
            fadeOut: clamp(track.fadeOut, 0, EDIT_FADE_OUT_MAX),
            start,
            span: Math.max(0, total - start),
            loop: track.loop === true,
            sourceSeconds: (source.durationMs || 0) / 1000,
            // 裁剪区间同样按素材登记时长换算：预览与时间线画的是同一段，导出侧读的也是这两个字段。
            sourceStart: trim.start,
            sourceEnd: trim.end,
        });
    }
    return { tracks: list, unavailable, gaps };
}

/**
 * 播放到成片时刻 seconds 时这条轨的线性增益（0 = 不出声）：
 * `volume × 淡入系数 × 淡出系数`，与导出那条链上串起来的两条 afade 逐点相乘完全一致。
 *
 * 出声区间是**左闭右开**的 `[start, start + span)`：起点之前是 adelay 的前置静音；
 * 而 `start + span` 就是成片末尾那一瞬间，它的样本已经落在成片之外（amix 是 duration=first），
 * 所以起点落在成片末尾（span = 0）的轨在这里恒为 0，不会出现「成片最后一刻突然有一声」。
 */
export function editAudioPreviewGain(track: EditAudioPreviewTrack, seconds: number): number {
    const local = seconds - track.start;
    if (!(local >= 0) || local >= track.span) return 0;
    // afade=t=in:st=0:d=fadeIn（本地时间轴的 0 就是起点）。
    const rampIn = track.fadeIn > 0 ? clamp(local / track.fadeIn, 0, 1) : 1;
    // afade=t=out:st=(span − fadeOut)：span 不够长时导出取 0，即从起点就开始淡出。
    const outStart = Math.max(0, track.span - track.fadeOut);
    const rampOut = track.fadeOut > 0 ? clamp(1 - (local - outStart) / track.fadeOut, 0, 1) : 1;
    return track.volume * rampIn * rampOut;
}

/**
 * 这条轨在素材内**真正能取用的内容长度**（秒）：出点减入点；出点缺省时按传入的素材时长算。
 * 0 = 时长未知（拿不到素材时长，也没有出点）。
 *
 * 它就是导出侧 `atrim` 之后剩下的那一段（裁剪）——预览的出声区间、循环体长度、
 * 淡出锚点（见 lib/edit/audio-gain 的 geometry.trimmed）读的都是它。
 * `sourceSeconds` 传元素自己报的时长更准（解码出来的 duration 比登记时的 durationMs 可靠）。
 */
export function editAudioPreviewContent(track: EditAudioPreviewTrack, sourceSeconds: number): number {
    const duration = Number.isFinite(sourceSeconds) && sourceSeconds > 0 ? sourceSeconds : 0;
    const end = track.sourceEnd > 0 ? track.sourceEnd : duration;
    const content = end - track.sourceStart;
    return Number.isFinite(content) && content > 0 ? content : 0;
}

/** 此刻这条轨该处于素材内的哪个位置（秒）、以多大增益出声、循环体有多长。 */
export type EditAudioPreviewState = {
    /** 该赋给 <audio>.currentTime 的**素材内**位置（秒）。 */
    offsetSeconds: number;
    gain: number;
    /** 循环体长度（秒）= 裁剪后的内容长度；漂移判定按它取模，0 = 时长未知（不取模）。 */
    cycleSeconds: number;
};

/**
 * 播放到成片时刻 seconds 时这条轨的状态；`null` = 此刻它不该出声，调用方应把它停住。
 * 四种 null：起点之前（前导静音）；本地时间到达 `span`（超出成片总长，成片里被 amix 截掉）；
 * 非循环素材已经放完（导出那边此时是静音，一直等到成片结束）；起点落在成片末尾（span = 0）。
 *
 * `sourceSeconds` 可以传**元素自己报的时长**：loop 的轨要按素材真实长度回卷，
 * 元素解码出来的 duration 比登记时的 durationMs 更准。
 *
 * 裁剪后「素材已经放完」的时刻是**裁剪区间的末尾**（出点）而不是素材末尾——导出侧 atrim 之后
 * 那一段就结束了，后面即使在素材里还有内容也不会进成片。
 */
export function editAudioPreviewState(track: EditAudioPreviewTrack, seconds: number, sourceSeconds = track.sourceSeconds): EditAudioPreviewState | null {
    const local = seconds - track.start;
    if (!(local >= 0) || local >= track.span) return null;
    const content = editAudioPreviewContent(track, sourceSeconds);
    // 非循环：留下的那一段放完就没了（导出那边此时是静音，一直等到成片结束）。
    if (!track.loop && content > 0 && local >= content) return null;
    // loop 对应导出的循环（-stream_loop -1 / 裁剪后的 aloop）：循环体是**裁剪后的那一段**，
    // 所以素材内的位置 = 入点 + 本地时间对内容长度取模（按整条素材取模会把裁掉的部分放回来）。
    const cycleSeconds = content > 0 ? content : 0;
    const offsetSeconds = track.loop && cycleSeconds > 0 ? track.sourceStart + (local % cycleSeconds) : track.sourceStart + local;
    return { offsetSeconds, gain: editAudioPreviewGain(track, seconds), cycleSeconds };
}

/**
 * 这条轨此刻**为什么不出声**，供界面把「没声音」翻成一句人话。
 *
 * 它不另造一套出声判定：`editAudioPreviewState` 返回非 null 时这里一律返回 null
 * （有一条不变式测试把两者绑在一起），只有 state 说「此刻不该出声」时才继续分类：
 * - `before-start`：播放头还没到这条轨的起点（导出里就是 adelay 的前置静音）；
 * - `start-past-end`：起点落在成片末尾，成片里一秒都听不到；
 * - `past-film`：本地时间到达 `span`（超出成片总长，amix 截掉）；
 * - `past-source`：非循环素材已经放完（导出那边此时也是静音，一直等到成片结束）。
 *
 * 秒数不是有限值时（播放头还没建立）不分类，返回 null：界面宁可不说，也不说错。
 */
export type EditAudioPreviewSilence = "before-start" | "start-past-end" | "past-film" | "past-source";

export function editAudioPreviewSilence(track: EditAudioPreviewTrack, seconds: number, sourceSeconds = track.sourceSeconds): EditAudioPreviewSilence | null {
    if (!Number.isFinite(seconds)) return null;
    if (editAudioPreviewState(track, seconds, sourceSeconds) !== null) return null;
    const local = seconds - track.start;
    if (track.span <= 0) return "start-past-end";
    if (local < 0) return "before-start";
    if (local >= track.span) return "past-film";
    return "past-source";
}

/**
 * 音轨的漂移（秒），正数表示元素落后于主时钟。
 *
 * 与视频共用同一套判定（editDriftSeconds 的差值 + editDriftAction + editDriftCooldownReady），
 * 唯一的补充是 loop：主时钟刚刚回卷到 0.1s 而元素还在 19.9s 时，两者其实在**同一个位置**，
 * 直接用差值会算成 −19.8s 而白白 seek 一次（听感上就是接缝处断一下）。
 * 所以先取「与元素当前位置最近的那个循环等价点」，把差值收敛到 ±循环体长度/2 以内。
 *
 * `durationSeconds` 传的是**循环体长度**（裁剪后就是留下的那一段，见 EditAudioPreviewState.cycleSeconds）：
 * 按整条素材取模时，元素已经播到被裁掉的那一段里也会被判成「位置正确」，从此不再纠正。
 */
export function editAudioDriftSeconds(desired: number, current: number, durationSeconds: number, loop: boolean): number {
    if (!loop || !(durationSeconds > 0)) return desired - current;
    return desired + Math.round((current - desired) / durationSeconds) * durationSeconds - current;
}

/**
 * 元素音量：浏览器 <audio> 的音量上限是 1，所以 100% 以上的音轨在预览里只能按 100% 出声。
 * 这是预览与导出**已知的一处差异**（导出的 volume 夹到 [0,4]，400% 只在成片里生效），
 * 界面文案里如实写明，不假装两边一致。
 */
export function editAudioPreviewElementVolume(gain: number): number {
    return clamp(gain, 0, 1);
}
