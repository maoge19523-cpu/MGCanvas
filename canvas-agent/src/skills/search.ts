const SEARCH_ENDPOINT = "https://skills.sh/api/search";
const TIMEOUT_MS = 20_000;

export type SkillSearchHit = { id: string; name: string; source: string; installs: number; pageUrl: string };

/**
 * 按关键词检索开放技能生态（skills.sh 的检索接口，实测可用）。
 * CLI 的 `skills find` 是交互式的，没有机器可读输出，所以这里直接读接口。
 */
export async function searchSkills(query: string): Promise<SkillSearchHit[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(keyword)}`, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "MGCanvas" } });
        if (!response.ok) throw new Error(`搜索技能失败（HTTP ${response.status}）`);
        const payload = (await response.json()) as { skills?: unknown };
        const list = Array.isArray(payload.skills) ? payload.skills : [];
        return list.flatMap((item) => {
            const record = (item || {}) as Record<string, unknown>;
            const source = String(record.source ?? "").trim();
            const name = String(record.skillId ?? record.name ?? "").trim();
            if (!source || !name) return [];
            return [{ id: String(record.id ?? `${source}/${name}`), name, source, installs: Number(record.installs) || 0, pageUrl: `https://skills.sh/${source}/${name}` }];
        });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("搜索技能超时，请检查网络");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 由搜索结果里的 source（owner/repo）与技能名解析出该技能 SKILL.md 的真实地址：
 * 检索只给包名，安装必须落到具体文件上。
 */
export async function resolveSkillDocumentUrl(source: string, name: string) {
    const repo = source.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("技能来源格式不正确，需要 owner/repo");
    const skill = name.trim();
    if (!skill) throw new Error("技能名为空，无法定位 SKILL.md");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, { signal: controller.signal, headers: { Accept: "application/vnd.github+json", "User-Agent": "MGCanvas" } });
        if (!response.ok) throw new Error(`读取技能仓库失败（HTTP ${response.status}）`);
        const payload = (await response.json()) as { tree?: { path?: string }[] };
        const candidates = (payload.tree || [])
            .map((entry) => String(entry.path || ""))
            .filter((path) => path.toLowerCase().endsWith("skill.md") && (path === "SKILL.md" || path.startsWith(`${skill}/`) || path.includes(`/${skill}/`)));
        const pick = candidates.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
        if (!pick) throw new Error("这个技能仓库里没有找到对应的 SKILL.md");
        return `https://raw.githubusercontent.com/${repo}/HEAD/${pick}`;
    } finally {
        clearTimeout(timer);
    }
}
