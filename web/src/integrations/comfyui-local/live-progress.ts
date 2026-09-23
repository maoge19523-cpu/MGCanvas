/**
 * ComfyUI 实时节点进度。
 *
 * ComfyUI 通过 WebSocket `/ws` 推送执行过程：`executing` 给出当前正在跑的节点 ID，
 * `progress` 给出该节点的步进进度。节点 ID 到可读名字的映射直接用工作流本身
 * （`materializeComfyWorkflow` 产出的对象就是 `{ 节点ID: { class_type, inputs } }`）。
 *
 * 设计取舍：走前端 WebSocket 而不是在原生侧再加一个 WebSocket 客户端，
 * 这样不需要新增 Rust 依赖，本地与云端也共用同一段逻辑（云端用 wss）。
 * 进度只是锦上添花，任何环节失败都不应该影响工作流本身，因此这里全程静默降级。
 */
export type ComfyLiveProgress = {
    nodeId?: string;
    /** 当前节点的类型名，取不到时回落到节点 ID */
    label?: string;
    /** 进度百分比，只有在收到 progress 消息后才有 */
    percent?: number;
};

type ComfyStatusLike = { port?: number | null; remoteBaseUrl?: string | null };

type WatchOptions = {
    status: ComfyStatusLike;
    /** 已物化的工作流：节点 ID → 节点定义 */
    workflow: Record<string, unknown>;
    onProgress: (progress: ComfyLiveProgress) => void;
};

function randomClientId() {
    const cryptoObject = globalThis.crypto as Crypto | undefined;
    if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 本地走 127.0.0.1 的端口，云端把 http(s) 换成 ws(s)。取不到地址时返回 null。 */
export function comfyWebSocketUrl(status: ComfyStatusLike): string | null {
    const remote = typeof status.remoteBaseUrl === "string" ? status.remoteBaseUrl.trim() : "";
    const suffix = `/ws?clientId=${randomClientId()}`;
    if (remote) return `${remote.replace(/^http/, "ws").replace(/\/+$/, "")}${suffix}`;
    if (typeof status.port === "number" && status.port > 0) return `ws://127.0.0.1:${status.port}${suffix}`;
    return null;
}

function classTypeOf(workflow: Record<string, unknown>, nodeId?: string) {
    if (!nodeId) return undefined;
    const node = workflow[nodeId];
    if (!node || typeof node !== "object") return undefined;
    const value = (node as { class_type?: unknown }).class_type;
    return typeof value === "string" && value ? value : undefined;
}

/**
 * 监听一次执行的进度，返回取消函数。
 * 环境不支持 WebSocket（例如单元测试）或地址不可用时返回一个空函数，不抛错。
 */
export function watchComfyProgress({ status, workflow, onProgress }: WatchOptions): () => void {
    if (typeof WebSocket === "undefined") return () => undefined;
    const url = comfyWebSocketUrl(status);
    if (!url) return () => undefined;

    let socket: WebSocket;
    try {
        socket = new WebSocket(url);
    } catch {
        return () => undefined;
    }

    // ComfyUI 会推送多种消息，只关心当前节点与步进进度，其余（如各类缓存消息）忽略。
    socket.onmessage = (event: MessageEvent) => {
        try {
            const message = typeof event.data === "string" ? JSON.parse(event.data) : null;
            if (!message || typeof message !== "object") return;
            const type = (message as { type?: unknown }).type;
            const data = (message as { data?: unknown }).data;
            if (!data || typeof data !== "object") return;
            const payload = data as { node?: unknown; value?: unknown; max?: unknown };
            if (type === "executing" && typeof payload.node === "string") {
                onProgress({ nodeId: payload.node, label: classTypeOf(workflow, payload.node) || payload.node });
                return;
            }
            if (type === "progress" && typeof payload.value === "number" && typeof payload.max === "number" && payload.max > 0) {
                onProgress({ percent: Math.min(100, Math.max(0, Math.round((payload.value / payload.max) * 100))) });
            }
        } catch {
            // 无法解析的消息直接忽略：进度不影响执行结果。
        }
    };
    socket.onerror = () => undefined;

    return () => {
        socket.onmessage = null;
        socket.onerror = null;
        try {
            socket.close();
        } catch {
            // 关闭失败无需处理。
        }
    };
}
