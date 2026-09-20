import { Modal } from "antd";
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Loader2, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
    COLLAGE_MAX_LAYERS,
    COLLAGE_ROTATE_OFFSET,
    collageAngleFromCenter,
    collageHandlePoints,
    createCollageLayout,
    fitCollagePreview,
    moveCollageLayer,
    reorderCollageLayers,
    rotateCollageLayer,
    stretchCollageLayer,
    topmostCollageLayer,
    type CollageCorner,
    type CollageLayout,
    type CollageTransform,
} from "@/lib/canvas/collage-layout";
import { drawCollageScene, renderCollageDataUrl } from "@/lib/canvas/collage-scene";
import { useCollageScene, type CollageSourceEntry } from "@/lib/canvas/use-collage-scene";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData, Position } from "@/types/canvas";

type Snapshot = { layout: CollageLayout; order: string[] };
type DragState =
    | { kind: "move"; id: string; start: Position; origin: CollageTransform }
    | { kind: "rotate"; id: string; startAngle: number; origin: CollageTransform }
    | { kind: "corner"; id: string; corner: CollageCorner; origin: CollageTransform };

/** 编辑器视口最大边长与手柄命中半径（都按场景坐标换算后的像素算）。 */
const VIEW_MAX = 680;
const HANDLE_HIT = 14;
const HISTORY_LIMIT = 50;

export function CanvasCollageEditor({
    open,
    node,
    sources,
    saving,
    onClose,
    onCommit,
    onSave,
}: {
    open: boolean;
    node: CanvasNodeData | null;
    sources: CollageSourceEntry[];
    saving?: boolean;
    onClose: () => void;
    onCommit: (layout: CollageLayout, order: string[]) => void;
    onSave: (dataUrl: string, layout: CollageLayout, order: string[]) => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const scene_ = useCollageScene(node ?? undefined, sources);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<DragState | null>(null);
    const [selection, setSelection] = useState<string | null>(null);
    const [state, setState] = useState<{ entries: Snapshot[]; cursor: number }>({ entries: [{ layout: {}, order: [] }], cursor: 0 });

    const scale = fitCollagePreview(scene_.scene, VIEW_MAX);
    const width = Math.max(1, Math.round(scene_.scene.width * scale));
    const height = Math.max(1, Math.round(scene_.scene.height * scale));
    const current = state.entries[state.cursor] ?? { layout: {}, order: [] };

    // 打开时把节点上存的布局读进编辑器；连线变化时新图层由 useCollageScene 补齐。
    useEffect(() => {
        if (!open) return;
        setState({ entries: [{ layout: scene_.layout, order: scene_.order }], cursor: 0 });
        setSelection(scene_.order[scene_.order.length - 1] ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, node?.id]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !open) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        // 只有编辑器会传 selection，因此选中框只出现在这里，不会进保存的像素。
        drawCollageScene(ctx, { order: current.order, layout: current.layout, images: scene_.images, sources: scene_.sourceSizes, scene: scene_.scene, scale, selection, selectionColor: "#2f80ff", showHandles: true });
    }, [current, scene_, scale, width, height, selection, open]);

    const apply = useCallback((next: Snapshot, coalesce = false) => {
        setState((prev) => {
            const entries = prev.entries.slice(0, prev.cursor + 1);
            if (coalesce && entries.length) entries[entries.length - 1] = next;
            else entries.push(next);
            const trimmed = entries.length > HISTORY_LIMIT ? entries.slice(entries.length - HISTORY_LIMIT) : entries;
            return { entries: trimmed, cursor: trimmed.length - 1 };
        });
    }, []);

    const undo = useCallback(() => setState((prev) => ({ ...prev, cursor: Math.max(0, prev.cursor - 1) })), []);
    const redo = useCallback(() => setState((prev) => ({ ...prev, cursor: Math.min(prev.entries.length - 1, prev.cursor + 1) })), []);

    // 快捷键：Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 重做、方向键微调、Esc 交给 Modal 关闭。
    useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            const meta = event.metaKey || event.ctrlKey;
            if (meta && event.key.toLowerCase() === "z") {
                event.preventDefault();
                if (event.shiftKey) redo();
                else undo();
                return;
            }
            if (!selection || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1;
            const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
            const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
            const origin = current.layout[selection];
            if (!origin) return;
            apply({ layout: { ...current.layout, [selection]: moveCollageLayer(origin, dx, dy) }, order: current.order }, true);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, selection, current, apply, undo, redo]);

    // 一律用 canvas 元素自己的 rect 换算：舞台比画布大、画布还居中，用舞台坐标会整体偏移。
    const canvasRect = useCallback(() => canvasRef.current?.getBoundingClientRect() ?? null, []);

    const toScenePoint = useCallback(
        (event: React.PointerEvent): Position => {
            const rect = canvasRect();
            if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
            return { x: ((event.clientX - rect.left) / rect.width) * scene_.scene.width, y: ((event.clientY - rect.top) / rect.height) * scene_.scene.height };
        },
        [canvasRect, scene_.scene],
    );

    /** 屏幕上 14px 对应多少场景单位；画布被 CSS 缩放过时也照样准。 */
    const hitRadius = useCallback(() => {
        const rect = canvasRect();
        return HANDLE_HIT / (rect && rect.width ? rect.width / scene_.scene.width : scale);
    }, [canvasRect, scale, scene_.scene]);

    const onPointerDown = (event: React.PointerEvent) => {
        if (!selection) {
            dragRef.current = null;
        }
        const point = toScenePoint(event);
        const order = current.order;
        const sizes = scene_.sourceSizes;

        // 手柄优先于图层命中：先把鼠标点反旋转回局部坐标，再按距离判断。
        const selectedTransform = selection ? current.layout[selection] : undefined;
        const selectedSource = selection ? sizes[selection] : undefined;
        if (selection && selectedTransform && selectedSource) {
            // 手柄命中判定和绘制取同一份坐标，只在场景坐标系里比距离，避免旋转后再算错象限。
            const handleRadius = hitRadius();
            const { corners, rotate } = collageHandlePoints(selectedSource, selectedTransform, COLLAGE_ROTATE_OFFSET / scale, scene_.scene);
            const cornerOrder: CollageCorner[] = [
                { x: -1, y: -1 },
                { x: 1, y: -1 },
                { x: 1, y: 1 },
                { x: -1, y: 1 },
            ];
            for (let index = 0; index < corners.length; index += 1) {
                if (Math.hypot(point.x - corners[index].x, point.y - corners[index].y) <= handleRadius) {
                    dragRef.current = { kind: "corner", id: selection, corner: cornerOrder[index], origin: selectedTransform };
                    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
                    return;
                }
            }
            if (Math.hypot(point.x - rotate.x, point.y - rotate.y) <= handleRadius) {
                dragRef.current = { kind: "rotate", id: selection, startAngle: collageAngleFromCenter(point, selectedTransform), origin: selectedTransform };
                (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
                return;
            }
        }

        const hit = topmostCollageLayer(point, order, current.layout, sizes);
        setSelection(hit);
        const origin = hit ? current.layout[hit] : undefined;
        dragRef.current = hit && origin ? { kind: "move", id: hit, start: point, origin } : null;
        if (hit) (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const point = toScenePoint(event);
        const source = scene_.sourceSizes[drag.id];
        if (!source) return;
        if (drag.kind === "move") {
            apply({ layout: { ...current.layout, [drag.id]: moveCollageLayer(drag.origin, point.x - drag.start.x, point.y - drag.start.y) }, order: current.order }, true);
            return;
        }
        if (drag.kind === "rotate") {
            apply({ layout: { ...current.layout, [drag.id]: rotateCollageLayer(drag.origin, collageAngleFromCenter(point, drag.origin) - drag.startAngle) }, order: current.order }, true);
            return;
        }
        apply(
            {
                layout: { ...current.layout, [drag.id]: stretchCollageLayer(source, drag.origin, drag.corner, point, { keepRatio: event.shiftKey, anchorOpposite: event.altKey }) },
                order: current.order,
            },
            true,
        );
    };

    const endDrag = (event: React.PointerEvent) => {
        if (dragRef.current) (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
        dragRef.current = null;
    };

    const moveLayer = (id: string, action: "up" | "down" | "top" | "bottom") => apply({ layout: current.layout, order: reorderCollageLayers(current.order, id, action) });
    const resetLayout = () => {
        const next = createCollageLayout(sources);
        apply(next);
        setSelection(next.order[next.order.length - 1] ?? null);
    };
    const titleOf = (id: string) => sources.find((source) => source.id === id)?.title || t("canvas.nodeTypes.image");

    return (
        <Modal
            open={open}
            onCancel={() => {
                onCommit(current.layout, current.order);
                onClose();
            }}
            footer={null}
            title={t("canvas.collage.title")}
            width={1180}
            centered
            destroyOnHidden
            styles={{ body: { padding: 0 } }}
        >
            <div className="flex min-h-0 gap-4">
                <div ref={stageRef} className="relative flex flex-1 items-center justify-center overflow-hidden rounded-xl" style={{ background: theme.node.fill, minHeight: 480, touchAction: "none" }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
                    <canvas ref={canvasRef} style={{ width, height }} className="block max-h-full max-w-full" />
                </div>

                <div className="flex w-72 shrink-0 flex-col gap-3">
                    <div>
                        <p className="mb-1.5 px-1 text-xs font-medium" style={{ color: theme.node.placeholder }}>
                            {t("canvas.collage.layers", { used: current.order.length, max: COLLAGE_MAX_LAYERS })}
                        </p>
                        <div className="flex flex-col gap-1">
                            {current.order
                                .slice()
                                .reverse()
                                .map((id) => (
                                    <div key={id} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs" style={{ background: selection === id ? theme.toolbar.activeBg : "transparent", color: theme.node.text }} onClick={() => setSelection(id)}>
                                        <span className="min-w-0 flex-1 truncate" title={id}>
                                            {titleOf(id)}
                                        </span>
                                        <button type="button" className="rounded p-0.5 hover:bg-black/10" title={t("canvas.collage.bringForward")} onClick={(event) => (event.stopPropagation(), moveLayer(id, "up"))}>
                                            <ArrowUp className="size-3.5" />
                                        </button>
                                        <button type="button" className="rounded p-0.5 hover:bg-black/10" title={t("canvas.collage.sendBackward")} onClick={(event) => (event.stopPropagation(), moveLayer(id, "down"))}>
                                            <ArrowDown className="size-3.5" />
                                        </button>
                                        <button type="button" className="rounded p-0.5 hover:bg-black/10" title={t("canvas.collage.toTop")} onClick={(event) => (event.stopPropagation(), moveLayer(id, "top"))}>
                                            <ChevronsUp className="size-3.5" />
                                        </button>
                                        <button type="button" className="rounded p-0.5 hover:bg-black/10" title={t("canvas.collage.toBottom")} onClick={(event) => (event.stopPropagation(), moveLayer(id, "bottom"))}>
                                            <ChevronsDown className="size-3.5" />
                                        </button>
                                    </div>
                                ))}
                        </div>
                    </div>

                    <p className="px-1 text-[11px] leading-relaxed" style={{ color: theme.node.placeholder }}>
                        {t("canvas.collage.tips")}
                    </p>

                    <div className="mt-auto flex flex-col gap-2">
                        <div className="flex gap-2">
                            <button type="button" disabled={state.cursor <= 0} onClick={undo} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium disabled:opacity-40" style={{ background: theme.toolbar.activeBg, color: theme.node.text }}>
                                <Undo2 className="size-3.5" />
                                {t("canvas.collage.undo")}
                            </button>
                            <button type="button" disabled={state.cursor >= state.entries.length - 1} onClick={redo} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium disabled:opacity-40" style={{ background: theme.toolbar.activeBg, color: theme.node.text }}>
                                <Redo2 className="size-3.5" />
                                {t("canvas.collage.redo")}
                            </button>
                        </div>
                        <button type="button" onClick={resetLayout} className="flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium" style={{ background: theme.toolbar.activeBg, color: theme.node.text }}>
                            <RotateCcw className="size-3.5" />
                            {t("canvas.collage.reset")}
                        </button>
                        <button
                            type="button"
                            disabled={saving || !sources.length}
                            onClick={() => {
                                const dataUrl = renderCollageDataUrl({ order: current.order, layout: current.layout, images: scene_.images, sources: scene_.sourceSizes, scene: scene_.scene });
                                if (dataUrl) onSave(dataUrl, current.layout, current.order);
                            }}
                            className="flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-medium text-white disabled:opacity-50"
                            style={{ background: "#2f80ff" }}
                        >
                            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                            {t("canvas.collage.save")}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
