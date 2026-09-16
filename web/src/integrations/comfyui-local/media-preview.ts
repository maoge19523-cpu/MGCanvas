import { comfyNativeClient } from "./index";

/**
 * 组装已上传到 ComfyUI 输入目录的素材预览地址。
 *
 * 本地环境走 127.0.0.1，云端走代理地址，两者都用 ComfyUI 的 `/view` 接口读取。
 * 取不到环境时返回空字符串，调用方据此跳过预览。
 */
export async function comfyInputPreviewUrl(filename: string) {
    if (!filename) return "";
    try {
        const status = await comfyNativeClient.status();
        const base = status.remoteBaseUrl || (status.port ? `http://127.0.0.1:${status.port}` : "");
        if (!base) return "";
        return `${base.replace(/\/+$/, "")}/view?filename=${encodeURIComponent(filename)}&type=input`;
    } catch {
        return "";
    }
}
