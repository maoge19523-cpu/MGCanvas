import { Modal } from "antd";
import { Columns2, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { clampComparePosition, stepComparePosition } from "@/lib/canvas/compare-sources";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

type CompareSource = {
    url: string;
    label: string;
};

/**
 * 左右滑动分割对比：右图铺底，左图按分割位置裁剪。
 *
 * 这里给左图用 clip-path 而不是收窄它的宽度，是因为裁剪时图片本身必须保持满幅，
 * 否则拖动分割线会看到左图跟着被压扁。也刻意不用 canvas：纯 CSS 更清晰、更好维护。
 */
function CompareSplitView({ left, right, position, onPositionChange, large }: { left: CompareSource; right: CompareSource; position: number; onPositionChange: (value: number) => void; large?: boolean }) {
    const frameRef = useRef<HTMLDivElement>(null);

    const updateFromClientX = useCallback(
        (clientX: number) => {
            const rect = frameRef.current?.getBoundingClientRect();
            if (!rect?.width) return;
            onPositionChange(clampComparePosition(((clientX - rect.left) / rect.width) * 100));
        },
        [onPositionChange],
    );

    /**
     * 按下即开始拖：整幅图任意位置、分割线的透明横扫区、中间的把手都能起手。
     *
     * 指针捕获挂在整幅 frame 上，手滑出把手后仍然跟手；stopPropagation 防止落到
     * 节点拖拽或画布平移上，所以这里不需要按住 Ctrl 之类的修饰键。
     */
    const startDrag = (event: React.PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        const frame = frameRef.current;
        if (!frame) return;
        frame.setPointerCapture(event.pointerId);
        updateFromClientX(event.clientX);
    };

    const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const labelClass = "pointer-events-none absolute top-2 rounded-full bg-black/55 px-2 py-0.5 font-medium text-white";

    return (
        <div
            ref={frameRef}
            data-canvas-no-zoom
            className="relative h-full w-full cursor-ew-resize select-none overflow-hidden"
            onPointerDown={startDrag}
            onPointerMove={(event) => {
                if (event.buttons !== 1) return;
                event.stopPropagation();
                updateFromClientX(event.clientX);
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
        >
            <img src={right.url} alt={right.label} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
            <img src={left.url} alt={left.label} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} />

            <span className={`${labelClass} left-2`} style={{ fontSize: large ? 13 : 10 }}>
                {left.label}
            </span>
            <span className={`${labelClass} right-2`} style={{ fontSize: large ? 13 : 10 }}>
                {right.label}
            </span>

            {/* 透明横扫区：鼠标移到分割线附近就能左右拖；不按住按键时也跟随鼠标，直接左右滑动对比。 */}
            <div
                className="absolute inset-y-0 z-10 -ml-2 w-4 cursor-ew-resize"
                style={{ left: `${position}%` }}
                onPointerDown={startDrag}
                onPointerMove={(event) => {
                    if (event.buttons !== 0) return;
                    event.stopPropagation();
                    updateFromClientX(event.clientX);
                }}
            />
            <div className="pointer-events-none absolute inset-y-0 w-px bg-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.35)]" style={{ left: `${position}%` }} />
            <span
                className="absolute top-1/2 z-10 grid cursor-ew-resize place-items-center rounded-full bg-white text-stone-700 shadow-[0_2px_10px_rgba(0,0,0,.35)]"
                style={{ left: `${position}%`, width: large ? 34 : 22, height: large ? 34 : 22, transform: "translate(-50%, -50%)" }}
                onPointerDown={startDrag}
            >
                <Columns2 style={{ width: large ? 18 : 12, height: large ? 18 : 12 }} />
            </span>
        </div>
    );
}

function compareSourcesOf(sources: CanvasNodeData[]): [CompareSource | null, CompareSource | null] {
    const toSource = (node: CanvasNodeData | undefined, fallback: string): CompareSource | null => (node?.metadata?.content ? { url: node.metadata.content, label: node.title || fallback } : null);
    return [toSource(sources[0], "A"), toSource(sources[1], "B")];
}

/**
 * 画布上的对比节点：把连进来的前两张图左右滑动对比，双击进全屏。
 *
 * 连线由页面解析后作为 sources 传入，节点本身不直接读画布状态。
 */
export function CanvasCompareNodeContent({ node, sources }: { node: CanvasNodeData; sources: CanvasNodeData[] }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];    const [position, setPosition] = useState(50);
    const [fullscreen, setFullscreen] = useState(false);
    const [left, right] = compareSourcesOf(sources);

    // 全屏里用左右键微调，Shift 加速，方便把分割线对齐到同一个位置做逐像素比对。
    useEffect(() => {
        if (!fullscreen) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setPosition((value) => stepComparePosition(value, event.key === "ArrowLeft" ? -1 : 1, event.shiftKey));
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [fullscreen]);

    if (!left) return <CompareNodeHint node={node} />;
    // 只连了一张图时退化成单图预览，不画分隔线，避免让人以为少了一张。
    if (!right) return <img src={left.url} alt={left.label} draggable={false} className="pointer-events-none h-full w-full object-contain" />;

    return (
        <div className="group/compare relative h-full w-full cursor-zoom-in" onDoubleClick={(event) => { event.stopPropagation(); setFullscreen(true); }}>
            <CompareSplitView left={left} right={right} position={position} onPositionChange={setPosition} />
            <span className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white opacity-0 transition group-hover/compare:opacity-100">
                <Maximize2 className="size-3" />
                {t("canvas.compare.fullscreen")}
            </span>

            <Modal open={fullscreen} onCancel={() => setFullscreen(false)} footer={null} title={node.title || t("canvas.nodeTypes.compare")} width={1120} centered destroyOnHidden styles={{ body: { padding: 0 } }}>
                <div className="h-[70vh] w-full overflow-hidden rounded-xl bg-[#0b0d10]">
                    <CompareSplitView left={left} right={right} position={position} onPositionChange={setPosition} large />
                </div>
                <p className="mt-3 text-center text-xs" style={{ color: theme.node.placeholder }}>{t("canvas.compare.keyboardHint")}</p>
            </Modal>
        </div>
    );
}

/** 没有连够两张图时的占位：不显示空框，直接说清楚该连什么。 */
export function CompareNodeHint({ node }: { node?: CanvasNodeData }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-5 text-center" style={{ color: theme.node.placeholder }}>
            <Columns2 className="size-9 opacity-35" />
            <span className="text-sm">{t("canvas.compare.hint")}</span>
            <span className="text-[11px] opacity-60">{t("canvas.compare.hintMore")}</span>
        </div>
    );
}
