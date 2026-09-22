import { createElement, type ComponentType, type ReactNode } from "react";

/**
 * motion 的静态替身：把 motion.div / motion.aside 这类用法换成普通元素，
 * 保留 className、style 等常规属性，忽略 initial / animate / transition / layout 等动画属性。
 *
 * 目的：画布是高频重渲染区域，motion 的布局投影（MeasureLayout）会在 componentDidUpdate 里
 * 重新测量并在微任务回调里改状态，叠加画布自身的更新就会触发 React #185 渲染循环。
 * 换成静态元素后这条链路不再存在。
 */
function createStatic(tag: string) {
    const Component = ({ children, ...props }: Record<string, unknown>) => {
        const clean: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
            if (key.startsWith("on") || ["className", "style", "id", "title", "role", "aria-hidden", "aria-label", "data-canvas-no-zoom"].includes(key)) {
                clean[key] = value;
            }
        }
        return createElement(tag, clean, children as ReactNode);
    };
    Component.displayName = `StaticMotion(${tag})`;
    return Component as ComponentType<Record<string, unknown>>;
}

export const motion = new Proxy({} as Record<string, ComponentType<Record<string, unknown>>>, {
    get: (_target, tag: string) => createStatic(tag),
});
