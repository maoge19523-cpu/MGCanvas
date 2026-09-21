import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from "react";

export type CanvasNodePopupPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

type CanvasNodeAnchoredPopupProps = {
    open: boolean;
    anchorRef: RefObject<HTMLElement | null>;
    panelRef: RefObject<HTMLDivElement | null>;
    placement?: CanvasNodePopupPlacement;
    width?: number;
    height?: number;
    maxHeight?: number;
    gap?: number;
    flipVertical?: boolean;
    anchorRect?: DOMRect | null;
    /**
     * 渲染到 body 并用固定定位。
     *
     * 默认把弹出层挂在节点内部，好处是自动跟随画布缩放，代价是它会被节点的层叠上下文关住，
     * 节点上方那条悬浮工具条总能压住它。画布层级的先后顺序改起来牵一发动全身，需要绝对
     * 压在上层的面板（音频设置这类）改用固定定位，直接跳到 body 层，用屏幕坐标定位。
     */
    fixed?: boolean;
    className?: string;
    style?: CSSProperties;
    popupProps?: HTMLAttributes<HTMLDivElement>;
    children: ReactNode;
};

type PopupPosition = {
    container: HTMLElement;
    fixed: boolean;
    left: number;
    top: number;
    width: number;
    maxHeight: number;
    translateY?: string;
};

/** 固定定位时的“容器矩形”，即整个视口左上角，配合屏幕坐标直接得到 left/top。 */
const FIXED_VIEWPORT_RECT = { left: 0, top: 0 } as DOMRect;

export function getCanvasNodePopupContainer(triggerNode: HTMLElement) {
    return triggerNode.closest<HTMLElement>("[data-node-id]") || document.body;
}

export function CanvasNodeAnchoredPopup({
    open,
    anchorRef,
    panelRef,
    placement = "topLeft",
    width = 356,
    height,
    maxHeight: requestedMaxHeight = 620,
    gap = 8,
    flipVertical = false,
    anchorRect,
    fixed = false,
    className,
    style,
    popupProps,
    children,
}: CanvasNodeAnchoredPopupProps) {
    const [position, setPosition] = useState<PopupPosition | null>(null);

    useLayoutEffect(() => {
        if (!open || !anchorRef.current) {
            setPosition(null);
            return;
        }

        const anchor = anchorRef.current;
        const container = fixed ? document.body : getCanvasNodePopupContainer(anchor);
        const sync = () => {
            const measuredAnchorRect = anchorRect || anchor.getBoundingClientRect();
            // 固定定位直接用屏幕坐标：不参与画布缩放，也不受任何层叠上下文限制。
            const containerRect = fixed ? FIXED_VIEWPORT_RECT : container.getBoundingClientRect();
            const scaleX = fixed ? 1 : container.offsetWidth ? containerRect.width / container.offsetWidth : 1;
            const scaleY = container.offsetHeight ? containerRect.height / container.offsetHeight : scaleX;
            const safeScaleX = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
            const safeScaleY = Number.isFinite(scaleY) && scaleY > 0 ? scaleY : safeScaleX;
            const localLeft = (measuredAnchorRect.left - containerRect.left) / safeScaleX;
            const localRight = (measuredAnchorRect.right - containerRect.left) / safeScaleX;
            const localTop = (measuredAnchorRect.top - containerRect.top) / safeScaleY;
            const localBottom = (measuredAnchorRect.bottom - containerRect.top) / safeScaleY;
            const popupWidth = Math.min(width, Math.max(160, (window.innerWidth - 24) / safeScaleX));
            const alignRight = placement.endsWith("Right");
            const alignCenter = placement === "top" || placement === "bottom";
            const desiredLeft = alignCenter ? (localLeft + localRight - popupWidth) / 2 : alignRight ? localRight - popupWidth : localLeft;
            const minLeft = (12 - containerRect.left) / safeScaleX;
            const maxLeft = (window.innerWidth - 12 - containerRect.left) / safeScaleX - popupWidth;
            const left = maxLeft >= minLeft ? clamp(desiredLeft, minLeft, maxLeft) : desiredLeft;
            const prefersTop = placement.startsWith("top");
            const availableTop = measuredAnchorRect.top - gap - 8;
            const availableBottom = window.innerHeight - measuredAnchorRect.bottom - gap - 8;
            const minimumComfortHeight = Math.min(requestedMaxHeight, 240) * safeScaleY;
            const topPlacement = flipVertical ? (prefersTop ? !(availableTop < minimumComfortHeight && availableBottom > availableTop) : availableBottom < minimumComfortHeight && availableTop > availableBottom) : prefersTop;
            const availableHeight = topPlacement ? availableTop : availableBottom;
            const maxHeight = Math.max(64, Math.min(requestedMaxHeight, availableHeight / safeScaleY));
            const next = {
                container,
                fixed,
                left,
                top: topPlacement ? localTop - gap : localBottom + gap,
                width: popupWidth,
                maxHeight,
                translateY: topPlacement ? "-100%" : undefined,
            };
            setPosition((current) => (samePosition(current, next) ? current : next));
        };

        sync();
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
        observer?.observe(anchor);
        if (container !== document.body) observer?.observe(container);
        window.addEventListener("resize", sync);
        window.addEventListener("scroll", sync, true);
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", sync);
            window.removeEventListener("scroll", sync, true);
        };
    }, [anchorRect, anchorRef, fixed, flipVertical, gap, open, placement, requestedMaxHeight, width]);

    /**
     * 打开期间把节点容器抬到画布层所有浮层之上，但仍低于 antd 弹窗（1000）。
     *
     * 弹出层虽然写了 z-index 1200，但它渲染在节点内部，会被节点自身的 z-index（选中时 z-50）
     * 关在同一个层叠上下文里，于是作为节点兄弟的悬浮工具条（z-70）永远压在上面，把音频设置
     * 这类面板挡住。只改容器本身的层级，关闭即还原，不影响节点原本的叠放顺序。
     * 取值 999：压过工具条、创建菜单、配置浮层，又不会盖住对话框。
     * 固定定位的面板挂在 body 上，本来就压得住画布，不需要这一手。
     */
    useEffect(() => {
        if (!open || !position || position.fixed) return undefined;
        const container = position.container;
        const previous = container.style.zIndex;
        container.style.zIndex = "999";
        return () => {
            container.style.zIndex = previous;
        };
    }, [open, position]);

    if (!open || !position) return null;
    return createPortal(
        <div
            {...popupProps}
            ref={panelRef}
            data-canvas-node-popup
            className={className}
            style={{
                position: position.fixed ? "fixed" : "absolute",
                zIndex: 1200,
                left: position.left,
                top: position.top,
                width: position.width,
                height: height ? Math.min(height, position.maxHeight) : undefined,
                maxHeight: position.maxHeight,
                transform: position.translateY ? `translateY(${position.translateY})` : undefined,
                transformOrigin: position.translateY ? "bottom" : "top",
                ...style,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            {children}
        </div>,
        position.container,
    );
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function samePosition(current: PopupPosition | null, next: PopupPosition) {
    return Boolean(
        current &&
        current.container === next.container &&
        current.fixed === next.fixed &&
        Math.abs(current.left - next.left) < 0.1 &&
        Math.abs(current.top - next.top) < 0.1 &&
        Math.abs(current.width - next.width) < 0.1 &&
        Math.abs(current.maxHeight - next.maxHeight) < 0.1 &&
        current.translateY === next.translateY,
    );
}
