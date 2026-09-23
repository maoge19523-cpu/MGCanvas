import localforage from "localforage";

import { BUILTIN_STYLE_PROMPTS } from "./builtin-prompt-styles";

/**
 * 风格封面。
 *
 * 风格数据打包在程序里，封面却是用出来的：用户给某个风格配一张图（自己挑的或刚生成的），
 * 之后风格馆里那张卡片就显示它。封面按风格 id 存在本机，读取时合并进内置数据。
 *
 * 存进去的一定是压缩后的小图，不要把原图或大 base64 塞进本地存储。
 */
export type StyleCoverMap = Record<string, string>;

const store = localforage.createInstance({ name: "mgcanvas", storeName: "style_covers" });
const STORE_KEY = "covers";
const COVER_SIZE = 320;
const MAX_BYTES = 400 * 1024;

export async function readStyleCovers(): Promise<StyleCoverMap> {
    const value = await store.getItem<unknown>(STORE_KEY);
    if (!value || typeof value !== "object") return {};
    const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].startsWith("data:image/"));
    return Object.fromEntries(entries);
}

/** 存封面并返回最新的整张表，调用方可以直接拿来更新界面。 */
export async function saveStyleCover(styleId: string, cover: string): Promise<StyleCoverMap> {
    const covers = await readStyleCovers();
    const next = { ...covers, [styleId]: cover };
    await store.setItem(STORE_KEY, next);
    return next;
}

export async function clearStyleCover(styleId: string): Promise<StyleCoverMap> {
    const covers = await readStyleCovers();
    delete covers[styleId];
    await store.setItem(STORE_KEY, covers);
    return covers;
}

let pendingStyleId = "";

/**
 * 选中风格时记下是哪一个。
 * 面板只把提示词文本传出来，所以这里按文本反查内置风格，省掉一路透传 id 的改动。
 */
export function markPendingStyle(prompt: string) {
    const found = BUILTIN_STYLE_PROMPTS.find((item) => prompt.includes(item.prompt));
    pendingStyleId = found?.id || "";
}

/**
 * 这次生成出图后把图存成刚选那个风格的封面。
 * 取走即清空：同一次选择只影响紧接着的一次生成，之后与风格无关的图不会被误当封面。
 * 已有封面的风格不覆盖，用户手动挑过的封面优先。
 */
export async function captureStyleCover(dataUrl: string) {
    const styleId = pendingStyleId;
    pendingStyleId = "";
    if (!styleId || !dataUrl.startsWith("data:image/")) return;
    try {
        const covers = await readStyleCovers();
        if (covers[styleId]) return;
        await saveStyleCover(styleId, await compressDataUrl(dataUrl));
    } catch {
        // 封面只是锦上添花，失败不能影响出图本身。
    }
}

/** 把用户挑的图片等比压到小图再返回 dataURL，失败时抛出可直接展示的错误。 */
export function compressStyleCover(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.onload = () => resolve(compressDataUrl(String(reader.result || "")));
        reader.readAsDataURL(file);
    });
}

/**
 * 用 canvas 压缩，避免把几 MB 的原图写进本地存储。
 * 先按 webp 压，浏览器不支持时 canvas 会自动回落到 png。
 */
function compressDataUrl(dataUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!dataUrl.startsWith("data:image/")) {
            reject(new Error("这张图片无法解析"));
            return;
        }
        const image = new Image();
        image.onerror = () => reject(new Error("这张图片无法解析"));
        image.onload = () => {
            const scale = Math.min(1, COVER_SIZE / Math.max(image.width, image.height));
            const width = Math.max(1, Math.round(image.width * scale));
            const height = Math.max(1, Math.round(image.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) {
                reject(new Error("当前环境无法处理图片"));
                return;
            }
            context.drawImage(image, 0, 0, width, height);
            const result = canvas.toDataURL("image/webp", 0.82);
            if (!result.startsWith("data:image/")) {
                reject(new Error("图片转换失败"));
                return;
            }
            if (result.length > MAX_BYTES) {
                reject(new Error("图片压缩后仍然过大，换一张试试"));
                return;
            }
            resolve(result);
        };
        image.src = dataUrl;
    });
}
