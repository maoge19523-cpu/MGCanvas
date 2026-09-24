import { uploadMediaFile, resolveMediaUrlState } from "@/services/file-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { EditMedia } from "@/types/edit";
import type { Asset } from "@/stores/use-asset-store";

/** 素材登记前的形态：id 与创建时间由剪辑台 store 统一分配。 */
export type EditMediaInput = Omit<EditMedia, "id" | "createdAt">;

/** 用浏览器媒体元素探测真实时长，与 file-storage 里导入素材时的做法一致。 */
export function probeEditMediaDuration(url: string, kind: "video" | "audio"): Promise<number | undefined> {
    return new Promise((resolve) => {
        if (!url || typeof document === "undefined") return resolve(undefined);
        const element = document.createElement(kind === "audio" ? "audio" : "video");
        const done = () => resolve(Number.isFinite(element.duration) && element.duration > 0 ? Math.round(element.duration * 1000) : undefined);
        element.onloadedmetadata = done;
        element.onerror = done;
        element.preload = "metadata";
        element.src = url;
    });
}

/** 预览用地址：优先还原存储键对应的本地副本，拿不到时才退回素材上记的地址。 */
export async function resolveEditMediaUrl(media: Pick<EditMedia, "storageKey" | "url">) {
    if (media.storageKey) {
        const { url } = await resolveMediaUrlState(media.storageKey, media.url || "");
        if (url) return url;
    }
    return media.url || "";
}

/** 本地文件导入：文件先落到 WebView 本地存储（media_files），探测出真实时长后登记为剪辑台素材。 */
export async function importLocalMediaFiles(files: File[]): Promise<EditMediaInput[]> {
    const imported: EditMediaInput[] = [];
    for (const file of files) {
        const kind = file.type.startsWith("audio/") ? "audio" : file.type.startsWith("video/") ? "video" : null;
        if (!kind) continue;
        const stored = await uploadMediaFile(file, kind === "audio" ? "edit-audio" : "edit-video");
        imported.push({
            name: file.name || (kind === "audio" ? "本地音频" : "本地视频"),
            kind,
            source: "local",
            storageKey: stored.storageKey,
            url: stored.url,
            mimeType: stored.mimeType,
            bytes: stored.bytes,
            durationMs: stored.durationMs,
            width: stored.width,
            height: stored.height,
        });
    }
    return imported;
}

/** 从「我的资产」取视频素材：资产里没存时长，这里现探一次。 */
export async function importAssetToEditMedia(asset: Asset): Promise<EditMediaInput | null> {
    if (asset.kind !== "video") return null;
    const url = (await resolveMediaUrlState(asset.data.storageKey, asset.data.url)).url;
    return {
        name: asset.title || "资产视频",
        kind: "video",
        source: "asset",
        storageKey: asset.data.storageKey,
        url,
        mimeType: asset.data.mimeType,
        bytes: asset.data.bytes,
        durationMs: await probeEditMediaDuration(url, "video"),
        width: asset.data.width,
        height: asset.data.height,
    };
}

/** 画布视频 / 音频节点 → 剪辑台素材。只读取节点上的媒体信息，不改动画布数据。 */
export function canvasNodeToEditMedia(node: CanvasNodeData): EditMediaInput | null {
    const isAudio = node.type === CanvasNodeType.Audio;
    if (!isAudio && node.type !== CanvasNodeType.Video) return null;
    const metadata = node.metadata || {};
    if (!metadata.content) return null;
    return {
        name: node.title || metadata.filename || (isAudio ? "画布音频" : "画布视频"),
        kind: isAudio ? "audio" : "video",
        source: "canvas",
        localPath: metadata.localPath,
        storageKey: metadata.storageKey,
        url: metadata.content,
        mimeType: metadata.mimeType,
        bytes: metadata.bytes,
        durationMs: metadata.durationMs,
        width: metadata.naturalWidth || node.width,
        height: metadata.naturalHeight || node.height,
    };
}
