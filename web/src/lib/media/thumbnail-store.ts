/**
 * 缩略图缓存的运行时：编码 webp、落 IndexedDB、并发去重、按上限清理。
 *
 * 策略（算键、选宽度、淘汰谁）全在同目录的 thumbnail-cache.ts 里，本文件只负责执行。
 */
import localforage from "localforage";

import {
    THUMBNAIL_MAX_BYTES,
    THUMBNAIL_MAX_ENTRIES,
    THUMBNAIL_TTL_MS,
    planThumbnailEviction,
    thumbnailKey,
    type ThumbnailIndexEntry,
} from "./thumbnail-cache";

const store = localforage.createInstance({ name: "mgcanvas", storeName: "thumbnails" });
const INDEX_KEY = "__index__";
const WEBP_QUALITY = 0.82;
/** 命中后多久才回写一次索引，避免滚动画布时疯狂写库。 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const FLUSH_DELAY_MS = 2000;

/** 同一键的并发请求共享同一个 Promise：50 个节点指向同一张图时只解码一次。 */
const inFlight = new Map<string, Promise<string | null>>();
/** 键 → object URL；淘汰时同步撤销，避免 Blob 被 URL 一直钉在内存里。 */
const ready = new Map<string, string>();
let index: Map<string, ThumbnailIndexEntry> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function hasDom() {
    return typeof window !== "undefined" && typeof document !== "undefined";
}

async function ensureIndex(): Promise<Map<string, ThumbnailIndexEntry>> {
    if (index) return index;
    index = new Map();
    try {
        const stored = await store.getItem<ThumbnailIndexEntry[]>(INDEX_KEY);
        for (const entry of stored || []) index.set(entry.key, entry);
    } catch {
        // 索引读不出来就当成空缓存，后面照常重建。
    }
    return index;
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushIndex();
    }, FLUSH_DELAY_MS);
}

async function flushIndex() {
    if (!index) return;
    try {
        await store.setItem(INDEX_KEY, [...index.values()]);
    } catch {
        // 写索引失败只影响淘汰统计，不影响已缓存的缩略图。
    }
}

/** 记录一次使用，用于淘汰排序；短时间内不重复回写。 */
function touch(key: string, bytes: number) {
    if (!index) return;
    const current = index.get(key);
    const now = Date.now();
    if (current && now - current.usedAt < TOUCH_INTERVAL_MS && current.bytes === bytes) return;
    index.set(key, { key, bytes, usedAt: now });
    scheduleFlush();
}

async function enforceLimits() {
    const entries = await ensureIndex();
    const dropped = planThumbnailEviction([...entries.values()], {
        maxEntries: THUMBNAIL_MAX_ENTRIES,
        maxBytes: THUMBNAIL_MAX_BYTES,
        now: Date.now(),
        ttl: THUMBNAIL_TTL_MS,
    });
    if (!dropped.length) return;
    for (const key of dropped) {
        entries.delete(key);
        const url = ready.get(key);
        if (url) {
            URL.revokeObjectURL(url);
            ready.delete(key);
        }
        void store.removeItem(key);
    }
    await flushIndex();
}

/** 把图片画到小画布再编成 webp。跨域图会污染画布，这里一律兜底成 null 回退原图。 */
async function encode(source: string, width: number): Promise<Blob | null> {
    try {
        const image = await new Promise<HTMLImageElement | null>((resolve) => {
            const element = new Image();
            element.onload = () => resolve(element);
            element.onerror = () => resolve(null);
            element.src = source;
        });
        if (!image?.naturalWidth || !image.naturalHeight) return null;
        const targetWidth = Math.max(1, Math.min(width, image.naturalWidth));
        const targetHeight = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * targetWidth));
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(image, 0, 0, targetWidth, targetHeight);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", WEBP_QUALITY));
        return blob && blob.size > 0 ? blob : null;
    } catch {
        return null;
    }
}

function registerUrl(key: string, blob: Blob) {
    const existing = ready.get(key);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    ready.set(key, url);
    return url;
}

async function build(source: string, width: number, key: string): Promise<string | null> {
    try {
        await ensureIndex();
        const stored = await store.getItem<Blob>(key);
        if (stored && stored.size > 0) {
            touch(key, stored.size);
            return registerUrl(key, stored);
        }
        const blob = await encode(source, width);
        if (!blob) return null;
        await store.setItem(key, blob);
        touch(key, blob.size);
        await enforceLimits();
        return registerUrl(key, blob);
    } catch {
        return null;
    }
}

/**
 * 取缩略图的 object URL；已经有缓存就同步返回，没有则异步生成。
 *
 * 任何失败（跨域污染、编码失败、写库失败）都返回 null，调用方一律回退原图。
 */
export function loadThumbnail(source: string, width: number): Promise<string | null> {
    if (!hasDom()) return Promise.resolve(null);
    const key = thumbnailKey(source, width);
    const cached = ready.get(key);
    if (cached) {
        touch(key, 0);
        return Promise.resolve(cached);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = build(source, width, key).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
}

/** 仅供测试与调试：清空内存态，不影响已落库的缓存。 */
export function resetThumbnailRuntime() {
    for (const url of ready.values()) URL.revokeObjectURL(url);
    ready.clear();
    inFlight.clear();
    index = null;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
}
