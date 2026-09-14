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

export type ComposeSegmentInput = { path: string; start?: number; end?: number; volume?: number };
export type ComposeMusicInput = { path: string; volume?: number; fadeOut?: number };
export type ComposeVideoRequest = {
    ffmpegPath?: string;
    segments: ComposeSegmentInput[];
    music?: ComposeMusicInput;
    longEdge?: number;
    fps?: number;
    fadeIn?: number;
    fadeOut?: number;
    title?: string;
};
export type ComposeVideoResult = { absolutePath: string; filename: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number };

export function detectFfmpeg(manualPath = readFfmpegPath()): Promise<string | null> {
    if (!isTauriRuntime()) return Promise.resolve(null);
    return invokeDesktop<string | null>("detect_ffmpeg", { manualPath: manualPath || null });
}

export function composeVideo(request: ComposeVideoRequest): Promise<ComposeVideoResult> {
    return invokeDesktop<ComposeVideoResult>("compose_video", { request });
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
