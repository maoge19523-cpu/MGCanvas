// 「当前画布」= 用户最近打开的画布项目。剪辑台的左侧导航入口没有项目 id，
// 需要靠这个记录下来才能回到同一块画布；只存一个 id，属于极小的本地配置。
const CURRENT_CANVAS_KEY = "mgcanvas:current-canvas";

export function rememberCurrentCanvas(projectId: string) {
    if (typeof window === "undefined" || !projectId) return;
    try {
        window.localStorage.setItem(CURRENT_CANVAS_KEY, projectId);
    } catch {
        // 隐私模式等场景下写不进去，不影响画布本身。
    }
}

export function readCurrentCanvas() {
    if (typeof window === "undefined") return "";
    try {
        return window.localStorage.getItem(CURRENT_CANVAS_KEY) || "";
    } catch {
        return "";
    }
}
