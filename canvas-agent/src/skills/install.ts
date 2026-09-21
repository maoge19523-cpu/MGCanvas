import matter from "gray-matter";

const MAX_SKILL_BYTES = 512 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/** 解析用户填写的 SKILL.md 链接，只接受 http/https。 */
export function skillSourceUrl(value: unknown) {
    const raw = String(value ?? "").trim();
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("请填写 SKILL.md 的完整链接（http 或 https 开头）");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http 或 https 链接");
    return url;
}

/**
 * 下载并解析远端 SKILL.md。
 * frontmatter 里的 name 缺失时用链接上一级目录名兜底：多数技能库的目录名就是技能名。
 */
export async function fetchSkillDocument(url: URL) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { Accept: "text/markdown, text/plain, */*" } });
        if (!response.ok) throw new Error(`下载 SKILL.md 失败（HTTP ${response.status}）`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > MAX_SKILL_BYTES) throw new Error("SKILL.md 超过 512KB，已拒绝安装");
        const document = matter(buffer.toString("utf8"));
        const description = String(document.data?.description ?? "").trim();
        if (!description) throw new Error("这个 SKILL.md 没有 description，无法判断什么时候该用它");
        const fallbackName = url.pathname.split("/").filter(Boolean).slice(-2)[0] || "";
        return { name: String(document.data?.name ?? "").trim() || fallbackName, description, instructions: document.content.trim() };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("下载 SKILL.md 超时，请检查链接是否可访问");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
