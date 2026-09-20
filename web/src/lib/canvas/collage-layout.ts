/**
 * 图片拼合节点的几何层：全部是纯函数，不碰 React、不碰画布状态。
 *
 * 拼合场景里每个图层只有一组变换：中心点 + 旋转 + 等比缩放 + 非等比拉伸。
 * 图层的实际绘制尺寸 = 原图尺寸 × scale × stretch（两个方向各自乘），
 * 这样「等比缩放」和「自由拉伸」是两个独立旋钮，符合直觉也便于分别夹取上限。
 */
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type Position } from "@/types/canvas";

export type CollageTransform = {
    /** 图层中心在拼合画布中的坐标 */
    x: number;
    y: number;
    /** 旋转角度，−180°…180° */
    rotation: number;
    /** 等比缩放，0.2…2 */
    scale: number;
    /** 横向非等比拉伸，0.05…20 */
    stretchX: number;
    /** 纵向非等比拉伸，0.05…20 */
    stretchY: number;
};

export type CollageLayout = Record<string, CollageTransform>;
export type CollageSize = { width: number; height: number };
/** 图层来源：id 用连线上的图片节点 id，宽高取图片原始像素。 */
export type CollageSource = { id: string; width: number; height: number };
/** 角手柄的方位，x/y 取 ±1。 */
export type CollageCorner = { x: -1 | 1; y: -1 | 1 };

export const COLLAGE_MAX_LAYERS = 10;
/** 拼合节点只认这两个端口，端口 id 集中在这里避免和连线判断写散。 */
export const COLLAGE_SOURCE_PORT_ID = "images";
export const COLLAGE_RESULT_PORT_ID = "collage";
/** 节点缩略预览的最大边长。 */
export const COLLAGE_PREVIEW_MAX = 252;
export const COLLAGE_ROTATION_LIMIT = 180;
/** 旋转手柄离图层顶边的距离（屏幕像素），命中测试与绘制共用同一个值。 */
export const COLLAGE_ROTATE_OFFSET = 34;
const clamp = (value: number, min: number, max: number, fallback: number) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
/** 等比缩放的上下限。 */
export const COLLAGE_SCALE_MIN = 0.2;
export const COLLAGE_SCALE_MAX = 2;
/** 非等比拉伸的上下限。 */
export const COLLAGE_STRETCH_MIN = 0.05;
export const COLLAGE_STRETCH_MAX = 20;

/** 未经布局的新图层：居中、不旋转、不缩放。 */
export function defaultCollageTransform(center: Position): CollageTransform {
    return { x: center.x, y: center.y, rotation: 0, scale: 1, stretchX: 1, stretchY: 1 };
}

export function clampCollageTransform(transform: CollageTransform): CollageTransform {
    return {
        x: Number.isFinite(transform.x) ? transform.x : 0,
        y: Number.isFinite(transform.y) ? transform.y : 0,
        rotation: clamp(transform.rotation, -COLLAGE_ROTATION_LIMIT, COLLAGE_ROTATION_LIMIT, 0),
        scale: clamp(transform.scale, COLLAGE_SCALE_MIN, COLLAGE_SCALE_MAX, 1),
        stretchX: clamp(transform.stretchX, COLLAGE_STRETCH_MIN, COLLAGE_STRETCH_MAX, 1),
        stretchY: clamp(transform.stretchY, COLLAGE_STRETCH_MIN, COLLAGE_STRETCH_MAX, 1),
    };
}

/** 拼合画布尺寸取所有图层的 max(宽) × max(高)。 */
export function collageSceneSize(sources: CollageSource[]): CollageSize {
    let width = 0;
    let height = 0;
    for (const source of sources) {
        width = Math.max(width, source.width);
        height = Math.max(height, source.height);
    }
    // 至少给一个能画的最小画布，避免空数据时除零。
    return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * 生成默认布局：所有图层居中铺满画布，层序按图片面积降序。
 *
 * 面积降序是为了零配置就有合理结果——大图自动垫底，小图浮在上面。
 */
export function createCollageLayout(sources: CollageSource[]): { layout: CollageLayout; order: string[] } {
    const scene = collageSceneSize(sources);
    const center = { x: scene.width / 2, y: scene.height / 2 };
    const layout: CollageLayout = {};
    for (const source of sources) layout[source.id] = defaultCollageTransform(center);
    const order = sources
        .slice()
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .map((source) => source.id);
    return { layout, order };
}

/**
 * 让布局与当前连线保持一致：新增的图层按面积降序插入底部，断开的图层直接移除。
 *
 * 返回 null 表示不需要改动，调用方可以据此避免无意义的写回。
 */
export function reconcileCollageLayout(sources: CollageSource[], order: string[] | undefined, layout: CollageLayout | undefined): { layout: CollageLayout; order: string[] } | null {
    if (!sources.length) return null;
    const ids = sources.map((source) => source.id);
    // 保留原有顺序、丢弃已断开的图层；新连进来的图层按面积降序补在后面。
    const known = (order || []).filter((id) => ids.includes(id));
    const defaults = createCollageLayout(sources);
    const merged: CollageLayout = {};
    for (const id of ids) merged[id] = layout?.[id] ?? defaults.layout[id];
    const ordered = [...known, ...defaults.order.filter((id) => !known.includes(id))];
    const sameOrder = ordered.length === (order || []).length && ordered.every((id, index) => id === order?.[index]);
    const sameLayout = Object.keys(layout || {}).length === ids.length;
    return sameOrder && sameLayout ? null : { layout: merged, order: ordered };
}

/** 图层在拼合画布中的实际半宽/半高（已含缩放与拉伸）。 */
export function collageLayerExtent(source: CollageSize, transform: CollageTransform): { halfWidth: number; halfHeight: number } {
    return {
        halfWidth: (source.width / 2) * transform.scale * transform.stretchX,
        halfHeight: (source.height / 2) * transform.scale * transform.stretchY,
    };
}

const cosine = (degrees: number) => Math.cos((degrees * Math.PI) / 180);
const sine = (degrees: number) => Math.sin((degrees * Math.PI) / 180);

/** 图层局部坐标 → 拼合画布坐标（与 canvas rotate 的矩阵一致）。 */
export function collageToScene(point: Position, transform: CollageTransform): Position {
    const cos = cosine(transform.rotation);
    const sin = sine(transform.rotation);
    return { x: transform.x + point.x * cos - point.y * sin, y: transform.y + point.x * sin + point.y * cos };
}

/** 拼合画布坐标 → 图层局部坐标（反向旋转），命中测试必须先走这一步。 */
export function collageToLocal(point: Position, transform: CollageTransform): Position {
    const cos = cosine(-transform.rotation);
    const sin = sine(-transform.rotation);
    const dx = point.x - transform.x;
    const dy = point.y - transform.y;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** 四个角在拼合画布中的坐标，顺序为左上、右上、右下、左下。 */
export function collageLayerCorners(source: CollageSize, transform: CollageTransform): Position[] {
    const { halfWidth, halfHeight } = collageLayerExtent(source, transform);
    return [
        { x: -halfWidth, y: -halfHeight },
        { x: halfWidth, y: -halfHeight },
        { x: halfWidth, y: halfHeight },
        { x: -halfWidth, y: halfHeight },
    ].map((point) => collageToScene(point, transform));
}

/**
 * 选中图层的手柄位置，全部在拼合画布坐标系里，随图层旋转一起转。
 *
 * 绘制和命中测试都只从这里取坐标，两者不可能对不上；
 * 旋转柄的偏移由调用方按 `COLLAGE_ROTATE_OFFSET / scale` 传进来，保证屏幕上距离恒定。
 */
export function collageHandlePoints(source: CollageSize, transform: CollageTransform, rotateOffset: number, bounds?: CollageSize): { corners: Position[]; rotate: Position } {
    const { halfWidth, halfHeight } = collageLayerExtent(source, transform);
    const rotate = collageToScene({ x: 0, y: -halfHeight - rotateOffset }, transform);
    // 图层顶到画布边缘时旋转柄会落到画布外被裁掉、根本点不到，所以夹回画布内。
    if (bounds) {
        rotate.x = clamp(rotate.x, rotateOffset, Math.max(rotateOffset, bounds.width - rotateOffset), rotate.x);
        rotate.y = clamp(rotate.y, rotateOffset, Math.max(rotateOffset, bounds.height - rotateOffset), rotate.y);
    }
    return {
        corners: [
            { x: -halfWidth, y: -halfHeight },
            { x: halfWidth, y: -halfHeight },
            { x: halfWidth, y: halfHeight },
            { x: -halfWidth, y: halfHeight },
        ].map((point) => collageToScene(point, transform)),
        rotate,
    };
}

/** 旋转感知命中测试：把点反旋转回图层局部坐标再判矩形。 */export function hitTestCollageLayer(point: Position, source: CollageSize, transform: CollageTransform): boolean {
    const { halfWidth, halfHeight } = collageLayerExtent(source, transform);
    const local = collageToLocal(point, transform);
    return Math.abs(local.x) <= halfWidth && Math.abs(local.y) <= halfHeight;
}

/** 取命中点最上层的图层；层序数组末尾在最上层。 */
export function topmostCollageLayer(point: Position, order: string[], layout: CollageLayout, sources: Record<string, CollageSize>): string | null {
    for (let index = order.length - 1; index >= 0; index -= 1) {
        const id = order[index];
        const transform = layout[id];
        const source = sources[id];
        if (!id || !transform || !source) continue;
        if (hitTestCollageLayer(point, source, transform)) return id;
    }
    return null;
}

export function moveCollageLayer(transform: CollageTransform, dx: number, dy: number): CollageTransform {
    return clampCollageTransform({ ...transform, x: transform.x + dx, y: transform.y + dy });
}

/** 图层中心指向某点的角度（度），旋转手柄用它换算拖拽角度。 */
export function collageAngleFromCenter(point: Position, transform: CollageTransform): number {
    return (Math.atan2(point.y - transform.y, point.x - transform.x) * 180) / Math.PI;
}

/** 按角度增量旋转；结果收敛到 −180…180，避免角度无限增长。 */
export function rotateCollageLayer(transform: CollageTransform, deltaDegrees: number): CollageTransform {
    let rotation = transform.rotation + deltaDegrees;
    while (rotation > COLLAGE_ROTATION_LIMIT) rotation -= COLLAGE_ROTATION_LIMIT * 2;
    while (rotation < -COLLAGE_ROTATION_LIMIT) rotation += COLLAGE_ROTATION_LIMIT * 2;
    return clampCollageTransform({ ...transform, rotation });
}

export type CollageDragMode = {
    /** 保持当前拉伸比例，等比缩放（Shift）。 */
    keepRatio?: boolean;
    /** 以对角为锚点缩放而不是以中心（Alt）。 */
    anchorOpposite?: boolean;
};

/**
 * 拖动某个角手柄缩放/拉伸图层。
 *
 * 默认以中心为锚点：把鼠标点反旋转回局部坐标后，它到中心的距离就是新的半宽/半高。
 * keepRatio 时保留当前 stretchX:stretchY 的比例，整体乘同一个系数。
 *
 * 半宽取绝对值是刻意的：把角拖过中心时图层会翻到另一侧继续放大，而不是负尺寸翻转，
 * 到中心的距离本身也不该带符号。
 */
export function stretchCollageLayer(source: CollageSize, transform: CollageTransform, corner: CollageCorner, point: Position, mode: CollageDragMode = {}): CollageTransform {
    const cos = cosine(transform.rotation);
    const sin = sine(transform.rotation);
    const local = collageToLocal(point, transform);
    const current = { x: Math.abs(local.x) / Math.max(1e-6, (source.width / 2) * transform.scale), y: Math.abs(local.y) / Math.max(1e-6, (source.height / 2) * transform.scale) };
    let nextX = Math.max(COLLAGE_STRETCH_MIN, current.x);
    let nextY = Math.max(COLLAGE_STRETCH_MIN, current.y);
    if (mode.keepRatio && current.x > 0 && current.y > 0) {
        const factor = (current.x / transform.stretchX + current.y / transform.stretchY) / 2;
        nextX = transform.stretchX * factor;
        nextY = transform.stretchY * factor;
    }
    // 以对角为锚点：锚点在局部坐标里固定不动，缩放后的中心落在锚点与鼠标点的中点。
    let center = { x: transform.x, y: transform.y };
    if (mode.anchorOpposite) {
        const half = collageLayerExtent(source, transform);
        const anchorLocal = { x: -corner.x * half.halfWidth, y: -corner.y * half.halfHeight };
        const halfX = Math.abs(local.x - anchorLocal.x) / 2;
        const halfY = Math.abs(local.y - anchorLocal.y) / 2;
        const midLocal = { x: (anchorLocal.x + local.x) / 2, y: (anchorLocal.y + local.y) / 2 };
        center = { x: transform.x + midLocal.x * cos - midLocal.y * sin, y: transform.y + midLocal.x * sin + midLocal.y * cos };
        nextX = Math.max(COLLAGE_STRETCH_MIN, halfX / Math.max(1e-6, (source.width / 2) * transform.scale));
        nextY = Math.max(COLLAGE_STRETCH_MIN, halfY / Math.max(1e-6, (source.height / 2) * transform.scale));
    }
    return clampCollageTransform({ ...transform, x: center.x, y: center.y, stretchX: nextX, stretchY: nextY });
}

/** 画布上的预览缩放系数：把拼合画布等比缩到不超过 max 边长。 */
export function fitCollagePreview(scene: CollageSize, max = COLLAGE_PREVIEW_MAX): number {
    return Math.min(1, max / Math.max(scene.width, scene.height));
}

/** 层序调整：上移/下移一格，或直接置顶/置底。 */
export function reorderCollageLayers(order: string[], id: string, action: "up" | "down" | "top" | "bottom"): string[] {
    const index = order.indexOf(id);
    if (index < 0) return order;
    const next = order.filter((item) => item !== id);
    const target = action === "top" ? next.length : action === "bottom" ? 0 : action === "up" ? Math.min(next.length, index + 1) : Math.max(0, index - 1);
    next.splice(target, 0, id);
    return next;
}

/**
 * 从画布连线里取出拼合节点的图层来源：按连线顺序最多 10 张图片。
 *
 * 图层尺寸优先用图片原始像素，缺失时退化成节点显示尺寸，
 * 这样即使图片还没解码，布局和绘制也能先算出一致的尺寸。
 */
export function collectCollageSources(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const picked: CanvasNodeData[] = [];
    for (const connection of connections) {
        if (connection.toNodeId !== nodeId || connection.toPortId !== COLLAGE_SOURCE_PORT_ID) continue;
        if (picked.some((item) => item.id === connection.fromNodeId)) continue;
        const source = nodes.find((item) => item.id === connection.fromNodeId);
        if (!source || source.type !== CanvasNodeType.Image || !source.metadata?.content) continue;
        picked.push(source);
        if (picked.length >= COLLAGE_MAX_LAYERS) break;
    }
    return picked.map((node) => ({
        id: node.id,
        title: node.title || "",
        url: node.metadata!.content!,
        width: Math.max(1, node.metadata?.naturalWidth || node.width),
        height: Math.max(1, node.metadata?.naturalHeight || node.height),
    }));
}
