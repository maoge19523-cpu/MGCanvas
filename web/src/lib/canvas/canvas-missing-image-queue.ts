import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const QUEUE_KEY = "mgcanvas:missing_image_queue:v1";

type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type MissingImageQueueEntry = {
    projectId: string;
    /** 本次队列要跑的节点，按顺序串行生成。 */
    nodeIds: string[];
    /** 本次跑失败的节点，用于「只重试失败项」。 */
    failedIds: string[];
    updatedAt: string;
};

/** 缺图节点：图片节点、还没有图、有提示词，且当前不在生成中。 */
export function collectMissingImageNodeIds(nodes: CanvasNodeData[]) {
    return nodes.filter((node) => node.type === CanvasNodeType.Image && !node.metadata?.content && Boolean(node.metadata?.prompt?.trim()) && node.metadata?.status !== "loading").map((node) => node.id);
}

/**
 * 重开项目时取回队列：与当前实际的缺图节点取交集。
 * 已成功的节点 metadata.content 非空，会自然出列，所以不需要另存「已完成 id」。
 */
export function restoreMissingImageQueue(projectId: string, nodes: CanvasNodeData[]) {
    const entry = readMissingImageQueue(projectId);
    if (!entry) return null;
    const missing = new Set(collectMissingImageNodeIds(nodes));
    const nodeIds = entry.nodeIds.filter((id) => missing.has(id));
    const failedIds = entry.failedIds.filter((id) => missing.has(id));
    return nodeIds.length || failedIds.length ? { nodeIds, failedIds } : null;
}

export function readMissingImageQueue(projectId: string, storage: QueueStorage | null = browserStorage()) {
    return readEntries(storage).find((entry) => entry.projectId === projectId) || null;
}

export function writeMissingImageQueue(entry: Omit<MissingImageQueueEntry, "updatedAt">, storage: QueueStorage | null = browserStorage()) {
    if (!storage) return;
    try {
        const next: MissingImageQueueEntry = { ...entry, updatedAt: new Date().toISOString() };
        writeEntries(
            storage,
            readEntries(storage)
                .filter((item) => item.projectId !== entry.projectId)
                .concat(next),
        );
    } catch {
        // 队列记录只是尽力而为，写不进去不能影响画布。
    }
}

export function clearMissingImageQueue(projectId: string, storage: QueueStorage | null = browserStorage()) {
    if (!storage) return;
    try {
        writeEntries(
            storage,
            readEntries(storage).filter((entry) => entry.projectId !== projectId),
        );
    } catch {
        // 同上。
    }
}

function browserStorage(): QueueStorage | null {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        return null;
    }
}

function readEntries(storage: QueueStorage | null): MissingImageQueueEntry[] {
    if (!storage) return [];
    try {
        const raw = storage.getItem(QUEUE_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        return Array.isArray(parsed) ? (parsed as MissingImageQueueEntry[]) : [];
    } catch {
        return [];
    }
}

function writeEntries(storage: QueueStorage, entries: MissingImageQueueEntry[]) {
    if (entries.length) storage.setItem(QUEUE_KEY, JSON.stringify(entries));
    else storage.removeItem(QUEUE_KEY);
}
