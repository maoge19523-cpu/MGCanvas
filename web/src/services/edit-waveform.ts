import { audioWaveform, resolveEditMediaLocalPath, type EditMediaPathInput } from "@/services/platform/desktop-ffmpeg";
import { isTauriRuntime } from "@/services/platform/desktop-runtime";

/** 一条音轨的峰值包络：两个等长数组（每段的最高 / 最低幅度），外加真实音频时长。 */
export type EditWaveform = { peaks: Float32Array; troughs: Float32Array; durationMs: number };

/**
 * 内存缓存：同一个素材 + 同一档位只解码一次。
 * 不做持久化——一档 4096 点的包络约 32KB，落进 localforage 会随素材数量线性撑大本地存储，
 * 而重新解码一条音轨在本机只要几百毫秒；滑动档位时留最近几条就够用（LRU，超出即淘汰）。
 */
const CACHE_LIMIT = 24;
const cache = new Map<string, EditWaveform>();

export function editWaveformCacheKey(mediaId: string, buckets: number) {
    return `${mediaId}:${buckets}`;
}

/**
 * 取一条素材的波形包络：命中缓存直接返回，否则解析本地路径再让本机 FFmpeg 解码。
 * 浏览器环境（没有 Tauri 也没有 FFmpeg）与素材缺少本地文件时返回 null，交给调用方走降级表现。
 */
export async function ensureEditWaveform(media: EditMediaPathInput, buckets: number): Promise<EditWaveform | null> {
    const key = editWaveformCacheKey(media.id, buckets);
    const cached = cache.get(key);
    if (cached) {
        // 命中的挪到队尾，超过上限时淘汰最久没用过的那条。
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }
    if (!isTauriRuntime()) return null;
    const path = await resolveEditMediaLocalPath(media);
    // ffmpegPath 与合成走同一套解析（设置 → 本地 FFmpeg 里填的路径），不另开一套查找逻辑。
    const result = await audioWaveform(path, buckets);
    if (!result.peaks.length) return null;
    const waveform: EditWaveform = { peaks: Float32Array.from(result.peaks), troughs: Float32Array.from(result.troughs), durationMs: result.durationMs };
    cache.set(key, waveform);
    if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    return waveform;
}
