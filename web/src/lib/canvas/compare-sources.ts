import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/** 对比节点最多同时看两张图：再多就失去「左右对照」的意义了。 */
export const MAX_COMPARE_SOURCES = 2;

/** 对比节点只认这一个输入端口，端口 id 集中在这里避免和连线判断写散。 */
export const COMPARE_IMAGE_PORT_ID = "images";

/**
 * 取出连进对比节点的图片，按连线顺序取前两张。
 *
 * 对比节点只看图不产出，所以只接受真的带图片内容的图片节点：
 * 连了别的类型或空节点时直接跳过，避免画布上出现半张空白。
 */
export function collectCompareSources(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    const sources: CanvasNodeData[] = [];
    for (const connection of connections) {
        if (connection.toNodeId !== nodeId || connection.toPortId !== COMPARE_IMAGE_PORT_ID) continue;
        const source = nodes.find((item) => item.id === connection.fromNodeId);
        if (!source || source.type !== CanvasNodeType.Image || !source.metadata?.content) continue;
        if (sources.some((item) => item.id === source.id)) continue;
        sources.push(source);
        if (sources.length >= MAX_COMPARE_SOURCES) break;
    }
    return sources;
}

/** 分割位置统一收敛到 2%–98%，拖到边缘时两侧都还留得住一条可抓的边。 */
export function clampComparePosition(value: number) {
    if (!Number.isFinite(value)) return 50;
    return Math.min(98, Math.max(2, Math.round(value)));
}

/** 键盘左右键一次挪 2%，按住 Shift 挪 10%，便于做精确对齐。 */
export function stepComparePosition(value: number, direction: -1 | 1, coarse = false) {
    return clampComparePosition(value + direction * (coarse ? 10 : 2));
}
