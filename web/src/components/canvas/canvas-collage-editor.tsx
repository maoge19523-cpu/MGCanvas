import { Modal } from "antd";
import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Loader2, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
    COLLAGE_MAX_LAYERS,
    collageAngleFromCenter,
    collageLayerCorners,
    collageToLocal,
    createCollageLayout,
    fitCollagePreview,
    hitTestCollageLayer,
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
const ROTATE_OFFSET = 34;
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
        drawCollageScene(ctx, { order: current.order, layout: current.layout, images: scene_.images, sources: scene_.sourceSizes, scene: scene_.scene, scale, selection, selectionColor: "#2f80ff" });
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

    const toScenePoint = useCallback(
        (event: React.PointerEvent): Position => {
            const rect = stageRef.current?.getBoundingClientRect();
            if (!rect) return { x: 0, y: 0 };
            return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
        },
        [scale],
    );

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
            const local = collageToLocal(point, selectedTransform);
            const handleRadius = HANDLE_HIT / scale;
            const half = { x: (selectedSource.width / 2) * selectedTransform.scale * selectedTransform.stretchX, y: (selectedSource.height / 2) * selectedTransform.scale * selectedTransform.stretchY };
            for (const corner of [
                { x: -1, y: -1 },
                { x: 1, y: -1 },
                { x: 1, y: 1 },
                { x: -1, y: 1 },
            ] as CollageCorner[]) {
                if (Math.hypot(local.x - corner.x * half.x, local.y - corner.y * half.y) <= handleRadius) {
                    dragRef.current = { kind: "corner", id: selection, corner, origin: selectedTransform };
                    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
                    return;
                }
            }
            if (Math.hypot(local.x, local.y + half.y + ROTATE_OFFSET / scale) <= handleRadius) {
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
    const titleOf = (id: string) => sources.find((source) => source.id === id)?.url.split("/").pop()?.split("?")[0] || id;

    // 选中图层的手柄位置：四角 + 上边中点外侧的旋转柄，全部按当前旋转角摆正。
    const handles = useMemo(() => {
        if (!selection) return null;
        const transform = current.layout[selection];
        const source = scene_.sourceSizes[selection];
        if (!transform || !source) return null;
        const corners = collageLayerCorners(source, transform);
        const local = collageToLocal({ x: corners[0].x, y: corners[0].y }, transform);
        const half = { x: Math.abs(local.x), y: Math.abs(local.y) };
        const topMiddle = { x: 0, y: -half.y - ROTATE_OFFSET / scale };
        const cos = Math.cos((transform.rotation * Math.PI) / 180);
        const sin = Math.sin((transform.rotation * Math.PI) / 180);
        const rotate = { x: transform.x + topMiddle.x * cos - topMiddle.y * sin, y: transform.y + topMiddle.x * sin + topMiddle.y * cos };
        return { corners, rotate };
    }, [selection, current, scene_, scale]);

    const cornerStyle = "pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border shadow";

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
                    {handles ? (
                        <>
                            {handles.corners.map((corner, index) => (
                                <span key={index} className={cornerStyle} style={{ left: corner.x * scale, top: corner.y * scale, width: 12, height: 12, background: "#fff", borderColor: "#2f80ff" }} />
                            ))}
                            <span className={cornerStyle} style={{ left: handles.rotate.x * scale, top: handles.rotate.y * scale, width: 12, height: 12, borderRadius: 999, background: "#fff", borderColor: "#2f80ff" }} />
                        </>
                    ) : null}
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
