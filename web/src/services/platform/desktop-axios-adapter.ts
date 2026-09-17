import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";

import { platformFetch } from "./desktop-runtime";

/**
 * 让 axios 走 Tauri 原生 HTTP。
 *
 * 浏览器直连会被服务商的 CORS 策略拦下（表现为 `Failed to fetch`），
 * 例如智谱 open.bigmodel.cn 不返回跨域许可头；原生层没有这个限制。
 * 仅在桌面端生效，浏览器环境继续使用默认适配器。
 */
export const desktopAxiosAdapter: AxiosAdapter = async (config) => {
    const target = buildRequestUrl(config);
    const response = await platformFetch(target, {
        method: (config.method || "get").toUpperCase(),
        headers: normalizeHeaders(config.headers),
        body: serializeBody(config),
        signal: config.signal as AbortSignal | undefined,
    });
    const data = await readResponseBody(response, config.responseType);
    return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: {},
        config,
    } as AxiosResponse;
};

function buildRequestUrl(config: InternalAxiosRequestConfig) {
    const url = config.url || "";
    const parsed = new URL(url, "http://localhost");
    for (const [key, value] of Object.entries((config.params as Record<string, unknown>) || {})) {
        if (value !== undefined && value !== null) parsed.searchParams.set(key, String(value));
    }
    return parsed.toString();
}

function normalizeHeaders(headers: unknown) {
    const source = headers as { toJSON?: () => Record<string, unknown> } | Record<string, unknown> | undefined;
    const plain = typeof source?.toJSON === "function" ? source.toJSON() : ((source || {}) as Record<string, unknown>);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(plain)) {
        if (value !== undefined && value !== null) result[key] = String(value);
    }
    return result;
}

function serializeBody(config: InternalAxiosRequestConfig) {
    const data = config.data;
    if (data === undefined || (config.method || "get").toLowerCase() === "get") return undefined;
    if (typeof FormData !== "undefined" && data instanceof FormData) return data;
    if (typeof data === "string" || data instanceof Blob || data instanceof ArrayBuffer) return data as BodyInit;
    return JSON.stringify(data);
}

async function readResponseBody(response: Response, responseType: string | undefined) {
    if (responseType === "arraybuffer") return response.arrayBuffer();
    if (responseType === "blob") return response.blob();
    const text = await response.text();
    if (!text) return text;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
