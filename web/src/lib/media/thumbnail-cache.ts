/**
 * 缩略图缓存的纯策略层：算键、挑目标宽度、决定该淘汰谁。
 *
 * 这里不碰 IndexedDB、不碰 canvas，全部是可以在单测里直接验证的纯计算，
 * 运行时（编码、落盘、并发去重）放在同目录的 thumbnail-store.ts。
 */

/** 缓存缩略图的最大边长；超过这个宽度的显示尺寸直接回退原图，保证放大查看时清晰。 */
export const THUMBNAIL_MAX_WIDTH = 1024;
/** 缓存条目 30 天没被用到就清掉。 */
export const THUMBNAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 条目数上限。 */
export const THUMBNAIL_MAX_ENTRIES = 400;
/** 总字节上限（webp 缩略图通常几十 KB，80MB 足够覆盖几千张）。 */
export const THUMBNAIL_MAX_BYTES = 80 * 1024 * 1024;
/** 缩略图按档位取整，避免每个节点尺寸都生成一份缓存。 */
export const THUMBNAIL_LADDER = [128, 192, 256, 384, 512, 768, 1024];
/** 源图比目标只大一点点时没必要再存一份缩略图。 */
const THUMBNAIL_MIN_SHRINK = 1.2;

export type ThumbnailIndexEntry = {
    key: string;
    bytes: number;
    /** 最近一次命中/写入的时间戳。 */
    usedAt: number;
};

/**
 * data URL 这类源可能长达几百 KB，不能直接当键，所以折成一个 53 位哈希。
 * 两个不同种子各走一遍 FNV-1a 再拼起来，碰撞概率对缓存场景足够低。
 */
export function hashThumbnailSource(source: string): string {
    let first = 0x811c9dc5;
    let second = 0x01000193;
    for (let index = 0; index < source.length; index += 1) {
        const code = source.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
    }
    return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

/** 缓存键：源地址 + 目标宽度。源地址在 MGCanvas 里与内容一一对应，所以不需要额外记录 mtime。 */
export function thumbnailKey(source: string, width: number): string {
    return `${hashThumbnailSource(source)}-${width}`;
}

/**
 * 判断这个图层该不该走缩略图，以及用哪一档宽度。
 *
 * 返回 `null` 表示直接用原图：显示尺寸已经超过缓存上限（用户在放大看细节），
 * 或者源图本身就比目标大不了多少（再存一份没有收益）。
 */
export function pickThumbnailWidth(sourceWidth: number, displayWidth: number): number | null {
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(displayWidth)) return null;
    const wanted = Math.ceil(displayWidth);
    if (wanted <= 0 || wanted > THUMBNAIL_MAX_WIDTH) return null;
    if (sourceWidth <= wanted * THUMBNAIL_MIN_SHRINK) return null;
    return THUMBNAIL_LADDER.find((step) => step >= wanted) ?? THUMBNAIL_MAX_WIDTH;
}

export type ThumbnailEvictionOptions = {
    maxEntries: number;
    maxBytes: number;
    now: number;
    ttl: number;
};

/**
 * 选出要删掉的键：先清过期，再按最久未用淘汰，直到条目数与总字节都回到上限内。
 *
 * 纯函数，只回答「删哪些」，不负责真的删。
 */
export function planThumbnailEviction(index: ThumbnailIndexEntry[], options: ThumbnailEvictionOptions): string[] {
    const { maxEntries, maxBytes, now, ttl } = options;
    const dropped = new Set<string>();
    let kept = index.filter((entry) => {
        if (now - entry.usedAt > ttl) {
            dropped.add(entry.key);
            return false;
        }
        return true;
    });

    let bytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    if (kept.length <= maxEntries && bytes <= maxBytes) return [...dropped];

    // usedAt 越小越久没用，排前面先淘汰。
    for (const entry of [...kept].sort((left, right) => left.usedAt - right.usedAt)) {
        if (kept.length <= maxEntries && bytes <= maxBytes) break;
        dropped.add(entry.key);
        bytes -= entry.bytes;
        kept = kept.filter((item) => item.key !== entry.key);
    }
    return [...dropped];
}
