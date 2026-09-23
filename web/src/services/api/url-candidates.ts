/**
 * 请求地址候选。
 *
 * 各家的 base 写法不一致：DeepSeek 官方不带 /v1、智谱把版本段放在路径中间
 * （/api/paas/v4/chat/completions）、方舟带 /api/v3，本地 Ollama 又带 /v1。
 * 与其要求用户填对，不如生成候选地址在运行时探测：
 * 任一侧已有版本段就只用单一地址，否则先试补 /v1 再回退原样。
 */

/** 形如 v1 / v3 / v4 的版本段。 */
export function isVersionSegment(segment: string) {
    return /^v\d+$/i.test(segment);
}

/** 与服务商约定的版本段拼接规则一致：base 或路径任一段带版本段时都不再补 /v1。 */
export function buildUrlCandidates(baseUrl: string, path: string): string[] {
    if (/^https?:/i.test(path)) return [path];
    const base = (baseUrl || "").trim().replace(/\/+$/, "");
    const rel = path.replace(/^\/+/, "");
    if (!base) return [`/${rel}`];
    const segments = rel.split("/");
    const hasVersion = isVersionSegment(base.split("/").pop() || "") || segments.some(isVersionSegment);
    if (hasVersion) return [`${base}/${rel}`];
    return [`${base}/v1/${rel}`, `${base}/${rel}`];
}

/**
 * 只有「路由不存在」才值得换下一个候选。
 * 401/403 是密钥问题、429 是限流，重试只会白白多打一次上游并可能触发风控。
 */
export function isRetryableStatus(status: number) {
    return status === 404 || status === 405 || status === 501;
}
