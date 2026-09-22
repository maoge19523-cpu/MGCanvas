import fs from "node:fs/promises";
import path from "node:path";

export const MAX_MEMORY_ENTRY_CHARS = 2000;
export const MAX_MEMORY_ENTRIES = 50;
export const MAX_MEMORY_TOTAL_BYTES = 32 * 1024;

export type MemoryEntry = { id: string; text: string; createdAt: string; updatedAt: string };
export type MemoryState = { enabled: boolean; entries: MemoryEntry[] };

const EMPTY: MemoryState = { enabled: true, entries: [] };

/**
 * 工作区级本地记忆：纯本地读写，不进模型调用、不产生费用。
 * 「可控」体现在四项：能开关、能看见、能编辑、能清空。
 */
export class MemoryStore {
    readonly memoryPath: string;

    constructor(workspacePath: string) {
        this.memoryPath = path.join(path.resolve(workspacePath), ".agents", "memory.json");
    }

    async read(): Promise<MemoryState> {
        const raw = await fs.readFile(this.memoryPath, "utf8").catch(() => "");
        if (!raw.trim()) return { ...EMPTY };
        try {
            const parsed = JSON.parse(raw) as Partial<MemoryState>;
            return { enabled: parsed.enabled !== false, entries: normalizeEntries(parsed.entries) };
        } catch {
            return { ...EMPTY };
        }
    }

    /** 整体保存；超限直接报错，不做静默截断。 */
    async save(input: Partial<MemoryState>) {
        const state: MemoryState = { enabled: input?.enabled !== false, entries: normalizeEntries(input?.entries) };
        const payload = `${JSON.stringify(state, null, 2)}\n`;
        if (Buffer.byteLength(payload, "utf8") > MAX_MEMORY_TOTAL_BYTES) throw new Error("本地记忆总长度超过 32KB，请先精简或删除部分条目");
        await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });
        await fs.writeFile(this.memoryPath, payload, "utf8");
        return state;
    }

    /** 一键清空：只清条目，开关状态保留。 */
    async clear() {
        const current = await this.read();
        return this.save({ enabled: current.enabled, entries: [] });
    }

    /** 拼接给模型看的前缀；返回形状固定，停用或没有条目时 prefix 为空串。 */
    async promptPrefix(): Promise<{ prefix: string; dropped: number }> {
        const state = await this.read();
        if (!state.enabled || !state.entries.length) return { prefix: "", dropped: 0 };
        const parts: string[] = [];
        let used = 0;
        let dropped = 0;
        for (const entry of state.entries) {
            const cost = Buffer.byteLength(entry.text, "utf8") + 8;
            if (used + cost > MAX_MEMORY_TOTAL_BYTES) {
                dropped += 1;
                continue;
            }
            parts.push(`- ${entry.text}`);
            used += cost;
        }
        if (!parts.length) return { prefix: "", dropped };
        return { prefix: `【本地记忆】\n${parts.join("\n")}`, dropped };
    }
}

function normalizeEntries(input: unknown): MemoryEntry[] {
    if (!Array.isArray(input)) return [];
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const entries: MemoryEntry[] = [];
    for (const item of input) {
        const record = (item || {}) as Record<string, unknown>;
        const text = String(record.text ?? "").trim();
        if (!text) continue;
        if (text.length > MAX_MEMORY_ENTRY_CHARS) throw new Error(`单条本地记忆不能超过 ${MAX_MEMORY_ENTRY_CHARS} 字`);
        if (seen.has(text)) continue;
        seen.add(text);
        entries.push({
            id: String(record.id ?? "").trim() || `${Date.now().toString(36)}-${entries.length}`,
            text,
            createdAt: String(record.createdAt ?? "").trim() || now,
            updatedAt: String(record.updatedAt ?? "").trim() || now,
        });
        if (entries.length >= MAX_MEMORY_ENTRIES) throw new Error(`本地记忆最多 ${MAX_MEMORY_ENTRIES} 条`);
    }
    return entries;
}
