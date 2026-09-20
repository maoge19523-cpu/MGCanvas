import { useEffect, useState } from "react";

import { pickThumbnailWidth } from "@/lib/media/thumbnail-cache";
import { loadThumbnail } from "@/lib/media/thumbnail-store";

/**
 * 给图片节点用的缩略图地址。
 *
 * 关键点是「按屏幕上真实渲染的像素宽度」挑档位：节点在画布里被缩放，
 * 所以直接量元素的布局宽度乘上 devicePixelRatio，就自然包含了画布缩放，
 * 不需要把 zoom 从页面层层透传下来。放大到超过缓存上限时自动回退原图。
 *
 * 返回 undefined 表示继续用原图。
 */
export function useThumbnailSource({ source, sourceWidth, element }: { source?: string; sourceWidth: number; element: React.RefObject<HTMLElement | null> }): string | undefined {
    const [measuredWidth, setMeasuredWidth] = useState(0);
    const [thumbnail, setThumbnail] = useState<string | undefined>(undefined);

    // 每次渲染后量一次；只有档位真的变了才 setState，不会触发循环。
    useEffect(() => {
        const target = element.current;
        if (!target) return;
        const rect = target.getBoundingClientRect();
        const width = rect.width * (window.devicePixelRatio || 1);
        if (width > 0) setMeasuredWidth((current) => (Math.abs(current - width) > 8 ? width : current));
    });

    const width = source ? pickThumbnailWidth(sourceWidth, measuredWidth) : null;

    useEffect(() => {
        if (!source || width === null) {
            setThumbnail(undefined);
            return undefined;
        }
        let alive = true;
        void loadThumbnail(source, width).then((url) => {
            if (alive) setThumbnail(url ?? undefined);
        });
        return () => {
            alive = false;
        };
    }, [source, width]);

    return width === null ? undefined : thumbnail;
}
