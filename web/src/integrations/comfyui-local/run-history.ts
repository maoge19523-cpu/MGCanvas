import localforage from "localforage";

/**
 * ComfyUI 工作流运行历史。
 *
 * 之前每次运行的成败只挂在画布节点上一次性的 `comfyuiRun` 上，切走或重跑后旧记录就没了，
 * 失败原因也无处回看。这里把每次运行落成一条记录（本地持久化，与工作流库同一个存储实例），
 * 供「ComfyUI 本地」页的运行历史区展示与回看结果。
 */
export type ComfyRunOutput = {
    outputId: string;
    itemIndex: number;
    label: string;
    resourceType: string;
    content?: string;
    localPath?: string;
    filename?: string;
    mimeType?: string;
};

export type ComfyRunRecord = {
    id: string;
    nodeId: string;
    workflowId: string;
    workflowName: string;
    environmentId: string;
    phase: "succeeded" | "failed" | "canceled";
    startedAt: number;
    completedAt: number;
    promptId?: string;
    errorDetails?: string;
    outputs: ComfyRunOutput[];
};

const STORE_NAME = "mgcanvas-comfyui-local";
const STORE_KEY = "run-history";
/** 只保留最近若干条：历史是排查用的，不需要无限增长。 */
const MAX_RECORDS = 50;

const store = localforage.createInstance({ name: STORE_NAME });

function isRecord(value: unknown): value is ComfyRunRecord {
    if (!value || typeof value !== "object") return false;
    const record = value as Partial<ComfyRunRecord>;
    return typeof record.id === "string" && typeof record.startedAt === "number" && Array.isArray(record.outputs);
}

/** 最新在前。 */
export async function listComfyRunRecords(): Promise<ComfyRunRecord[]> {
    const raw = await store.getItem<unknown>(STORE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecord).sort((left, right) => right.startedAt - left.startedAt);
}

export async function appendComfyRunRecord(record: ComfyRunRecord): Promise<void> {
    const existing = await listComfyRunRecords();
    const next = [record, ...existing.filter((item) => item.id !== record.id)].slice(0, MAX_RECORDS);
    await store.setItem(STORE_KEY, next);
}

export async function deleteComfyRunRecord(id: string): Promise<void> {
    const existing = await listComfyRunRecords();
    await store.setItem(
        STORE_KEY,
        existing.filter((item) => item.id !== id),
    );
}

export async function clearComfyRunRecords(): Promise<void> {
    await store.removeItem(STORE_KEY);
}

/** 记录一次运行；失败不影响执行流程本身，因此调用方不需要 await 它的异常。 */
export function recordComfyRun(record: Omit<ComfyRunRecord, "id">): void {
    const id = `${record.startedAt}-${record.nodeId}-${record.promptId || "local"}`;
    void appendComfyRunRecord({ ...record, id }).catch(() => undefined);
}
