/**
 * 响应字段取值。
 *
 * 各服务商把结果放在不同位置，且同一家的不同接口也不一致。统一用点分路径表达，
 * 数字键在数组上取下标（choices.0.message.content、data.0.b64_json）。
 */

/** 按点分路径取值；取不到返回 undefined，不抛错。 */
export function getByPath(value: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((acc, key) => {
        if (acc === null || acc === undefined) return undefined;
        if (Array.isArray(acc)) return acc[Number(key)];
        if (typeof acc === "object") return (acc as Record<string, unknown>)[key];
        return undefined;
    }, value);
}

/** 依次尝试多个路径，返回第一个非空结果。 */
export function pickByPaths(value: unknown, paths: string[]): unknown {
    for (const path of paths) {
        const found = getByPath(value, path);
        if (found !== undefined && found !== null && found !== "") return found;
    }
    return undefined;
}

/** 图片列表常见的几种外层结构。 */
export const IMAGE_LIST_PATHS = ["data", "images", "output.images", "result.images", "data.images", "result.data", "output.data"];

/** 图片条目里表示「一张图」的字段名，按可靠性排序。 */
export const IMAGE_ITEM_KEYS = ["url", "image_url", "image", "remote_url", "b64_json", "base64", "b64"];

/** 把 base64 统一成 data URL，方便下游直接当图片地址用。 */
export function toImageDataUrl(value: string) {
    if (/^(data:|https?:|blob:)/i.test(value)) return value;
    return `data:image/png;base64,${value}`;
}

/** 从单个图片条目里取出可用的图片地址；取不到返回空串。 */
export function imageUrlFromItem(item: unknown): string {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    if (typeof record.dataUrl === "string") return record.dataUrl;
    for (const key of IMAGE_ITEM_KEYS) {
        const value = record[key];
        if (typeof value === "string" && value) {
            return /^https?:|^data:|^blob:/i.test(value) ? value : toImageDataUrl(value);
        }
    }
    return "";
}
