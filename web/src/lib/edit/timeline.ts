import type { ComposeAudioTrackInput, ComposeSegmentInput, ComposeSubtitleInput, ComposeVideoRequest } from "@/services/platform/desktop-ffmpeg";
import { resolveAudibleTracks } from "./audio-mix";
import { editAudioTrimFields, editAudioTrimWindow } from "./audio-trim";
import { normalizeEditTransition, type EditClip, type EditMedia, type EditProject } from "@/types/edit";

/** 时间线上的一段：时长与起点都由素材真实时长与入出点算出，顺序即数组顺序。 */
export type EditClipView = {
    id: string;
    mediaId: string;
    name: string;
    /** 可播放地址，浏览器预览用。 */
    src: string;
    start: number;
    /** 实际生效的出点（秒），与 start 一起决定本段净时长。 */
    end: number;
    length: number;
    offset: number;
    volume: number;
    fadeIn: number;
    fadeOut: number;
    transition?: string;
    transitionDuration: number;
    subtitle?: string;
    /** 关闭原声：这一段视频自带的声音不出声（画面照旧），预览与成片一致。 */
    muted: boolean;
    /** 锁定：拖动换序、两端裁剪、拆分、删除都会被拒绝（只影响编辑，不影响导出）。 */
    locked: boolean;
    /** 素材自身时长（秒），0 表示没探测到。 */
    sourceSeconds: number;
    /** 素材缺少时长信息时为 false，该段长度为 0、无法真正入轨。 */
    hasDuration: boolean;
};

function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
}

/** 有出点就用出点（不超过素材全长），否则整段到最后。 */
export function editClipTiming(sourceSeconds: number, clip: Pick<EditClip, "start" | "end">) {
    const start = Math.max(0, clip.start || 0);
    const end = clip.end && sourceSeconds ? Math.min(clip.end, sourceSeconds) : sourceSeconds;
    return { start, length: Math.max(0, end - start) };
}

export function buildEditClips(media: EditMedia[], clips: EditClip[], urls: Record<string, string> = {}): EditClipView[] {
    const byId = new Map(media.map((item) => [item.id, item]));
    let offset = 0;
    return clips.map((clip) => {
        const source = byId.get(clip.mediaId);
        const sourceSeconds = (source?.durationMs || 0) / 1000;
        const { start, length } = editClipTiming(sourceSeconds, clip);
        const view: EditClipView = {
            id: clip.id,
            mediaId: clip.mediaId,
            name: source?.name || "素材已移除",
            src: urls[clip.mediaId] || source?.url || "",
            start,
            end: start + length,
            length,
            offset,
            volume: clip.volume,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            // 旧项目里可能存着空串或已经改名的转场，读进来就归一成硬切，避免一路传到 FFmpeg。
            transition: normalizeEditTransition(clip.transition),
            transitionDuration: clip.transitionDuration ?? 0.5,
            subtitle: clip.subtitle,
            muted: clip.muted === true,
            locked: clip.locked === true,
            sourceSeconds,
            hasDuration: sourceSeconds > 0,
        };
        offset += length;
        return view;
    });
}

/** 顺序连播的总时长：各段净时长之和，不含转场重叠、也不含音轨。 */
export function editPlaybackSeconds(clips: EditClipView[]) {
    return clips.reduce((sum, clip) => sum + clip.length, 0);
}

/**
 * 每段转场实际生效的秒数，口径与 Rust 侧完全一致：
 * 最多取相邻两段中较短者的八成，再限制在 0.1–1.5 秒；没设转场的接缝为 0。
 */
export function editTransitionSeconds(clips: EditClipView[]) {
    return clips.map((clip, index) => {
        if (index + 1 >= clips.length || !clip.transition) return 0;
        const limit = clamp(Math.min(clips[index].length, clips[index + 1].length) * 0.8, 0.1, 1.5);
        return Math.min(clamp(clip.transitionDuration, 0.1, 1.5), limit);
    });
}

/** 成片时长：每次转场都会让成片比各段之和短一个转场时长（与 Rust 的 total 同口径）。 */
export function editOutputSeconds(clips: EditClipView[]) {
    return editPlaybackSeconds(clips) - editTransitionSeconds(clips).reduce((sum, value) => sum + value, 0);
}

/** 播放头纯计算：给当前段与媒体时间，算出全局秒数、该段音量（含淡入淡出）与该段是否播完。 */
export function resolveEditPlayback(clips: EditClipView[], index: number, currentTime: number) {
    const clip = clips[index];
    if (!clip) return null;
    const local = Math.max(0, Math.min(currentTime - clip.start, clip.length));
    const fadeIn = clip.fadeIn > 0 ? local / clip.fadeIn : 1;
    const fadeOut = clip.fadeOut > 0 ? (clip.length - local) / clip.fadeOut : 1;
    return {
        index,
        local,
        seconds: clip.offset + local,
        // 浏览器音量上限是 1，属性区允许的 400% 只能在 FFmpeg 侧生效。
        // 关闭原声的片段直接给 0：预览必须与成片同一声（成片侧见 compose_video 的静音源分支）。
        volume: clip.muted ? 0 : Math.min(1, Math.max(0, clip.volume * Math.min(1, fadeIn, fadeOut))),
        finished: local >= clip.length - 0.03,
    };
}

/** 播放中定位：把全局秒数反查成「第几段 + 段内媒体时间」。 */
export function resolveEditSeek(clips: EditClipView[], seconds: number) {
    const last = clips.length - 1;
    let index = clips.findIndex((clip) => seconds < clip.offset + clip.length);
    if (index < 0) index = last;
    const clip = clips[index];
    return clip ? { index, currentTime: clip.start + Math.max(0, Math.min(seconds - clip.offset, clip.length)) } : null;
}

// 标尺刻度步长：在 0.5s～120s 里挑一档，让刻度数不超过 8 个。
const EDIT_TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];

export function editTickStep(total: number) {
    return EDIT_TICK_STEPS.find((step) => total / step <= 8) ?? EDIT_TICK_STEPS[EDIT_TICK_STEPS.length - 1];
}

export function editTickLabel(seconds: number, step: number) {
    if (seconds >= 60) return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
    return step < 1 ? seconds.toFixed(1) : String(Math.round(seconds));
}

/** 播放头读数与总时长统一用「分:秒.十分位」，与导出时长口径一致。 */
export function formatEditTime(seconds: number) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safe / 60);
    return `${minutes}:${(safe - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

export type EditComposeInput = { project: EditProject; paths: Record<string, string> };

/** 剪辑台片段 → compose_video 的 segments；只有拿到本地路径、且素材仍存在的片段才会进合成。 */
export function buildComposeSegments({ project, paths }: EditComposeInput): ComposeSegmentInput[] {
    const mediaById = new Map(project.media.map((item) => [item.id, item]));
    return project.clips
        .filter((clip) => mediaById.get(clip.mediaId)?.kind === "video")
        .flatMap((clip) => {
            const path = paths[clip.mediaId];
            if (!path) return [];
            // 交给 compose_video 的转场必须落在白名单里：空串与未知值一律变成硬切（不带 transition 字段）。
            const transition = normalizeEditTransition(clip.transition);
            return [
                {
                    path,
                    start: clip.start,
                    end: clip.end || undefined,
                    volume: clip.volume,
                    transition,
                    transitionDuration: transition ? clip.transitionDuration ?? 0.5 : undefined,
                    subtitle: clip.subtitle?.trim() || undefined,
                    fadeIn: clip.fadeIn,
                    fadeOut: clip.fadeOut,
                    // 关闭原声的片段照旧进拼接（它有画面），只是音频侧改用静音源；
                    // 非静音时不下发这个字段，请求体与改动前完全一致。
                    muted: clip.muted === true || undefined,
                },
            ];
        });
}

/** 剪辑台音轨 → compose_video 的 tracks：音频素材按裁剪后的区间混进成片，起点、音量与淡入淡出生效。 */
export function buildComposeTracks({ project, paths }: EditComposeInput): ComposeAudioTrackInput[] {
    const mediaById = new Map(project.media.map((item) => [item.id, item]));
    // 静音轨与被独奏排除的轨**整条跳过**，不进 FFmpeg 的 tracks：
    // amix 的输入数就是 tracks 长度 + 1、补偿系数也随之自洽，所以跳一条轨既不出声、
    // 也不改变其它轨的电平，而且滤镜链一个字都不用动（那条链上出过尾逗号事故）。
    const audible = resolveAudibleTracks(project.audioTracks);
    return project.audioTracks.flatMap((track) => {
        if (!audible.has(track.id)) return [];
        const path = paths[track.mediaId];
        const source = mediaById.get(track.mediaId);
        if (!path || source?.kind !== "audio") return [];
        // 裁剪区间按素材登记时长换算（与时间线上画出来的那一段同一份纯函数）。
        const trim = editAudioTrimWindow(track, (source.durationMs || 0) / 1000);
        return [
            {
                path,
                volume: track.volume,
                fadeIn: track.fadeIn,
                fadeOut: track.fadeOut,
                loop: track.loop,
                // 起始时间照旧只下发「真的不是 0」的那一种：缺省 / 0 不下发这个字段，
                // 请求体与改动前逐字一致（Rust 侧也就不追加 adelay）。
                start: track.start !== undefined && track.start > 0 ? track.start : undefined,
                // 同理，裁剪也只下发「真的裁过」的那一种：入点为 0、出点到素材末尾都写 undefined，
                // 于是**没裁过的工程请求体与改动前逐字一致**（JSON 里连键都不出现，Rust 侧也就不加那对 atrim）。
                ...editAudioTrimFields(trim),
            },
        ];
    });
}

/** 独立字幕轨 → compose_video 的 subtitles：按成片时间轴给绝对起止时间，与片段无关。 */
export function buildComposeSubtitles(project: EditProject): ComposeSubtitleInput[] | undefined {
    const cues = (project.subtitles ?? []).flatMap((cue) => {
        const text = cue.text.trim();
        // 空文本与读不出来的时间不进请求体：它们本来就不该在成片里出现（界面上也建不出这种条目）。
        if (!text || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) return [];
        return [{ start: Math.max(0, cue.start), end: cue.end, text }];
    });
    // 一条都没有时**不下发这个字段**：请求体与改动前逐字一致，Rust 侧也就不进字幕分支。
    return cues.length ? cues : undefined;
}

/** 剪辑台项目 → compose_video 的完整入参：纯数据映射，不涉及画布节点或 compositeSettings。 */
export function buildComposeRequest(input: EditComposeInput): ComposeVideoRequest {
    const { project } = input;
    const subtitles = buildComposeSubtitles(project);
    return {
        segments: buildComposeSegments(input),
        tracks: buildComposeTracks(input),
        // 没有字幕时**整个键都不出现**：请求体与改动前逐字一致，Rust 侧也就不进字幕分支。
        ...(subtitles ? { subtitles } : {}),
        longEdge: project.output.longEdge,
        fps: project.output.fps,
        fadeIn: project.output.fadeIn,
        fadeOut: project.output.fadeOut,
        title: project.name,
        subtitleStyle: project.output.subtitleStyle,
        subtitleSize: project.output.subtitleSize,
    };
}
