import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";

/** 素材引用的 id 前缀：避免与画布节点资源的 id 撞号。 */
export const ASSET_REFERENCE_PREFIX = "asset:";

/** 把「我的素材」里的图片适配成提示词可 @ 引用的候选；label 与生成时解析用的 `@素材名` 完全一致。 */
export function buildAssetMentionReferences(assets: Asset[] = useAssetStore.getState().assets): CanvasResourceReference[] {
    return assets.flatMap((asset) => {
        if (asset.kind !== "image" || !asset.title.trim()) return [];
        return [
            {
                id: `${ASSET_REFERENCE_PREFIX}${asset.id}`,
                source: "asset" as const,
                nodeId: asset.id,
                kind: "image" as const,
                label: `@${asset.title}`,
                title: asset.title,
                previewUrl: asset.coverUrl || asset.data.dataUrl,
                active: true,
            },
        ];
    });
}

/** 画布节点资源优先：同 id 或同标签的素材候选直接丢弃，避免 chip 反查串位。 */
export function mergeMentionReferences(canvasReferences: CanvasResourceReference[], assetReferences: CanvasResourceReference[]) {
    const ids = new Set(canvasReferences.map((item) => item.id));
    const labels = new Set(canvasReferences.map((item) => item.label));
    return canvasReferences.concat(assetReferences.filter((item) => !ids.has(item.id) && !labels.has(item.label)));
}
