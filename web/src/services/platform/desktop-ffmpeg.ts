import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { writeFile } from "@tauri-apps/plugin-fs";

import { getMediaBlob } from "@/services/file-storage";
import { cacheRemoteMedia } from "@/services/local-media-cache";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { invokeDesktop, isDesktopAssetUrl, isTauriRuntime } from "./desktop-runtime";

export const FFMPEG_PATH_STORAGE_KEY = "mgcanvas:ffmpeg-path";

export function readFfmpegPath() {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(FFMPEG_PATH_STORAGE_KEY)?.trim() || "";
}

export function setFfmpegPath(path: string) {
    if (typeof window === "undefined") return;
    const value = path.trim();
    if (value) window.localStorage.setItem(FFMPEG_PATH_STORAGE_KEY, value);
    else window.localStorage.removeItem(FFMPEG_PATH_STORAGE_KEY);
}

export type ComposeSegmentInput = { path: string; start?: number; end?: number; volume?: number; transition?: string; transitionDuration?: number; subtitle?: string; fadeIn?: number; fadeOut?: number; muted?: boolean };
export type ComposeAudioTrackInput = { path: string; volume?: number; fadeIn?: number; fadeOut?: number; loop?: boolean };
export type ComposeVideoRequest = {
    ffmpegPath?: string;
    segments: ComposeSegmentInput[];
    tracks?: ComposeAudioTrackInput[];
    longEdge?: number;
    fps?: number;
    fadeIn?: number;
    fadeOut?: number;
    title?: string;
    subtitleStyle?: string;
    subtitleSize?: string;
};
export type ComposeVideoResult = { absolutePath: string; filename: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number };

/** 剪辑台素材里与「能否交给 FFmpeg 读取」相关的字段，纯数据，不含画布节点语义。 */
export type EditMediaPathInput = { id: string; kind: "video" | "audio"; name?: string; localPath?: string; storageKey?: string; url?: string; mimeType?: string };

export function detectFfmpeg(manualPath = readFfmpegPath()): Promise<string | null> {
    if (!isTauriRuntime()) return Promise.resolve(null);
    return invokeDesktop<string | null>("detect_ffmpeg", { manualPath: manualPath || null });
}

export function composeVideo(request: ComposeVideoRequest): Promise<ComposeVideoResult> {
    return invokeDesktop<ComposeVideoResult>("compose_video", { request });
}

export type ConcatAudioResult = { absolutePath: string; filename: string; mimeType: string; bytes: number; durationMs: number };

// 多段音频按顺序拼接（多角色配音合并）：编解码交给本机 FFmpeg，前端不碰音频格式。
export function concatAudio(paths: string[], title?: string): Promise<ConcatAudioResult> {
    return invokeDesktop<ConcatAudioResult>("concat_audio", { request: { ffmpegPath: readFfmpegPath() || undefined, paths, title } });
}

/** 音频峰值包络：本机 FFmpeg 解码成单声道 8kHz PCM 后统计，前端只拿两个小数组。 */
export type AudioWaveformResult = { peaks: number[]; troughs: number[]; durationMs: number; sampleRate: number };

export function audioWaveform(path: string, samples: number): Promise<AudioWaveformResult> {
    return invokeDesktop<AudioWaveformResult>("audio_waveform", { request: { ffmpegPath: readFfmpegPath() || undefined, path, samples } });
}

const MEDIA_EXTENSION_BY_MIME: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
};

// 把画布上的视频/音频节点解析成 FFmpeg 能直接读取的本地绝对路径；浏览器存储的素材会先落盘到 media-cache。
export async function resolveCanvasMediaLocalPath(node: CanvasNodeData): Promise<string> {
    if (!isTauriRuntime()) throw new Error("视频合成仅在桌面客户端可用");
    const metadata = node.metadata || {};
    if (metadata.localPath) return metadata.localPath;
    const content = metadata.content || "";
    if (/^https?:\/\//i.test(content) && !isDesktopAssetUrl(content)) {
        const cached = await cacheRemoteMedia({ url: content, filename: metadata.filename || node.title });
        return cached.absolutePath;
    }
    if (metadata.storageKey) {
        const blob = await getMediaBlob(metadata.storageKey);
        if (blob) {
            const extension = MEDIA_EXTENSION_BY_MIME[metadata.mimeType || ""] || (node.type === CanvasNodeType.Audio ? "mp3" : "mp4");
            const target = await join(await appLocalDataDir(), "media-cache", `${node.id}-${Date.now()}.${extension}`);
            await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
            return target;
        }
    }
    if (isDesktopAssetUrl(content)) {
        try {
            const decoded = decodeURIComponent(new URL(content).pathname);
            const path = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded.replace(/^\/+/, "/");
            if (path.length > 2) return path;
        } catch {
            // 不是可还原的本地素材地址，走统一报错。
        }
    }
    throw new Error("素材没有可用的本地文件，请重新上传该素材节点");
}

/**
 * 剪辑台素材 → FFmpeg 能直接读取的本地绝对路径。
 * 与 resolveCanvasMediaLocalPath 同一条链路，只是入参换成剪辑台自己的素材记录（纯数据，不依赖画布节点）。
 */
export async function resolveEditMediaLocalPath(media: EditMediaPathInput): Promise<string> {
    if (!isTauriRuntime()) throw new Error("视频合成仅在桌面客户端可用");
    if (media.localPath) return media.localPath;
    const content = media.url || "";
    if (/^https?:\/\//i.test(content) && !isDesktopAssetUrl(content)) {
        const cached = await cacheRemoteMedia({ url: content, filename: media.name });
        return cached.absolutePath;
    }
    if (media.storageKey) {
        const blob = await getMediaBlob(media.storageKey);
        if (blob) {
            const extension = MEDIA_EXTENSION_BY_MIME[media.mimeType || ""] || (media.kind === "audio" ? "mp3" : "mp4");
            const target = await join(await appLocalDataDir(), "media-cache", `${media.id}-${Date.now()}.${extension}`);
            await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
            return target;
        }
    }
    if (isDesktopAssetUrl(content)) {
        try {
            const decoded = decodeURIComponent(new URL(content).pathname);
            const path = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded.replace(/^\/+/, "/");
            if (path.length > 2) return path;
        } catch {
            // 不是可还原的本地素材地址，走统一报错。
        }
    }
    throw new Error("素材没有可用的本地文件，请重新导入该素材");
}
