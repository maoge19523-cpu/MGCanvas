import { describe, expect, it } from "vitest";

import {
    THUMBNAIL_MAX_BYTES,
    THUMBNAIL_MAX_ENTRIES,
    THUMBNAIL_MAX_WIDTH,
    THUMBNAIL_TTL_MS,
    hashThumbnailSource,
    pickThumbnailWidth,
    planThumbnailEviction,
    thumbnailKey,
    type ThumbnailIndexEntry,
} from "./thumbnail-cache";

const entry = (key: string, bytes: number, usedAt: number): ThumbnailIndexEntry => ({ key, bytes, usedAt });
const options = (patch: Partial<{ maxEntries: number; maxBytes: number; now: number; ttl: number }> = {}) => ({
    maxEntries: THUMBNAIL_MAX_ENTRIES,
    maxBytes: THUMBNAIL_MAX_BYTES,
    now: 1_000,
    ttl: THUMBNAIL_TTL_MS,
    ...patch,
});

describe("缩略图缓存键", () => {
    it("同一源同一宽度得到同一个键，宽度不同则不同", () => {
        expect(thumbnailKey("blob:image-a", 256)).toBe(thumbnailKey("blob:image-a", 256));
        expect(thumbnailKey("blob:image-a", 256)).not.toBe(thumbnailKey("blob:image-a", 512));
        expect(thumbnailKey("blob:image-a", 256)).not.toBe(thumbnailKey("blob:image-b", 256));
    });

    it("超长 data URL 被折成短哈希，不会把整串字节塞进键里", () => {
        const dataUrl = `data:image/png;base64,${"A".repeat(200_000)}`;
        const hashed = hashThumbnailSource(dataUrl);
        expect(hashed.length).toBeLessThan(20);
        expect(thumbnailKey(dataUrl, 256)).not.toContain("base64");
    });

    it("内容只差一个字符时哈希不同", () => {
        expect(hashThumbnailSource("data:image/png;base64,AAAA")).not.toBe(hashThumbnailSource("data:image/png;base64,AAAB"));
    });
});

describe("缩略图目标宽度", () => {
    it("按档位向上取整，避免每个节点尺寸都存一份", () => {
        expect(pickThumbnailWidth(4000, 250)).toBe(256);
        expect(pickThumbnailWidth(4000, 257)).toBe(384);
        expect(pickThumbnailWidth(4000, 1024)).toBe(1024);
    });

    it("显示尺寸超过上限时回退原图，保证放大查看依然清晰", () => {
        expect(pickThumbnailWidth(4000, THUMBNAIL_MAX_WIDTH + 1)).toBeNull();
        expect(pickThumbnailWidth(4000, 1600)).toBeNull();
    });

    it("源图本来就够小时不生成缩略图", () => {
        expect(pickThumbnailWidth(300, 256)).toBeNull();
        expect(pickThumbnailWidth(256, 256)).toBeNull();
        expect(pickThumbnailWidth(4000, 256)).toBe(256);
    });

    it("尺寸非法时一律回退原图", () => {
        expect(pickThumbnailWidth(Number.NaN, 256)).toBeNull();
        expect(pickThumbnailWidth(4000, 0)).toBeNull();
        expect(pickThumbnailWidth(4000, Number.NaN)).toBeNull();
    });
});

describe("缩略图淘汰", () => {
    it("都合规时一个都不删", () => {
        const index = [entry("a", 10, 900), entry("b", 10, 950)];
        expect(planThumbnailEviction(index, options())).toEqual([]);
    });

    it("先清掉超过 TTL 的条目", () => {
        const index = [entry("fresh", 10, 1_000), entry("stale", 10, 1_000 - THUMBNAIL_TTL_MS - 1)];
        expect(planThumbnailEviction(index, options())).toEqual(["stale"]);
    });

    it("超出条目上限时淘汰最久未用的", () => {
        const index = [entry("oldest", 10, 100), entry("middle", 10, 500), entry("newest", 10, 900)];
        expect(planThumbnailEviction(index, options({ maxEntries: 2 })).sort()).toEqual(["oldest"]);
    });

    it("超出字节上限时按最久未用依次淘汰，刚够就停手", () => {
        const index = [entry("a", 60, 100), entry("b", 60, 200), entry("c", 60, 300)];
        // 总共 180，丢掉最久未用的 a 后剩 120，已经在上限内就不再继续丢。
        expect(planThumbnailEviction(index, options({ maxBytes: 150 }))).toEqual(["a"]);
        expect(planThumbnailEviction(index, options({ maxBytes: 60 }))).toEqual(["a", "b"]);
    });

    it("过期的条目也计入淘汰，不会因为已经超限而漏掉它们", () => {
        const index = [entry("stale", 60, 1), entry("a", 60, 900), entry("b", 60, 950)];
        const dropped = planThumbnailEviction(index, options({ maxBytes: 60 }));
        expect(dropped).toContain("stale");
        expect(dropped).toContain("a");
        expect(dropped).not.toContain("b");
    });
});
