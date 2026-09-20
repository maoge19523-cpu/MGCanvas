/**
 * 拼合场景的绘制层。
 *
 * 预览、编辑器、导出**共用这一个绘制函数**，保证所见即所得；
 * 选中框只在编辑器里传 selection 时才会画出来，所以保存下来的像素里永远不会带选中框。
 */
import { COLLAGE_ROTATE_OFFSET, collageHandlePoints, type CollageLayout, type CollageSize } from "./collage-layout";

export type CollageImages = Record<string, HTMLImageElement>;

export type CollageSceneParams = {
    /** 绘制顺序，数组末尾在最上层。 */
    order: string[];
    layout: CollageLayout;
    images: CollageImages;
    /** 每个图层声明的像素尺寸，几何与绘制都用它，保证两边永远一致。 */
    sources: Record<string, CollageSize>;
    scene: CollageSize;
    /** 输出缩放：缩略预览传 fitCollagePreview 的结果，导出传 1。 */
    scale: number;
    /** 仅编辑器传入当前选中的图层 id；导出时不传。 */
    selection?: string | null;
    /** 选中框描边颜色，由调用方按当前画布主题给。 */
    selectionColor?: string;
    /**
     * 是否画出四角缩放柄与顶部旋转柄。只在编辑器里开，
     * 于是手柄和画面天然在同一坐标系里，任何缩放下都不会错位。
     */
    showHandles?: boolean;
};

export function drawCollageScene(ctx: CanvasRenderingContext2D, params: CollageSceneParams) {
    const { order, layout, images, sources, scene, scale, selection, selectionColor = "#2f80ff", showHandles } = params;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, Math.ceil(scene.width * scale), Math.ceil(scene.height * scale));
    ctx.scale(scale, scale);

    for (const id of order) {
        const transform = layout[id];
        const image = images[id];
        const source = sources[id];
        if (!transform || !image || !source) continue;
        // 图层一律以自身中心为原点绘制：先平移到中心，再旋转，最后按 scale×stretch 缩放。
        ctx.save();
        ctx.translate(transform.x, transform.y);
        ctx.rotate((transform.rotation * Math.PI) / 180);
        ctx.scale(transform.scale * transform.stretchX, transform.scale * transform.stretchY);
        ctx.drawImage(image, -source.width / 2, -source.height / 2, source.width, source.height);
        ctx.restore();
    }

    const selected = selection ? layout[selection] : undefined;
    const selectedSource = selection ? sources[selection] : undefined;
    if (selected && selectedSource) {
        const { corners, rotate } = collageHandlePoints(selectedSource, selected, COLLAGE_ROTATE_OFFSET / scale, scene);
        ctx.save();
        ctx.strokeStyle = selectionColor;
        ctx.lineWidth = 2 / scale;
        ctx.setLineDash([6 / scale, 4 / scale]);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let index = 1; index < corners.length; index += 1) ctx.lineTo(corners[index].x, corners[index].y);
        ctx.closePath();
        ctx.stroke();
        if (showHandles) {
            // 手柄尺寸按 1/scale 反向补偿，屏幕上始终是同样大小。
            const size = 10 / scale;
            ctx.setLineDash([]);
            ctx.fillStyle = "#ffffff";
            ctx.lineWidth = 1.5 / scale;
            for (const corner of corners) {
                ctx.beginPath();
                ctx.rect(corner.x - size / 2, corner.y - size / 2, size, size);
                ctx.fill();
                ctx.stroke();
            }
            const topMiddle = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
            ctx.beginPath();
            ctx.moveTo(topMiddle.x, topMiddle.y);
            ctx.lineTo(rotate.x, rotate.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(rotate.x, rotate.y, size * 0.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
    }
    ctx.restore();
}

/** 按当前布局把场景绘制到一张全尺寸画布上并导出为 PNG。 */
export function renderCollageDataUrl(params: Omit<CollageSceneParams, "scale" | "selection">): string | null {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(params.scene.width));
    canvas.height = Math.max(1, Math.round(params.scene.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // 不传 selection：导出像素里不含选中框。
    drawCollageScene(ctx, { ...params, scale: 1 });
    try {
        return canvas.toDataURL("image/png");
    } catch {
        return null;
    }
}

/** 等图片真正解码完再返回，避免首帧画出空白或尺寸为 0 的图层。 */
export function loadCollageImages(entries: { id: string; url: string }[]): Promise<CollageImages> {
    return Promise.all(
        entries.map(
            (entry) =>
                new Promise<[string, HTMLImageElement] | null>((resolve) => {
                    const image = new Image();
                    image.onload = () => resolve([entry.id, image]);
                    image.onerror = () => resolve(null);
                    image.src = entry.url;
                }),
        ),
    ).then((results) => {
        const images: CollageImages = {};
        for (const result of results) if (result) images[result[0]] = result[1];
        return images;
    });
}
