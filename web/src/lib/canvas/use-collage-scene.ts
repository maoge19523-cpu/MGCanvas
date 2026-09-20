import { useEffect, useMemo, useState } from "react";

import { collageSceneSize, reconcileCollageLayout, type CollageLayout, type CollageSize } from "./collage-layout";
import { loadCollageImages, type CollageImages } from "./collage-scene";
import type { CanvasNodeData } from "@/types/canvas";

/** 一个图层来源：节点 id、图片地址与它声明的像素尺寸。 */
export type CollageSourceEntry = { id: string; url: string; width: number; height: number };

/**
 * 缩略预览和全屏编辑器共用的场景数据。
 *
 * 连线会随时增删，所以这里每次都按当前来源调和一次布局：新图层补进底部，断开的图层丢掉；
 * 已经摆放过的图层位置始终保留在节点 metadata 上，重新打开编辑器能接着改。
 */
export function useCollageScene(node: CanvasNodeData | undefined, sources: CollageSourceEntry[]) {
    const [images, setImages] = useState<CollageImages>({});
    const [reloadToken, setReloadToken] = useState(0);
    // 用内容指纹当依赖，避免调用方每次渲染新建数组导致的重复加载。
    const key = sources.map((source) => `${source.id}:${source.url}`).join("|");

    useEffect(() => {
        let alive = true;
        void loadCollageImages(sources).then((next) => {
            if (alive) setImages(next);
        });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, reloadToken]);

    const scene = useMemo(() => collageSceneSize(sources), [key]);
    const sourceSizes = useMemo(() => {
        const sizes: Record<string, CollageSize> = {};
        for (const source of sources) sizes[source.id] = { width: source.width, height: source.height };
        return sizes;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const storedLayout = node?.metadata?.collageLayout as CollageLayout | undefined;
    const storedOrder = node?.metadata?.collageOrder as string[] | undefined;
    const resolved = useMemo(
        () => reconcileCollageLayout(sources, storedOrder, storedLayout) ?? { layout: storedLayout ?? {}, order: storedOrder ?? [] },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key, storedLayout, storedOrder],
    );

    return { images, scene, sourceSizes, layout: resolved.layout, order: resolved.order, reloadImages: () => setReloadToken((value) => value + 1) };
}
