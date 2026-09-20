import { Layers, Maximize2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { COLLAGE_PREVIEW_MAX, fitCollagePreview } from "@/lib/canvas/collage-layout";
import { drawCollageScene } from "@/lib/canvas/collage-scene";
import { useCollageScene, type CollageSourceEntry } from "@/lib/canvas/use-collage-scene";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * 缩略预览画布：与编辑器和导出共用 drawCollageScene，所见即所得。
 * 这里不传 selection，所以缩略图上不会出现选中框。
 */
function CollagePreviewCanvas({ node, sources }: { node: CanvasNodeData; sources: CollageSourceEntry[] }) {
    const scene_ = useCollageScene(node, sources);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const scale = fitCollagePreview(scene_.scene, COLLAGE_PREVIEW_MAX);
    const width = Math.max(1, Math.round(scene_.scene.width * scale));
    const height = Math.max(1, Math.round(scene_.scene.height * scale));

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        drawCollageScene(ctx, { order: scene_.order, layout: scene_.layout, images: scene_.images, sources: scene_.sourceSizes, scene: scene_.scene, scale });
    }, [scene_, scale, width, height]);

    return <canvas ref={canvasRef} style={{ width, height }} className="pointer-events-none block max-h-full max-w-full select-none object-contain" />;
}

/** 画布上的拼合节点：实时缩略预览，双击进全屏编辑器。 */
export function CanvasCollageNodeContent({ node, sources, onOpen }: { node: CanvasNodeData; sources: CollageSourceEntry[]; onOpen?: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const ready = useMemo(() => sources.length > 0, [sources]);

    if (!ready) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-5 text-center" style={{ color: theme.node.placeholder }}>
                <Layers className="size-9 opacity-35" />
                <span className="text-sm">{t("canvas.collage.hint")}</span>
                <span className="text-[11px] opacity-60">{t("canvas.collage.hintMore")}</span>
            </div>
        );
    }

    return (
        <div
            className="group/collage relative flex h-full w-full cursor-zoom-in items-center justify-center"
            onDoubleClick={(event) => {
                event.stopPropagation();
                onOpen?.();
            }}
        >
            <CollagePreviewCanvas node={node} sources={sources} />
            <span className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white opacity-0 transition group-hover/collage:opacity-100">
                <Maximize2 className="size-3" />
                {t("canvas.collage.edit")}
            </span>
        </div>
    );
}
